// The final writes on PostgreSQL: lease renewal, complete, retry, fail, release, stall recovery, sweeps. Each write of
// a job checks its lock token: a process that lost the lease changes nothing. Completion is one atomic statement;
// multi-statement writes run in a queue transaction.
import { nextUnblockMs, RATE_UNBLOCK_BATCH, toleranceUs, waitMsOf, waitUs as keyWaitUs } from '../gcra.js';
import { isRateKey } from '../rate_keys.js';
import { createMonotonicUlid } from '../ulid.js';
import { insertJobsPostgres } from './postgres_enqueue.js';
import { arrayParam, rateLimitsOf } from './postgres_worker.js';

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').OwnedJob} OwnedJob */
/** @typedef {import('./store.js').FailureJobBuilder} FailureJobBuilder */
/** @typedef {import('./store.js').FailureJobResult} FailureJobResult */

const NOW = 'clock_timestamp()';
/**
 * A due time from now, truncated to the ms of the column: timestamptz(3) rounds, and a rounded-up time is not due.
 * @param {string} offset An interval.
 * @returns {string}
 */
const runAt = offset => `date_trunc('milliseconds', ${NOW} + ${offset})`;
const MS = 'interval \'1 millisecond\'';
const CLEAR_LOCK = 'lock_token = NULL, locked_by = NULL, locked_until = NULL, timed_out_at = NULL';
const HELD = `(s.held_until IS NULL OR s.held_until >= ${NOW})`;
/**
 * @param {string} tat
 * @returns {string} The debt of a rate key in µs (gcra.js).
 */
const debtUs = tat => `GREATEST((EXTRACT(EPOCH FROM ${tat} - ${NOW}) * 1000000)::bigint, 0)`;
const enqueueToken = createMonotonicUlid();

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
        WITH locked AS (
            SELECT j.id FROM ${p}jobs j
              JOIN unnest(${arrayParam(1, 'text')}, ${arrayParam(2, 'text')}) AS own(id, lock_token)
                ON own.id = j.id AND own.lock_token = j.lock_token
             WHERE j.status = 'running'
               FOR UPDATE OF j SKIP LOCKED
        )
        UPDATE ${p}jobs j SET locked_until = ${NOW} + $3 * ${MS} FROM locked WHERE j.id = locked.id
        RETURNING j.id
    `, [jobs.map(job => job.id), jobs.map(job => job.lockToken), leaseMs]);

    return new Set(rows.map(row => String(row.id)));
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
        UPDATE ${p}jobs SET timed_out_at = ${NOW}, updated_at = ${NOW} WHERE id = $1 AND lock_token = $2
    `, [job.id, job.lockToken]) > 0;
}

/**
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @returns {Promise<void>}
 */
