// The final writes on MySQL: lease renewal, complete, retry, fail, release, stall recovery, sweeps. Each write of a
// job checks its lock token: a process that lost the lease changes nothing. Each runs in a queue transaction.
import {
    admitQueue, allowanceUs, incrementUs, nextUnblockMs, RATE_UNBLOCK_BATCH, toleranceUs, waitMsOf, waitUs as keyWaitUs,
} from '../gcra.js';
import { isRateKey } from '../rate_keys.js';
import { isTransientDbError } from '../transient_error.js';
import { createMonotonicUlid } from '../ulid.js';
import { insertJobsMysql } from './mysql_enqueue.js';
import { rateLimitsTable } from './mysql_worker.js';

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').OwnedJob} OwnedJob */
/** @typedef {import('./store.js').FailureJobBuilder} FailureJobBuilder */
/** @typedef {import('./store.js').FailureJobResult} FailureJobResult */

const NOW = 'UTC_TIMESTAMP(3)';
/** The clock of the rate keys: µs */
const NOW_US = 'UTC_TIMESTAMP(6)';
const HELD = `(s.held_until IS NULL OR s.held_until >= ${NOW})`;
const CLEAR_LOCK = 'lock_token = NULL, locked_by = NULL, locked_until = NULL, timed_out_at = NULL';
const enqueueToken = createMonotonicUlid();

/**
 * @param {number} count
 * @returns {string}
 */
function placeholders(count) {
    return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Renews the leases of the jobs that the process runs. A row locked by another transaction is skipped: it does not
 * block the others.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob[]} jobs
 * @param {number} leaseMs
 * @returns {Promise<Set<string>>} The ids whose lease was renewed.
 */
export async function renewLeases(executor, p, jobs, leaseMs) {
    if (!jobs.length) {
        return new Set();
    }

    const rows = await executor.query(`
        SELECT id FROM ${p}jobs FORCE INDEX (PRIMARY)
         WHERE id IN (${placeholders(jobs.length)}) AND (id, lock_token) IN (${jobs.map(() => '(?, ?)').join(', ')})
           AND status = 'running'
           FOR UPDATE SKIP LOCKED
    `, [...jobs.map(job => job.id), ...jobs.flatMap(job => [job.id, job.lockToken])]);
    const ids = rows.map(row => String(row.id));

    if (ids.length) {
        await executor.run(`
            UPDATE ${p}jobs SET locked_until = ${NOW} + INTERVAL ? MICROSECOND WHERE id IN (${placeholders(ids.length)})
        `, [leaseMs * 1000, ...ids]);
    }

    return new Set(ids);
}

/**
 * Marks a timeout: the job stays running until its handler settles (`stuck` in the stats).
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @returns {Promise<boolean>} False: the lease was lost.
 */
export async function markTimedOut(executor, p, job) {
    return await executor.run(`
        UPDATE ${p}jobs SET timed_out_at = ${NOW}, updated_at = ${NOW} WHERE id = ? AND lock_token = ?
    `, [job.id, job.lockToken]) > 0;
}

/**
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @returns {Promise<void>}
 */
async function deleteHolds(executor, p, job) {
    await executor.run(`DELETE FROM ${p}concurrency_slots WHERE job_id = ? AND lock_token = ?`, [job.id, job.lockToken]);
}

/**
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @param {number} lingerMs The slots stay held this long. 0: deleted.
 * @returns {Promise<void>}
 */
async function lingerHolds(executor, p, job, lingerMs) {
    if (lingerMs <= 0) {
        await deleteHolds(executor, p, job);

        return;
    }

    await executor.run(`
        UPDATE ${p}concurrency_slots SET held_until = ${NOW} + INTERVAL ? MICROSECOND
         WHERE job_id = ? AND lock_token = ? AND held_until IS NULL
    `, [lingerMs * 1000, job.id, job.lockToken]);
}

/**
 * The jobs are done: completed until their retention ends, without their payloads; their keys are freed. One
 * transaction for many jobs: one commit.
 * @param {Executor} executor
 * @param {string} p
 * @param {import('./store.js').FinishedJob[]} jobs
 * @returns {Promise<number>} The jobs that this call completed: the others lost their lease, or an earlier try
 *     committed.
 */
