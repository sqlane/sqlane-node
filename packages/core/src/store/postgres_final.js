// The final writes on PostgreSQL: lease renewal, complete, retry, fail, release, stall recovery, sweeps. Each write of
// a job checks its lock token: a process that lost the lease changes nothing. Each runs in a queue transaction.
import { monotonicFactory } from 'ulid';
import { insertJobsPostgres } from './postgres_enqueue.js';

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
const enqueueToken = monotonicFactory();

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
              JOIN unnest($1::text[], $2::text[]) AS own(id, lock_token)
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
    await executor.run(`DELETE FROM ${p}mutexes WHERE job_id = $1 AND lock_token = $2`, [job.id, job.lockToken]);
}

/**
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @param {number} lingerMs The keys stay held this long. 0: deleted.
 * @returns {Promise<void>}
 */
async function lingerHolds(executor, p, job, lingerMs) {
    if (lingerMs <= 0) {
        await deleteHolds(executor, p, job);

        return;
    }

    await executor.run(`
        UPDATE ${p}mutexes SET held_until = ${NOW} + $3 * ${MS}
         WHERE job_id = $1 AND lock_token = $2 AND held_until IS NULL
    `, [job.id, job.lockToken, lingerMs]);
}

/**
 * The jobs are done: completed until their retention ends, without their payloads; their keys are freed. One
 * statement for many jobs.
 * @param {Executor} executor
 * @param {string} p
 * @param {import('./store.js').FinishedJob[]} jobs
 * @returns {Promise<number>} The jobs that this call completed: the others lost their lease, or an earlier try
 *     committed.
 */
export async function completeJobs(executor, p, jobs) {
    const [row] = await executor.query(`
        WITH owned AS (
            SELECT * FROM unnest($1::text[], $2::text[]) AS o(id, lock_token)
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
            DELETE FROM ${p}mutexes m USING owned WHERE m.job_id = owned.id AND m.lock_token = owned.lock_token
        )
        SELECT count(*)::integer AS changed FROM done
    `, [jobs.map(job => job.id), jobs.map(job => job.lockToken)]);

    return Number(row?.changed ?? 0);
}

/**
 * The attempt failed: pending again after the delay, one more attempt used; its keys are freed.
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
        await insertJobsPostgres(executor, p, [newJob], enqueueToken());
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
               pl.payload::text AS payload
          FROM ${p}jobs j LEFT JOIN ${p}payloads pl ON pl.id = j.id
         WHERE ${where}
           FOR UPDATE OF j
    `, params);

    return row;
}

/**
 * The job fails for good: failed until its retention ends, with its payload; its keys are freed; its failure job is
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
 * @param {{ delayMs: number, lingerMs: number }} params lingerMs: its keys stay held this long (its handler still
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
 * A running job whose lease ended: one more stall, pending again after 30 s × 2^stalls (at most 1 h); after maxStalls,
 * it fails for good. Its keys linger for one lease: its old handler may still run.
 * @param {Executor} executor
 * @param {string} p
 * @param {string} id
 * @param {{ leaseMs: number, buildFailureJob: FailureJobBuilder }} params
 * @returns {Promise<{ result: 'released' | 'failed' | null, failureJob: FailureJobResult | null }>} null: not stale
 *     (any more).
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

        return { result: 'released', failureJob: null };
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
    };
}

/**
 * Deletes the ended lingers, and the holds without their running job (from a manual change, or old code).
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<{ lingers: number, orphans: number }>}
 */
export async function sweepMutexes(executor, p, limit) {
    const lingers = await executor.run(`
        DELETE FROM ${p}mutexes WHERE mutex_key IN (
            SELECT mutex_key FROM ${p}mutexes WHERE held_until < ${NOW} LIMIT $1 FOR UPDATE SKIP LOCKED
        )
    `, [limit]);
    const orphans = await executor.run(`
        DELETE FROM ${p}mutexes WHERE mutex_key IN (
            SELECT m.mutex_key FROM ${p}mutexes m
             WHERE m.held_until IS NULL AND NOT EXISTS (
                 SELECT 1 FROM ${p}jobs j WHERE j.id = m.job_id AND j.status = 'running' AND j.lock_token = m.lock_token
             )
             LIMIT $1 FOR UPDATE SKIP LOCKED
        )
    `, [limit]);

    return { lingers, orphans };
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
         WHERE status = 'pending' AND job_name = ANY($1::text[]) AND run_at > ${NOW}
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
               count(*) FILTER (WHERE status = 'pending') AS pending,
               count(*) FILTER (WHERE status = 'pending' AND run_at <= ${NOW}) AS due,
               count(*) FILTER (WHERE status = 'running') AS running,
               count(*) FILTER (WHERE status = 'running' AND timed_out_at IS NOT NULL) AS stuck,
               count(*) FILTER (WHERE status = 'failed') AS failed,
               (EXTRACT(EPOCH FROM ${NOW} - min(run_at) FILTER (WHERE status = 'pending' AND run_at <= ${NOW}))
                   * 1000)::bigint AS oldest_due_age_ms
          FROM ${p}jobs
         WHERE status IN ('pending', 'running', 'failed')
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