async function deleteHolds(executor, p, job) {
    await executor.run(`DELETE FROM ${p}concurrency_slots WHERE job_id = $1 AND lock_token = $2`, [
        job.id,
        job.lockToken,
    ]);
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
        UPDATE ${p}concurrency_slots SET held_until = ${NOW} + $3 * ${MS}
         WHERE job_id = $1 AND lock_token = $2 AND held_until IS NULL
    `, [job.id, job.lockToken, lingerMs]);
}

/**
 * One job is done, as `completeJobs`. Scalar parameters: PostgreSQL caches a generic plan of the prepared statement,
 * and plans it no more.
 * @param {Executor} executor
 * @param {string} p
 * @param {import('./store.js').FinishedJob} job
 * @returns {Promise<number>}
 */
async function completeJob(executor, p, job) {
    const [row] = await executor.query(`
        WITH done AS (
            UPDATE ${p}jobs
               SET status = 'completed', finished_at = ${NOW}, expires_at = ${NOW} + completed_retention_ms * ${MS},
                   ${CLEAR_LOCK}, updated_at = ${NOW}
             WHERE id = $1 AND lock_token = $2
            RETURNING id
        ),
        payloads AS (
            DELETE FROM ${p}payloads WHERE id = $1 AND EXISTS (SELECT FROM done)
        ),
        holds AS (
            DELETE FROM ${p}concurrency_slots WHERE job_id = $1 AND lock_token = $2
        )
        SELECT count(*)::integer AS changed FROM done
    `, [job.id, job.lockToken]);

    return Number(row?.changed ?? 0);
}

/**
 * The jobs are done: completed until their retention ends, without their payloads; their slots are freed. One
 * statement for many jobs.
 * @param {Executor} executor
 * @param {string} p
 * @param {import('./store.js').FinishedJob[]} jobs
 * @returns {Promise<number>} The jobs that this call completed: the others lost their lease, or an earlier try
 *     committed.
 */
export async function completeJobs(executor, p, jobs) {
    if (jobs.length === 1) {
        return completeJob(executor, p, jobs[0]);
    }

    const [row] = await executor.query(`
        WITH owned AS (
            SELECT * FROM unnest(${arrayParam(1, 'text')}, ${arrayParam(2, 'text')}) AS o(id, lock_token)
        ),
        done AS (
            UPDATE ${p}jobs j
               SET status = 'completed', finished_at = ${NOW}, expires_at = ${NOW} + completed_retention_ms * ${MS},
                   ${CLEAR_LOCK}, updated_at = ${NOW}
              FROM owned
             WHERE j.id = owned.id AND j.lock_token = owned.lock_token
            RETURNING j.id
        ),
        payloads AS (
            DELETE FROM ${p}payloads WHERE id IN (SELECT id FROM done)
        ),
        holds AS (
            DELETE FROM ${p}concurrency_slots s USING owned WHERE s.job_id = owned.id AND s.lock_token = owned.lock_token
        )
        SELECT count(*)::integer AS changed FROM done
    `, [jobs.map(job => job.id), jobs.map(job => job.lockToken)]);

    return Number(row?.changed ?? 0);
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
           SET status = 'pending', run_at = ${runAt(`$3 * ${MS}`)}, attempts = attempts + 1, ${CLEAR_LOCK},
               last_error = $4::text::jsonb, updated_at = ${NOW}
         WHERE id = $1 AND lock_token = $2
    `, [job.id, job.lockToken, delayMs, JSON.stringify(error)]);

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

    await executor.run('SAVEPOINT sqlane_failure_job', []);

    try {
        await insertJobsPostgres(executor, p, [newJob], { enqueueToken: enqueueToken() });
        await executor.run('RELEASE SAVEPOINT sqlane_failure_job', []);

        return { added: newJob };
    } catch (insertError) {
        await executor.run('ROLLBACK TO SAVEPOINT sqlane_failure_job', []);

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
               COALESCE(extract(epoch FROM ${NOW} - j.started_at) * 1000, 0)::float8 AS run_ms,
               pl.payload::text AS payload
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
    const row = await lockJob(executor, p, 'j.id = $1 AND j.lock_token = $2', [job.id, job.lockToken]);

    if (!row) {
        return { changed: false, failureJob: null };
    }

    await executor.run(`
        UPDATE ${p}jobs
           SET status = 'failed', attempts = attempts + 1, finished_at = ${NOW},
               expires_at = ${NOW} + failed_retention_ms * ${MS}, ${CLEAR_LOCK}, last_error = $2::text::jsonb,
               updated_at = ${NOW}
         WHERE id = $1
    `, [job.id, JSON.stringify(error)]);
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
        UPDATE ${p}jobs SET status = 'pending', run_at = ${runAt(`$3 * ${MS}`)}, ${CLEAR_LOCK}, updated_at = ${NOW}
         WHERE id = $1 AND lock_token = $2
    `, [job.id, job.lockToken, delayMs]);

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
    const [owned] = await executor.query(`SELECT id FROM ${p}jobs WHERE id = $1 AND lock_token = $2 FOR UPDATE`, [
        job.id,
        job.lockToken,
    ]);

    if (!owned) {
        return { changed: false, delayMs: 0 };
    }

    const [first] = limits;
    const [row] = await executor.query(`
        WITH pushed AS (
            INSERT INTO ${p}rate_limits AS r (limit_key, tat)
            SELECT k.limit_key, ${NOW} + k.ahead_us * interval '1 microsecond'
              FROM unnest(${arrayParam(1, 'text')}, ${arrayParam(2, 'bigint')})
                   WITH ORDINALITY AS k(limit_key, ahead_us, position)
             ORDER BY k.position
            ON CONFLICT (limit_key) DO UPDATE SET tat = GREATEST(r.tat, EXCLUDED.tat)
            RETURNING r.limit_key, r.tat
        )
        SELECT ${debtUs('tat')} AS debt_us FROM pushed WHERE limit_key = $3
    `, [limits.map(limit => limit.key), limits.map(limit => (retryAfterMs * 1000) + toleranceUs(limit)), first.key]);

    await executor.run(`
        UPDATE ${p}jobs
           SET status = 'blocked', blocked_on = $2, ${CLEAR_LOCK}, last_error = $3::text::jsonb, updated_at = ${NOW}
         WHERE id = $1
    `, [job.id, first.key, JSON.stringify(error)]);
    await deleteHolds(executor, p, job);

    return { changed: true, delayMs: waitMsOf(keyWaitUs(Number(row.debt_us), first)) };
}

/**
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<{ id: string, name: string }[]>} The running jobs whose lease ended, the oldest first.
 */
export async function findStaleJobs(executor, p, limit) {
    const rows = await executor.query(`
        SELECT id, job_name FROM ${p}jobs
         WHERE status = 'running' AND locked_until < ${NOW}
         ORDER BY locked_until LIMIT $1
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
    const row = await lockJob(executor, p, `j.id = $1 AND j.status = 'running' AND j.locked_until < ${NOW}`, [id]);

    if (!row) {
        return { result: null, failureJob: null };
    }

    const error = { name: 'StalledError', message: 'The lease of the job ended: its process stopped or blocked' };

    await lingerHolds(executor, p, { id, lockToken: String(row.lock_token) }, leaseMs);

    if (Number(row.stalls) < Number(row.max_stalls)) {
        await executor.run(`
            UPDATE ${p}jobs
               SET status = 'pending', run_at = ${runAt(`LEAST(30000 * power(2, stalls), 3600000) * ${MS}`)},
                   stalls = stalls + 1, ${CLEAR_LOCK}, last_error = $2::text::jsonb, updated_at = ${NOW}
             WHERE id = $1
        `, [id, JSON.stringify(error)]);

        return { result: 'released', failureJob: null, ...stalledRun(row) };
    }

    await executor.run(`
        UPDATE ${p}jobs
           SET status = 'failed', stalls = stalls + 1, finished_at = ${NOW},
               expires_at = ${NOW} + failed_retention_ms * ${MS}, ${CLEAR_LOCK}, last_error = $2::text::jsonb,
               updated_at = ${NOW}
         WHERE id = $1
    `, [id, JSON.stringify(error)]);

    return {
        result: 'failed',
        failureJob: row.failure_job === null ? null : await addFailureJob(executor, p, row, { error, buildFailureJob }),
        ...stalledRun(row),
    };
}