export async function completeJobs(executor, p, jobs) {
    const ids = jobs.map(job => job.id);
    // `id IN`: the range on the primary key; the pairs check the lock tokens
    const changed = await executor.run(`
        UPDATE ${p}jobs
           SET status = 'completed', attempts = attempts + 1, finished_at = ${NOW},
               expires_at = ${NOW} + INTERVAL completed_retention_ms * 1000 MICROSECOND, ${CLEAR_LOCK},
               updated_at = ${NOW}
         WHERE id IN (${placeholders(ids.length)}) AND (id, lock_token) IN (${jobs.map(() => '(?, ?)').join(', ')})
    `, [...ids, ...jobs.flatMap(job => [job.id, job.lockToken])]);

    if (changed) {
        await executor.run(`
            DELETE pl FROM ${p}payloads pl JOIN ${p}jobs j ON j.id = pl.id
             WHERE pl.id IN (${placeholders(ids.length)}) AND j.status = 'completed'
        `, ids);
    }

    const withKeys = jobs.filter(job => job.limits?.length);

    if (withKeys.length) {
        await executor.run(`
            DELETE FROM ${p}concurrency_slots
             WHERE job_id IN (${placeholders(withKeys.length)})
               AND (job_id, lock_token) IN (${withKeys.map(() => '(?, ?)').join(', ')})
        `, [...withKeys.map(job => job.id), ...withKeys.flatMap(job => [job.id, job.lockToken])]);
    }

    return changed;
}

/**
 * The attempt failed: pending again after the delay, one more attempt used; its slots are freed.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @param {{ delayMs: number, error: import('../error_json.js').ErrorJson }} params
 * @returns {Promise<boolean>} False: no change.
 */
export async function retryJob(executor, p, job, { delayMs, error }) {
    const changed = await executor.run(`
        UPDATE ${p}jobs
           SET status = 'pending', run_at = ${NOW} + INTERVAL ? MICROSECOND, attempts = attempts + 1, ${CLEAR_LOCK},
               last_error = ?, updated_at = ${NOW}
         WHERE id = ? AND lock_token = ?
    `, [delayMs * 1000, JSON.stringify(error), job.id, job.lockToken]);

    await deleteHolds(executor, p, job);

    return changed > 0;
}

/**
 * Adds the failure job of a job that this transaction failed, under a savepoint: if the database refuses it, the job
 * still fails, without it.
 * @param {Executor} executor
 * @param {string} p
 * @param {Record<string, unknown>} row The failed job, read in this transaction.
 * @param {{ error: import('../error_json.js').ErrorJson, buildFailureJob: FailureJobBuilder }} params
 * @returns {Promise<FailureJobResult>}
 */
async function addFailureJob(executor, p, row, { error, buildFailureJob }) {
    let newJob;

    try {
        newJob = buildFailureJob({
            id: String(row.id),
            name: String(row.job_name),
            payload: row.payload === null ? null : JSON.parse(String(row.payload)),
            attempt: Number(row.attempts) + 1,
            maxAttempts: Number(row.max_attempts),
            failureJob: String(row.failure_job),
            error,
        });
    } catch (buildError) {
        return { notAdded: buildError };
    }

    const token = enqueueToken();

    try {
        await insertJobsMysql(executor, p, [newJob], token);

        return { added: newJob };
    } catch (insertError) {
        // A deadlock rolls back the whole transaction: the write runs again
        if (isTransientDbError(insertError)) {
            throw insertError;
        }

        // MySQL rolls back only the failed statement: the job row can be there without its payload. No savepoint: some
        // drivers send every statement as a prepared statement (Prisma), and MySQL cannot prepare SAVEPOINT.
        await executor.run(`DELETE FROM ${p}jobs WHERE id = ? AND enqueue_token = ?`, [newJob.id, token]);

        return { notAdded: insertError };
    }
}

/**
 * @param {Executor} executor
 * @param {string} p
 * @param {string} where The condition of the row, on `j`.
 * @param {unknown[]} params
 * @returns {Promise<Record<string, unknown> | undefined>} The job and its payload, locked.
 */
async function lockJob(executor, p, where, params) {
    const [row] = await executor.query(`
        SELECT j.id, j.job_name, j.lock_token, j.attempts, j.max_attempts, j.stalls, j.max_stalls, j.failure_job,
               COALESCE(TIMESTAMPDIFF(MICROSECOND, j.started_at, ${NOW}) / 1000, 0) AS run_ms,
               CAST(pl.payload AS CHAR) AS payload
          FROM ${p}jobs j LEFT JOIN ${p}payloads pl ON pl.id = j.id
         WHERE ${where}
           FOR UPDATE OF j
    `, params);

    return row;
}

