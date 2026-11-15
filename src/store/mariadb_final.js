// The final writes on MariaDB: lease renewal, complete, retry, fail, release, stall recovery, sweeps. Each write of a
// job checks its lock token: a process that lost the lease changes nothing. Each runs in a queue transaction. A copy of
// the MySQL version, changed where MariaDB differs: keep the two in step.
import { isTransientDbError } from '../transient_error.js';
import { createMonotonicUlid } from '../ulid.js';
import { insertJobsMariadb } from './mariadb_enqueue.js';

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').OwnedJob} OwnedJob */
/** @typedef {import('./store.js').FailureJobBuilder} FailureJobBuilder */
/** @typedef {import('./store.js').FailureJobResult} FailureJobResult */

const NOW = 'UTC_TIMESTAMP(3)';
// The writes by a list of keys force the index: on a small table, MariaDB scans the whole table instead, and waits for
// the rows that other processes hold. The DELETE of several rows uses the multi-table form, which takes hints.
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
            UPDATE ${p}jobs FORCE INDEX (PRIMARY) SET locked_until = ${NOW} + INTERVAL ? MICROSECOND
             WHERE id IN (${placeholders(ids.length)})
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
        UPDATE ${p}jobs FORCE INDEX (PRIMARY)
           SET status = 'completed', finished_at = ${NOW},
               expires_at = ${NOW} + INTERVAL completed_retention_ms * 1000 MICROSECOND, ${CLEAR_LOCK},
               updated_at = ${NOW}
         WHERE id IN (${placeholders(ids.length)}) AND (id, lock_token) IN (${jobs.map(() => '(?, ?)').join(', ')})
    `, [...ids, ...jobs.flatMap(job => [job.id, job.lockToken])]);

    if (changed) {
        await executor.run(`
            DELETE pl FROM ${p}payloads pl FORCE INDEX (PRIMARY) JOIN ${p}jobs j ON j.id = pl.id
             WHERE pl.id IN (${placeholders(ids.length)}) AND j.status = 'completed'
        `, ids);
    }

    const withKeys = jobs.filter(job => job.limits?.length);

    if (withKeys.length) {
        await executor.run(`
            DELETE s FROM ${p}concurrency_slots s FORCE INDEX (${p}concurrency_slots_job_id)
             WHERE s.job_id IN (${placeholders(withKeys.length)})
               AND (s.job_id, s.lock_token) IN (${withKeys.map(() => '(?, ?)').join(', ')})
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
        await insertJobsMariadb(executor, p, [newJob], token);

        return { added: newJob };
    } catch (insertError) {
        // A deadlock rolls back the whole transaction: the write runs again
        if (isTransientDbError(insertError)) {
            throw insertError;
        }

        // MariaDB rolls back only the failed statement: the job row can be there without its payload. No savepoint, as
        // on MySQL: some drivers send every statement as a prepared statement (Prisma).
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
               -- A subquery, not a join: MariaDB has no FOR UPDATE OF, so a join would lock the payload row too
               (SELECT CAST(pl.payload AS CHAR) FROM ${p}payloads pl WHERE pl.id = j.id) AS payload
          FROM ${p}jobs j
         WHERE ${where}
           FOR UPDATE
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
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<{ id: string, name: string }[]>} The running jobs whose lease ended, the oldest first.
 */
export async function findStaleJobs(executor, p, limit) {
    const rows = await executor.query(`
        SELECT id, job_name FROM ${p}jobs FORCE INDEX (${p}jobs_status_name_run_at)
         WHERE status = 'running' AND locked_until < ${NOW}
         ORDER BY locked_until LIMIT ?
    `, [limit]);

    return rows.map(row => ({ id: String(row.id), name: String(row.job_name) }));
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
        // run_at before stalls: MariaDB sets the columns from left to right
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
     * @returns {string}
     */
    const ofOldest = column => `(
        SELECT CAST(j.${column} AS CHAR) FROM ${p}jobs j FORCE INDEX (${p}jobs_blocked)
         WHERE j.status = 'blocked' AND j.blocked_on = f.limit_key ORDER BY j.run_at, j.id LIMIT 1
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
        UPDATE ${p}jobs FORCE INDEX (PRIMARY) SET status = 'pending', blocked_on = NULL, updated_at = ${NOW}
         WHERE id IN (${placeholders(picked.length)}) AND status = 'blocked'
    `, picked.map(row => String(row.id)));

    return [...new Set(picked.map(row => String(row.job_name)))];
}