/**
 * Makes the jobs blocked on the keys pending again, the oldest first: on each key, as many as it has room for, by the
 * max of its oldest blocked job. One statement.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} keys
 * @returns {Promise<string[]>} The names of the jobs that it made pending.
 */
export async function unblock(executor, p, keys) {
    const rows = await executor.query(`
        WITH k AS (
            SELECT DISTINCT unnest(${arrayParam(1, 'text')}) AS limit_key
        ),
        room AS (
            SELECT k.limit_key,
                   head.max - (SELECT count(*) FROM ${p}concurrency_slots s WHERE s.limit_key = k.limit_key AND ${HELD})
                       AS room
              FROM k
             CROSS JOIN LATERAL (
                 SELECT j.limit_maxes[array_position(j.limit_keys, k.limit_key)] AS max FROM ${p}jobs j
                  WHERE j.status = 'blocked' AND j.blocked_on = k.limit_key
                  ORDER BY j.run_at, j.id LIMIT 1
             ) AS head
        ),
        picked AS (
            SELECT b.id FROM room
             CROSS JOIN LATERAL (
                 SELECT j.id FROM ${p}jobs j
                  WHERE j.status = 'blocked' AND j.blocked_on = room.limit_key
                  ORDER BY j.run_at, j.id LIMIT GREATEST(room.room, 0)
                    FOR UPDATE SKIP LOCKED
             ) AS b
        ),
        unblocked AS (
            UPDATE ${p}jobs j SET status = 'pending', blocked_on = NULL, updated_at = ${NOW}
              FROM picked WHERE j.id = picked.id
            RETURNING j.job_name
        )
        SELECT DISTINCT job_name FROM unblocked
    `, [keys]);

    return rows.map(row => String(row.job_name));
}