/**
 * The job fails for good: failed until its retention ends, with its payload; its slots are freed; its failure job is
 * added in the same transaction.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @param {{ error: import('../error_json.js').ErrorJson, buildFailureJob: FailureJobBuilder }} params
 * @returns {Promise<{ changed: boolean, failureJob: FailureJobResult | null }>}
 */
export async function failJob(executor, p, job, { error, buildFailureJob }) {
    const row = await lockJob(executor, p, 'j.id = ? AND j.lock_token = ?', [job.id, job.lockToken]);

    if (!row) {
        return { changed: false, failureJob: null };
    }

    await executor.run(`
        UPDATE ${p}jobs
           SET status = 'failed', attempts = attempts + 1, finished_at = ${NOW},
               expires_at = ${NOW} + INTERVAL failed_retention_ms * 1000 MICROSECOND, ${CLEAR_LOCK},
               last_error = ?, updated_at = ${NOW}
         WHERE id = ?
    `, [JSON.stringify(error), job.id]);
    await deleteHolds(executor, p, job);

    return {
        changed: true,
        failureJob: row.failure_job === null ? null : await addFailureJob(executor, p, row, { error, buildFailureJob }),
    };
}

/**
 * The job is released, without an attempt used: pending again after the delay.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @param {{ delayMs: number, lingerMs: number }} params lingerMs: its slots stay held this long (its handler still
 *     runs); 0: they are freed.
 * @returns {Promise<boolean>} False: no change.
 */
export async function releaseJob(executor, p, job, { delayMs, lingerMs }) {
    const changed = await executor.run(`
        UPDATE ${p}jobs
           SET status = 'pending', run_at = ${NOW} + INTERVAL ? MICROSECOND, ${CLEAR_LOCK}, updated_at = ${NOW}
         WHERE id = ? AND lock_token = ?
    `, [delayMs * 1000, job.id, job.lockToken]);

    await lingerHolds(executor, p, job, lingerMs);

    return changed > 0;
}

/**
 * The handler threw a RateLimitedError on rate keys of the job: the tat of each moves to `now + retryAfter + τ` at the
 * least (its next start at `now + retryAfter`, then one per per / max), by the settings of the job; a missing row is
 * created. The job is blocked on the first key, without an attempt used, and its slots are freed. The order of the
 * locks of a claim: the job, the rows of the keys in their order, then the slots.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @param {import('./store.js').RateLimitedParams} params
 * @returns {Promise<import('./store.js').RateLimitedResult>}
 */
export async function rateLimited(executor, p, job, { limits, retryAfterMs, error }) {
    const [owned] = await executor.query(`SELECT id FROM ${p}jobs WHERE id = ? AND lock_token = ? FOR UPDATE`, [
        job.id,
        job.lockToken,
    ]);

    if (!owned) {
        return { changed: false, delayMs: 0 };
    }

    const [first] = limits;

    // One row after the other, in the order of the keys
    await executor.run(`
        INSERT INTO ${p}rate_limits (limit_key, tat)
        VALUES ${limits.map(() => `(?, ${NOW_US} + INTERVAL ? MICROSECOND)`).join(', ')} AS new
        ON DUPLICATE KEY UPDATE tat = GREATEST(${p}rate_limits.tat, new.tat)
    `, limits.flatMap(limit => [limit.key, (retryAfterMs * 1000) + toleranceUs(limit)]));

    const [row] = await executor.query(`
        SELECT GREATEST(TIMESTAMPDIFF(MICROSECOND, ${NOW_US}, tat), 0) AS debt_us FROM ${p}rate_limits WHERE limit_key = ?
    `, [first.key]);

    await executor.run(`
        UPDATE ${p}jobs
           SET status = 'blocked', blocked_on = ?, ${CLEAR_LOCK}, last_error = ?, updated_at = ${NOW}
         WHERE id = ?
    `, [first.key, JSON.stringify(error), job.id]);
    await deleteHolds(executor, p, job);

    return { changed: true, delayMs: waitMsOf(keyWaitUs(Number(row.debt_us), first)) };
}

/**
 * The work of the stall recovery, in one read with no lock: the running jobs whose lease ended, the oldest first (a
 * row each, none: one row with null ids), and on each row whether there are ended lingers, orphan slots, blocked jobs
 * and rows of rate keys whose tat passed. So an idle recovery costs one statement: the parts with nothing to do do not
 * run. A part that the read misses (a row of a transaction that commits after it) runs at the next recovery.
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit Of the stale jobs.
 * @returns {Promise<readonly Record<string, unknown>[]>} id, job_name, and the parts: lingers, orphans, blocked,
 *     idle_rate_keys (0 or 1).
 */