/**
 * Deletes the ended lingers, and the slots without their running job (from a manual change, or old code). Then
 * unblocks the jobs blocked on keys with room: a release that ended in a linger, or a process that stopped before its
 * unblock.
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<{ lingers: number, orphans: number, unblocked: number }>}
 */
export async function sweepSlots(executor, p, limit) {
    const lingers = await executor.run(`DELETE FROM ${p}concurrency_slots WHERE held_until < ${NOW} LIMIT ?`, [limit]);
    const orphanSlots = await executor.query(`
        SELECT s.limit_key, s.slot FROM ${p}concurrency_slots s
         WHERE s.held_until IS NULL AND NOT EXISTS (
             SELECT 1 FROM ${p}jobs j WHERE j.id = s.job_id AND j.status = 'running' AND j.lock_token = s.lock_token
         )
         LIMIT ?
    `, [limit]);
    const orphans = orphanSlots.length
        ? await executor.run(`
            DELETE s FROM ${p}concurrency_slots s LEFT JOIN ${p}jobs j
                ON j.id = s.job_id AND j.status = 'running' AND j.lock_token = s.lock_token
             WHERE (s.limit_key, s.slot) IN (${orphanSlots.map(() => '(?, ?)').join(', ')})
               AND s.held_until IS NULL AND j.id IS NULL
        `, orphanSlots.flatMap(row => [String(row.limit_key), Number(row.slot)]))
        : 0;
    let unblocked = 0;

    // The keys with blocked jobs, a batch at a time: a loose index scan of the blocked jobs
    for (let after = ''; ;) {
        // oxlint-disable-next-line no-await-in-loop -- batches one after the other
        const keys = (await executor.query(`
            SELECT DISTINCT blocked_on FROM ${p}jobs FORCE INDEX (${p}jobs_blocked)
             WHERE status = 'blocked' AND blocked_on > ? ORDER BY blocked_on LIMIT ?
        `, [after, limit])).map(row => String(row.blocked_on));

        if (!keys.length) {
            break;
        }

        // oxlint-disable-next-line no-await-in-loop -- batches one after the other
        unblocked += (await unblock(executor, p, keys)).length;
        after = /** @type {string} */ (keys.at(-1));

        if (keys.length < limit) {
            break;
        }
    }

    return { lingers, orphans, unblocked };
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

    const deleted = await executor.run(
        `DELETE j FROM ${p}jobs j FORCE INDEX (PRIMARY) WHERE j.id IN (${placeholders(ids.length)})`,
        ids,
    );

    await executor.run(
        `DELETE pl FROM ${p}payloads pl FORCE INDEX (PRIMARY) WHERE pl.id IN (${placeholders(ids.length)})`,
        ids,
    );

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
 * The counts per job name, for alerts such as "queue stuck". Reads the status index only.
 * @param {Executor} executor
 * @param {string} p
 * @returns {Promise<import('../types.js').JobStats[]>}
 */
export async function getStats(executor, p) {
    const rows = await executor.query(`
        SELECT job_name,
               SUM(status IN ('pending', 'blocked')) AS pending,
               SUM(status = 'pending' AND run_at <= ${NOW}) AS due,
               SUM(status = 'running') AS running,
               SUM(status = 'running' AND timed_out_at IS NOT NULL) AS stuck,
               SUM(status = 'failed') AS failed,
               TIMESTAMPDIFF(MICROSECOND, MIN(IF(status = 'pending' AND run_at <= ${NOW}, run_at, NULL)), ${NOW})
                   DIV 1000 AS oldest_due_age_ms
          FROM ${p}jobs
         WHERE status IN ('pending', 'blocked', 'running', 'failed')
         GROUP BY job_name
         ORDER BY job_name
    `, []);

    return rows.map(row => ({
        name: String(row.job_name),
        pending: Number(row.pending),
        due: Number(row.due),
        running: Number(row.running),
        stuck: Number(row.stuck),
        failed: Number(row.failed),
        oldestDueAgeMs: row.oldest_due_age_ms === null ? null : Number(row.oldest_due_age_ms),
    }));
}