/**
 * A rate key after an unblock that found blocked jobs on it: when the next unblock is due (`nextUnblockMs`), the jobs
 * that the unblock made pending, the debt of the key after them (null: none), and whether blocked jobs are left (else
 * the next unblock is a check).
 * @typedef {import('../gcra.js').RateWait & { unblocked: number, debtUs: number | null, left: boolean }} RateUnblock
 */

/**
 * @typedef {object} RateUnblockOptions
 * @property {<T>(func: (executor: Executor) => Promise<T>) => Promise<T>} [inTransaction] MySQL and MariaDB: runs the
 *     writes, after the read.
 * @property {Map<string, number>} [floors] The least debt of some keys (µs): the jobs that an earlier unblock made
 *     pending, not claimed yet.
 */

/**
 * Makes the jobs blocked on the rate keys pending again, the oldest first: on each key, as many as its quota allows
 * now, each job by its own settings (gcra.js, `admitQueue`), at most RATE_UNBLOCK_BATCH. It does not take the quota:
 * the claim does, and blocks again a job that another one got ahead of. One statement.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} keys
 * @param {RateUnblockOptions} [options]
 * @returns {Promise<{ names: string[], waits: RateUnblock[] }>} The names of the jobs that it made pending; the keys
 *     on which it found blocked jobs.
 */