export async function readRecoveryWork(executor, p, limit) {
    return executor.query(`
        SELECT stale.id, stale.job_name, parts.*
          FROM (
              SELECT EXISTS (SELECT 1 FROM ${p}concurrency_slots WHERE held_until < ${NOW}) AS lingers,
                     EXISTS (
                         SELECT 1 FROM ${p}concurrency_slots s
                          WHERE s.held_until IS NULL AND NOT EXISTS (
                              SELECT 1 FROM ${p}jobs j
                               WHERE j.id = s.job_id AND j.status = 'running' AND j.lock_token = s.lock_token
                          )
                     ) AS orphans,
                     EXISTS (SELECT 1 FROM ${p}jobs FORCE INDEX (${p}jobs_blocked) WHERE status = 'blocked') AS blocked,
                     EXISTS (SELECT 1 FROM ${p}rate_limits WHERE tat < ${NOW_US}) AS idle_rate_keys
          ) AS parts
          LEFT JOIN (
              SELECT id, job_name, locked_until FROM ${p}jobs FORCE INDEX (${p}jobs_status_name_run_at)
               WHERE status = 'running' AND locked_until < ${NOW}
               ORDER BY locked_until LIMIT ?
          ) AS stale ON TRUE
         ORDER BY stale.locked_until
    `, [limit]);
}

/**
 * The run that stalled, for the events.
 * @param {Record<string, unknown>} row Of lockJob().
 * @returns {{ attempt: number, runMs: number }} Its attempt (1 for the first run), and the time since it started.
 */
function stalledRun(row) {
    return { attempt: Number(row.attempts) + 1, runMs: Math.max(Math.round(Number(row.run_ms)), 0) };
}

/**
 * A running job whose lease ended: one more stall, pending again after 30 s × 2^stalls (at most 1 h); after maxStalls,
 * it fails for good. Its slots linger for one lease: its old handler may still run.
 * @param {Executor} executor
 * @param {string} p
 * @param {string} id
 * @param {{ leaseMs: number, buildFailureJob: FailureJobBuilder }} params
 * @returns {Promise<import('./store.js').StaleJobResult>} `result` null: not stale (any more).
 */
export async function recoverStaleJob(executor, p, id, { leaseMs, buildFailureJob }) {
    const row = await lockJob(executor, p, `j.id = ? AND j.status = 'running' AND j.locked_until < ${NOW}`, [id]);

    if (!row) {
        return { result: null, failureJob: null };
    }

    const owned = { id, lockToken: String(row.lock_token) };
    const error = { name: 'StalledError', message: 'The lease of the job ended: its process stopped or blocked' };
    const stalls = Number(row.stalls);

    await lingerHolds(executor, p, owned, leaseMs);

    if (stalls < Number(row.max_stalls)) {
        // run_at before stalls: MySQL sets the columns from left to right
        await executor.run(`
            UPDATE ${p}jobs
               SET status = 'pending',
                   run_at = ${NOW} + INTERVAL CAST(LEAST(30000000 * POW(2, stalls), 3600000000) AS UNSIGNED) MICROSECOND,
                   stalls = stalls + 1, ${CLEAR_LOCK}, last_error = ?, updated_at = ${NOW}
             WHERE id = ?
        `, [JSON.stringify(error), id]);

        return { result: 'released', failureJob: null, ...stalledRun(row) };
    }

    await executor.run(`
        UPDATE ${p}jobs
           SET status = 'failed', stalls = stalls + 1, finished_at = ${NOW},
               expires_at = ${NOW} + INTERVAL failed_retention_ms * 1000 MICROSECOND, ${CLEAR_LOCK},
               last_error = ?, updated_at = ${NOW}
         WHERE id = ?
    `, [JSON.stringify(error), id]);

    return {
        result: 'failed',
        failureJob: row.failure_job === null
            ? null
            : await addFailureJob(executor, p, row, { error, buildFailureJob }),
        ...stalledRun(row),
    };
}

/**
 * Makes the jobs blocked on the keys pending again, the oldest first: on each key, as many as it has room for, by the
 * max of its oldest blocked job. A read first; the writes in a transaction, only when a key has room.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} keys
 * @param {<T>(func: (executor: Executor) => Promise<T>) => Promise<T>} [inTransaction] Runs the writes. Default: on
 *     `executor`, which is in a transaction already.
 * @returns {Promise<string[]>} The names of the jobs that it made pending.
 */