export async function unblockRates(executor, p, keys, { floors = new Map() } = {}) {
    const [row] = await executor.query(`
        WITH k AS (
            SELECT DISTINCT unnest(${arrayParam(1, 'text')}) AS limit_key
        ),
        debt AS (
            SELECT k.limit_key,
                   GREATEST(
                       COALESCE((SELECT ${debtUs('r.tat')} FROM ${p}rate_limits r WHERE r.limit_key = k.limit_key), 0),
                       COALESCE(f.debt, 0)
                   ) AS debt
              FROM k
              LEFT JOIN unnest(${arrayParam(2, 'text')}, ${arrayParam(3, 'bigint')}) AS f(limit_key, debt)
                ON f.limit_key = k.limit_key
        ),
        -- Of each key with blocked jobs, the oldest one, not locked: how many fit by its settings (lim)
        heads AS (
            SELECT debt.limit_key, debt.debt, head.inc, head.allow,
                   LEAST(GREATEST((head.allow - debt.debt) / head.inc, 0), ${RATE_UNBLOCK_BATCH}) AS lim
              FROM debt
             CROSS JOIN LATERAL (
                 SELECT e.inc, e.allow FROM ${p}jobs j
                  CROSS JOIN LATERAL ${rateLimitsOf('j.rate_limits')}
                  WHERE j.status = 'blocked' AND j.blocked_on = debt.limit_key AND e.key = debt.limit_key
                  ORDER BY j.run_at, j.id LIMIT 1
             ) AS head
        ),
        -- Of each key whose oldest job fits, the oldest blocked jobs: lim, and one more. So the read is as long as the
        -- prefix, not as the queue: a key that admits one job reads two, not a batch; one that admits none, none
        queue AS (
            SELECT heads.limit_key, heads.debt, heads.lim, b.id, b.run_at, b.rate_limits FROM heads
             CROSS JOIN LATERAL (
                 SELECT j.id, j.run_at, j.rate_limits FROM ${p}jobs j
                  WHERE heads.lim > 0 AND j.status = 'blocked' AND j.blocked_on = heads.limit_key
                  ORDER BY j.run_at, j.id LIMIT heads.lim + 1
                    FOR UPDATE SKIP LOCKED
             ) AS b
        ),
        need AS (
            SELECT queue.limit_key, queue.id, queue.run_at, queue.lim, e.inc, e.allow,
                   queue.debt + SUM(e.inc) OVER (PARTITION BY queue.limit_key ORDER BY queue.run_at, queue.id) AS need,
                   ROW_NUMBER() OVER (PARTITION BY queue.limit_key ORDER BY queue.run_at, queue.id) AS n
              FROM queue
             CROSS JOIN LATERAL ${rateLimitsOf('queue.rate_limits')}
             WHERE e.key = queue.limit_key
        ),
        -- A prefix of each queue: up to the first job that does not fit, or the one after the read's bound (a job of
        -- other settings may fit there: it waits for the next unblock, at once, like the one after a full batch)
        marked AS (
            SELECT need.*,
                   bool_or(need.need > need.allow OR need.n > need.lim)
                       OVER (PARTITION BY need.limit_key ORDER BY need.run_at, need.id) AS held_back
              FROM need
        ),
        unblocked AS (
            UPDATE ${p}jobs j SET status = 'pending', blocked_on = NULL, updated_at = ${NOW}
              FROM marked WHERE j.id = marked.id AND NOT marked.held_back
            RETURNING j.job_name, marked.limit_key
        ),
        -- Of each key, the first job held back: its wait after the prefix; else the last one of the prefix: the wait of a
        -- job like it after the prefix (admitQueue). The debt after the prefix: the need of its last job (null: none)
        waits AS (
            (
                SELECT DISTINCT ON (limit_key) limit_key, held_back AS left_over,
                       GREATEST(CASE WHEN held_back THEN need - allow ELSE need + inc - allow END, 0) AS wait_us,
                       CASE WHEN NOT held_back THEN need WHEN n > 1 THEN need - inc END AS debt_us
                  FROM marked
                 ORDER BY limit_key, held_back DESC, CASE WHEN held_back THEN n ELSE -n END
            )
            UNION ALL
            -- A key whose oldest job does not fit: its wait, though a job after it, past a lock, would fit (a key that
            -- admits none reads none). Else every blocked job locked by another unblock, or no longer blocked: a check
            -- in a second (left: false)
            SELECT heads.limit_key, heads.lim = 0, GREATEST(heads.debt + heads.inc - heads.allow, 0), NULL::bigint
              FROM heads
             WHERE NOT EXISTS (SELECT FROM queue WHERE queue.limit_key = heads.limit_key)
        ),
        counts AS (
            SELECT limit_key, count(*) AS unblocked FROM unblocked GROUP BY limit_key
        )
        SELECT (SELECT json_agg(DISTINCT job_name) FROM unblocked)::text AS names,
               (
                   SELECT json_agg(json_build_object(
                       'key', w.limit_key, 'waitUs', w.wait_us, 'left', w.left_over,
                       'unblocked', COALESCE(c.unblocked, 0), 'debtUs', w.debt_us
                   ))
                     FROM waits w
                     LEFT JOIN counts c ON c.limit_key = w.limit_key
               )::text AS waits
    `, [keys, [...floors.keys()], [...floors.values()].map(Math.round)]);
    /** @type {{ key: string, waitUs: number, left: boolean, unblocked: number, debtUs: number | null }[]} */
    const waits = (row?.waits ?? null) === null ? [] : JSON.parse(String(row?.waits));

    return {
        names: (row?.names ?? null) === null ? [] : JSON.parse(String(row?.names)),
        waits: waits.map(wait => ({
            key: wait.key,
            delayMs: nextUnblockMs(Number(wait.waitUs), wait.left),
            unblocked: Number(wait.unblocked),
            debtUs: wait.debtUs === null ? null : Number(wait.debtUs),
            left: wait.left,
        })),
    };
}

/**
 * Deletes the ended lingers, and the slots without their running job (from a manual change, or old code). Then
 * unblocks the jobs blocked on keys with room: a release that ended in a linger, or a process that stopped before its
 * unblock; and the jobs blocked on rate keys whose next start is due: a process that stopped with its timer.
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<import('./store.js').SweepResult>}
 */