export async function unblock(executor, p, keys, inTransaction = func => func(executor)) {
    // The oldest blocked job of each key: its keys and maxes; and the held slots of the key
    /**
     * @param {string} column
     * @returns {string} Ordered by the whole prefix of `jobs_blocked`: else MySQL 8.4 sorts every blocked job of the
     *     key.
     */
    const ofOldest = column => `(
        SELECT CAST(j.${column} AS CHAR) FROM ${p}jobs j FORCE INDEX (${p}jobs_blocked)
         WHERE j.status = 'blocked' AND j.blocked_on = f.limit_key ORDER BY j.status, j.blocked_on, j.run_at, j.id LIMIT 1
    )`;
    const heads = await executor.query(`
        SELECT h.limit_key, h.limit_keys, h.limit_maxes,
               (SELECT COUNT(*) FROM ${p}concurrency_slots s WHERE s.limit_key = h.limit_key AND ${HELD}) AS held
          FROM (
              SELECT f.limit_key, ${ofOldest('limit_keys')} AS limit_keys, ${ofOldest('limit_maxes')} AS limit_maxes
                FROM JSON_TABLE(?, '$[*]' COLUMNS (
                    limit_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PATH '$'
                )) AS f
          ) AS h
         WHERE h.limit_keys IS NOT NULL
    `, [JSON.stringify([...new Set(keys)])]);
    const rooms = heads.map((row) => {
        /** @type {string[]} */
        const limitKeys = JSON.parse(String(row.limit_keys));
        /** @type {number[]} */
        const maxes = JSON.parse(String(row.limit_maxes));
        const key = String(row.limit_key);

        return { key, room: maxes[limitKeys.indexOf(key)] - Number(row.held) };
    }).filter(({ room }) => room > 0);

    if (!rooms.length) {
        return [];
    }

    return inTransaction(transaction => unblockRooms(transaction, p, rooms));
}

/**
 * @param {Executor} executor In a transaction.
 * @param {string} p
 * @param {{ key: string, room: number }[]} rooms
 * @returns {Promise<string[]>} The names of the jobs that it made pending.
 */
async function unblockRooms(executor, p, rooms) {
    const picked = await executor.query(rooms.map(() => `(
        SELECT id, job_name FROM ${p}jobs FORCE INDEX (${p}jobs_blocked)
         WHERE status = 'blocked' AND blocked_on = ? ORDER BY run_at, id LIMIT ?
           FOR UPDATE SKIP LOCKED
    )`).join(' UNION ALL '), rooms.flatMap(({ key, room }) => [key, room]));

    if (!picked.length) {
        return [];
    }

    await executor.run(`
        UPDATE ${p}jobs SET status = 'pending', blocked_on = NULL, updated_at = ${NOW}
         WHERE id IN (${placeholders(picked.length)}) AND status = 'blocked'
    `, picked.map(row => String(row.id)));

    return [...new Set(picked.map(row => String(row.job_name)))];
}

/**
 * The settings of a rate key in a row of a blocked job.
 * @param {string} key
 * @param {Record<string, unknown>} row
 * @returns {import('../rate_keys.js').GlobalRateLimit}
 */
function rateLimitOf(key, row) {
    return {
        key,
        max: Number(row.max_starts),
        per_us: Number(row.per_us),
        burst: Number(row.burst),
        cost: Number(row.cost),
    };
}

/**
 * Makes the jobs blocked on the rate keys pending again, the oldest first: on each key, as many as its quota allows
 * now, each job by its own settings (gcra.js, `admitQueue`), at most RATE_UNBLOCK_BATCH. It does not take the quota:
 * the claim does, and blocks again a job that another one got ahead of. A read of the oldest blocked job of each key,
 * with the debt of the key: by its settings, `most` jobs fit. Then, only when a job may start, a transaction: the
 * `most + 1` oldest jobs of the key, locked, and the update of the prefix that fits. So the reads are as long as the
 * prefix, not as the queue. A job of other settings after the first `most` waits for the next unblock, at once, like
 * the one after a full batch.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} keys
 * @param {import('./postgres_final.js').RateUnblockOptions} [options]
 * @returns {Promise<{ names: string[], waits: import('./postgres_final.js').RateUnblock[] }>} The names of the jobs
 *     that it made pending; the keys on which it found blocked jobs.
 */
export async function unblockRates(executor, p, keys, options = {}) {
    const { inTransaction = func => func(executor), floors = new Map() } = options;
    const unique = [...new Set(keys)];
    const heads = (await executor.query(unique.map(() => `(
        SELECT j.blocked_on AS limit_key, e.max_starts, e.per_us, e.burst, e.cost,
               COALESCE((
                   SELECT GREATEST(TIMESTAMPDIFF(MICROSECOND, ${NOW_US}, r.tat), 0) FROM ${p}rate_limits r
                    WHERE r.limit_key = j.blocked_on
               ), 0) AS debt_us
          FROM ${p}jobs j FORCE INDEX (${p}jobs_blocked), ${rateLimitsTable('j.rate_limits')}
         WHERE j.status = 'blocked' AND j.blocked_on = ? AND e.limit_key = j.blocked_on
         ORDER BY j.run_at, j.id LIMIT 1
    )`).join(' UNION ALL '), unique)).map((row) => {
        const key = String(row.limit_key);
        const head = rateLimitOf(key, row);
        const debtUs = Math.max(Number(row.debt_us), floors.get(key) ?? 0);
        const fit = Math.floor((allowanceUs(head) - debtUs) / incrementUs(head));

        return { key, head, debtUs, most: Math.min(Math.max(fit, 0), RATE_UNBLOCK_BATCH) };
    });
    const open = heads.filter(({ most }) => most > 0);
    const { names, admissions } = open.length
        ? await inTransaction(transaction => admitLocked(transaction, p, open))
        : { names: [], admissions: new Map() };
    /** @type {import('./postgres_final.js').RateUnblock[]} */
    const waits = [];

    for (const { key, head, debtUs, most } of heads) {
        const admitted = most ? admissions.get(key) : admitQueue(debtUs, [head], 0);

        if (!admitted) {
            // Its jobs locked by another unblock, or no longer blocked: a check in a second
            waits.push({ key, delayMs: nextUnblockMs(0, false), unblocked: 0, debtUs: null, left: false });
            continue;
        }

        const { count, waitUs, left } = admitted;

        waits.push({
            key,
            delayMs: nextUnblockMs(waitUs ?? 0, left),
            unblocked: count,
            debtUs: count ? admitted.debtUs : null,
            left,
        });
    }

    return { names, waits };
}

/**
 * Locks the oldest blocked jobs of the keys, `most + 1` of each, and makes the prefix that fits pending.
 * @param {Executor} executor In a transaction.
 * @param {string} p
 * @param {{ key: string, debtUs: number, most: number }[]} keys
 * @returns {Promise<{ names: string[], admissions: Map<string, import('../gcra.js').RateAdmission> }>} The names of the
 *     jobs that it made pending; the admission of each key with jobs locked.
 */
async function admitLocked(executor, p, keys) {
    // OF j: MySQL does not lock the rows of a JSON_TABLE (ER_DUPLICATE_TABLE_LOCK)
    const rows = await executor.query(keys.map(() => `(
        SELECT j.blocked_on AS limit_key, j.id, j.job_name,
               TIMESTAMPDIFF(MICROSECOND, '1970-01-01', j.run_at) AS run_at_us,
               e.max_starts, e.per_us, e.burst, e.cost
          FROM ${p}jobs j FORCE INDEX (${p}jobs_blocked), ${rateLimitsTable('j.rate_limits')}
         WHERE j.status = 'blocked' AND j.blocked_on = ? AND e.limit_key = j.blocked_on
         ORDER BY j.run_at, j.id LIMIT ?
           FOR UPDATE OF j SKIP LOCKED
    )`).join(' UNION ALL '), keys.flatMap(({ key, most }) => [key, most + 1]));
    /** @type {Map<string, Record<string, unknown>[]>} */
    const queues = new Map();

    for (const row of rows.toSorted((a, b) => Number(a.run_at_us) - Number(b.run_at_us)
        || (String(a.id) < String(b.id) ? -1 : 1))) {
        const key = String(row.limit_key);
        const queue = queues.get(key) ?? [];

        queue.push(row);
        queues.set(key, queue);
    }

    /** @type {Map<string, import('../gcra.js').RateAdmission>} */
    const admissions = new Map();
    /** @type {Record<string, unknown>[]} */
    const picked = [];

    for (const { key, debtUs, most } of keys) {
        const queue = queues.get(key) ?? [];

        if (queue.length) {
            const admitted = admitQueue(debtUs, queue.map(row => rateLimitOf(key, row)), most);

            admissions.set(key, admitted);
            picked.push(...queue.slice(0, admitted.count));
        }
    }

    if (picked.length) {
        await executor.run(`
            UPDATE ${p}jobs SET status = 'pending', blocked_on = NULL, updated_at = ${NOW}
             WHERE id IN (${placeholders(picked.length)}) AND status = 'blocked'
        `, picked.map(row => String(row.id)));
    }

    return { names: [...new Set(picked.map(row => String(row.job_name)))], admissions };
}