export async function sweepSlots(executor, p, limit) {
    const lingers = await executor.run(`
        DELETE FROM ${p}concurrency_slots WHERE (limit_key, slot) IN (
            SELECT limit_key, slot FROM ${p}concurrency_slots WHERE held_until < ${NOW} LIMIT $1 FOR UPDATE SKIP LOCKED
        )
    `, [limit]);
    const orphans = await executor.run(`
        DELETE FROM ${p}concurrency_slots WHERE (limit_key, slot) IN (
            SELECT s.limit_key, s.slot FROM ${p}concurrency_slots s
             WHERE s.held_until IS NULL AND NOT EXISTS (
                 SELECT 1 FROM ${p}jobs j WHERE j.id = s.job_id AND j.status = 'running' AND j.lock_token = s.lock_token
             )
             LIMIT $1 FOR UPDATE SKIP LOCKED
        )
    `, [limit]);
    let unblocked = 0;
    /** @type {import('../gcra.js').RateWait[]} */
    const rateWaits = [];

    // The keys with blocked jobs, a batch at a time: a loose index scan of the blocked jobs
    for (let after = ''; ;) {
        // oxlint-disable-next-line no-await-in-loop -- batches one after the other
        const keys = (await executor.query(`
            WITH RECURSIVE keys AS (
                (SELECT blocked_on FROM ${p}jobs WHERE status = 'blocked' AND blocked_on > $1 ORDER BY blocked_on LIMIT 1)
                UNION ALL
                SELECT (
                    SELECT j.blocked_on FROM ${p}jobs j
                     WHERE j.status = 'blocked' AND j.blocked_on > keys.blocked_on ORDER BY j.blocked_on LIMIT 1
                ) FROM keys WHERE keys.blocked_on IS NOT NULL
            )
            SELECT blocked_on FROM keys WHERE blocked_on IS NOT NULL LIMIT $2
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
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<number>} The deleted rows.
 */
export async function deleteIdleRateKeys(executor, p, limit) {
    return executor.run(`
        DELETE FROM ${p}rate_limits WHERE limit_key IN (
            SELECT limit_key FROM ${p}rate_limits WHERE tat < ${NOW} LIMIT $1 FOR UPDATE SKIP LOCKED
        )
    `, [limit]);
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
    const rows = await executor.query(`
        WITH expired AS (
            SELECT id FROM ${p}jobs WHERE expires_at < ${NOW} ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
        ),
        deleted AS (
            DELETE FROM ${p}jobs j USING expired WHERE j.id = expired.id RETURNING j.id
        ),
        payloads AS (
            DELETE FROM ${p}payloads pl USING deleted WHERE pl.id = deleted.id
        )
        SELECT count(*) AS count FROM deleted
    `, [limit]);

    return Number(rows[0].count);
}

/**
 * For drain({ includeDelayed }): the pending jobs of the names are due now.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} names
 * @returns {Promise<void>}
 */
export async function makeDue(executor, p, names) {
    await executor.run(`
        UPDATE ${p}jobs SET run_at = ${runAt('interval \'0\'')}
         WHERE status = 'pending' AND job_name = ANY(${arrayParam(1, 'text')}) AND run_at > ${NOW}
    `, [names]);
}

/**
 * The counts per job name, for alerts such as "queue stuck".
 * @param {Executor} executor
 * @param {string} p
 * @returns {Promise<import('../types.js').JobStats[]>}
 */
export async function getStats(executor, p) {
    const rows = await executor.query(`
        SELECT job_name,
               count(*) FILTER (WHERE status IN ('pending', 'blocked')) AS pending,
               count(*) FILTER (WHERE status = 'pending' AND run_at <= ${NOW}) AS due,
               count(*) FILTER (WHERE status = 'running') AS running,
               count(*) FILTER (WHERE status = 'running' AND timed_out_at IS NOT NULL) AS stuck,
               count(*) FILTER (WHERE status = 'failed') AS failed,
               (EXTRACT(EPOCH FROM ${NOW} - min(run_at) FILTER (WHERE status = 'pending' AND run_at <= ${NOW}))
                   * 1000)::bigint AS oldest_due_age_ms
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