/**
 * Deletes the ended lingers, and the slots without their running job (from a manual change, or old code). Then
 * unblocks the jobs blocked on keys with room: a release that ended in a linger, or a process that stopped before its
 * unblock; and the jobs blocked on rate keys whose next start is due: a process that stopped with its timer.
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @param {import('./store.js').SweepParts} parts The parts to run: those that the read of the recovery
 *     found work for (readRecoveryWork). A part left out counts 0.
 * @returns {Promise<import('./store.js').SweepResult>}
 */
export async function sweepSlots(executor, p, limit, parts) {
    // SKIP LOCKED, then by primary key: a DELETE that scans waits for the slots that claims and releases hold, while it
    // holds the lingers that it deleted, which they may wait for: a deadlock. A locked linger goes at the next sweep
    const ended = parts.lingers
        ? await executor.query(`
            SELECT limit_key, slot FROM ${p}concurrency_slots WHERE held_until < ${NOW}
             ORDER BY limit_key, slot LIMIT ? FOR UPDATE SKIP LOCKED
        `, [limit])
        : [];
    const lingers = ended.length
        ? await executor.run(`
            DELETE FROM ${p}concurrency_slots WHERE (limit_key, slot) IN (${ended.map(() => '(?, ?)').join(', ')})
        `, ended.flatMap(row => [String(row.limit_key), Number(row.slot)]))
        : 0;
    const orphanSlots = parts.orphans
        ? await executor.query(`
            SELECT s.limit_key, s.slot FROM ${p}concurrency_slots s
             WHERE s.held_until IS NULL AND NOT EXISTS (
                 SELECT 1 FROM ${p}jobs j
                  WHERE j.id = s.job_id AND j.status = 'running' AND j.lock_token = s.lock_token
             )
             LIMIT ?
        `, [limit])
        : [];
    const orphans = orphanSlots.length
        ? await executor.run(`
            DELETE s FROM ${p}concurrency_slots s LEFT JOIN ${p}jobs j
                ON j.id = s.job_id AND j.status = 'running' AND j.lock_token = s.lock_token
             WHERE (s.limit_key, s.slot) IN (${orphanSlots.map(() => '(?, ?)').join(', ')})
               AND s.held_until IS NULL AND j.id IS NULL
        `, orphanSlots.flatMap(row => [String(row.limit_key), Number(row.slot)]))
        : 0;
    let unblocked = 0;
    /** @type {import('../gcra.js').RateWait[]} */
    const rateWaits = [];

    if (!parts.blocked) {
        return { lingers, orphans, unblocked, rateWaits };
    }

    // The keys with blocked jobs, a batch at a time: a loose index scan of the blocked jobs
    for (let after = ''; ;) {
        // oxlint-disable-next-line no-await-in-loop -- batches one after the other
        const keys = (await executor.query(`
            SELECT blocked_on FROM ${p}jobs FORCE INDEX (${p}jobs_blocked)
             WHERE status = 'blocked' AND blocked_on > ?
             GROUP BY status, blocked_on ORDER BY status, blocked_on LIMIT ?
        `, [after, limit])).map(row => String(row.blocked_on));

        if (!keys.length) {
            break;
        }

        const rateKeys = keys.filter(isRateKey);
        const slotKeys = keys.filter(key => !isRateKey(key));

        // oxlint-disable-next-line no-await-in-loop -- batches one after the other
        unblocked += slotKeys.length ? (await unblock(executor, p, slotKeys)).length : 0;

        if (rateKeys.length) {
            // oxlint-disable-next-line no-await-in-loop -- batches one after the other
            const rates = await unblockRates(executor, p, rateKeys);

            unblocked += rates.names.length;
            // A key whose due jobs were still blocked lost its timer: its next unblock is here (`nextUnblockMs`)
            rateWaits.push(...rates.waits.filter(wait => wait.unblocked > 0)
                .map(({ key, delayMs }) => ({ key, delayMs })));
        }

        after = /** @type {string} */ (keys.at(-1));

        if (keys.length < limit) {
            break;
        }
    }

    return { lingers, orphans, unblocked, rateWaits };
}

/**
 * Deletes a batch of rows of rate keys whose tat passed: such a key has its full quota, as without a row. SKIP LOCKED:
 * a claim holds the rows of its keys.
 * @param {Executor} executor In a transaction.
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<number>} The deleted rows.
 */
export async function deleteIdleRateKeys(executor, p, limit) {
    const keys = (await executor.query(`
        SELECT limit_key FROM ${p}rate_limits WHERE tat < ${NOW_US} LIMIT ? FOR UPDATE SKIP LOCKED
    `, [limit])).map(row => String(row.limit_key));

    if (!keys.length) {
        return 0;
    }

    return executor.run(`DELETE FROM ${p}rate_limits WHERE limit_key IN (${placeholders(keys.length)})`, keys);
}

/**
 * Deletes a batch of completed and failed jobs whose retention ended, with their payloads. SKIP LOCKED: processes
 * share the work.
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<number>} The deleted jobs.
 */
export async function deleteExpiredJobs(executor, p, limit) {
    const ids = (await executor.query(`
        SELECT id FROM ${p}jobs FORCE INDEX (${p}jobs_expires_at)
         WHERE expires_at < ${NOW} ORDER BY expires_at LIMIT ?
           FOR UPDATE SKIP LOCKED
    `, [limit])).map(row => String(row.id));

    if (!ids.length) {
        return 0;
    }

    const deleted = await executor.run(`DELETE FROM ${p}jobs WHERE id IN (${placeholders(ids.length)})`, ids);

    await executor.run(`DELETE FROM ${p}payloads WHERE id IN (${placeholders(ids.length)})`, ids);

    return deleted;
}

/**
 * For drain({ includeDelayed }): the pending jobs of the names are due now.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} names
 * @returns {Promise<void>}
 */
export async function makeDue(executor, p, names) {
    if (!names.length) {
        return;
    }

    await executor.run(`
        UPDATE ${p}jobs SET run_at = ${NOW}
         WHERE status = 'pending' AND job_name IN (${placeholders(names.length)}) AND run_at > ${NOW}
    `, names);
}

/**
 * The counts per job name, for alerts such as "queue stuck". One statement, so one snapshot: the jobs that wait, run or
 * failed, from their rows; the completed jobs in a branch of their own, which reads only the index
 * `jobs_status_name_run_at`.
 * @param {Executor} executor
 * @param {string} p
 * @returns {Promise<import('../types.js').JobStats[]>}
 */
export async function getStats(executor, p) {
    const rows = await executor.query(`
        SELECT job_name,
               SUM(pending) AS pending,
               SUM(blocked) AS blocked,
               SUM(due) AS due,
               SUM(running) AS running,
               SUM(stuck) AS stuck,
               SUM(failed) AS failed,
               SUM(completed) AS completed,
               MIN(oldest) AS oldest_due_age_ms
          FROM (SELECT job_name,
                       SUM(status = 'pending') AS pending,
                       SUM(status = 'blocked') AS blocked,
                       SUM(status = 'pending' AND run_at <= ${NOW}) AS due,
                       SUM(status = 'running') AS running,
                       SUM(status = 'running' AND timed_out_at IS NOT NULL) AS stuck,
                       SUM(status = 'failed') AS failed,
                       0 AS completed,
                       TIMESTAMPDIFF(MICROSECOND, MIN(IF(status = 'pending' AND run_at <= ${NOW}, run_at, NULL)),
                           ${NOW}) DIV 1000 AS oldest
                  FROM ${p}jobs
                 WHERE status IN ('pending', 'blocked', 'running', 'failed')
                 GROUP BY job_name
                UNION ALL
                SELECT job_name, 0, 0, 0, 0, 0, 0, COUNT(*), NULL
                  FROM ${p}jobs
                 WHERE status = 'completed'
                 GROUP BY job_name) counts
         GROUP BY job_name
         ORDER BY job_name
    `, []);

    return rows.map(row => ({
        name: String(row.job_name),
        pending: Number(row.pending),
        blocked: Number(row.blocked),
        due: Number(row.due),
        running: Number(row.running),
        stuck: Number(row.stuck),
        failed: Number(row.failed),
        completed: Number(row.completed),
        oldestDueAgeMs: row.oldest_due_age_ms === null ? null : Number(row.oldest_due_age_ms),
    }));
}
