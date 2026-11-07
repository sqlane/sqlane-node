// The final writes on MySQL: lease renewal, complete, retry, fail, release, stall recovery, sweeps. Each write of a
// job checks its lock token: a process that lost the lease changes nothing. Each runs in a queue transaction.
import { monotonicFactory } from 'ulid';
import { insertJobsMysql } from './mysql_enqueue.js';

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').OwnedJob} OwnedJob */
/** @typedef {import('./store.js').FailureJobBuilder} FailureJobBuilder */
/** @typedef {import('./store.js').FailureJobResult} FailureJobResult */

const NOW = 'UTC_TIMESTAMP(3)';
const CLEAR_LOCK = 'lock_token = NULL, locked_by = NULL, locked_until = NULL, timed_out_at = NULL';
const enqueueToken = monotonicFactory();

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
    await executor.run(`DELETE FROM ${p}mutexes WHERE job_id = ? AND lock_token = ?`, [job.id, job.lockToken]);
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
        UPDATE ${p}mutexes SET held_until = ${NOW} + INTERVAL ? MICROSECOND
         WHERE job_id = ? AND lock_token = ? AND held_until IS NULL
    `, [lingerMs * 1000, job.id, job.lockToken]);
}

/**
 * The job is done: completed until its retention ends, without its payload; its keys are freed.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @returns {Promise<boolean>} False: no change (the lease was lost, or an earlier try committed).
 */
export async function completeJob(executor, p, job) {
    const changed = await executor.run(`
        UPDATE ${p}jobs
           SET status = 'completed', finished_at = ${NOW},
               expires_at = ${NOW} + INTERVAL completed_retention_ms * 1000 MICROSECOND, ${CLEAR_LOCK},
               updated_at = ${NOW}
         WHERE id = ? AND lock_token = ?
    `, [job.id, job.lockToken]);

    if (changed) {
        await executor.run(`DELETE FROM ${p}payloads WHERE id = ?`, [job.id]);
    }

    await deleteHolds(executor, p, job);

    return changed > 0;
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

    await executor.run('SAVEPOINT sqlane_failure_job', []);

    try {
        await insertJobsMysql(executor, p, [newJob], enqueueToken());

        return { added: newJob };
    } catch (insertError) {
        // MySQL rolls back only the failed statement: the job row can be there without its payload
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
               CAST(pl.payload AS CHAR) AS payload
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
 * @param {{ delayMs: number, lingerMs: number }} params lingerMs: its keys stay held this long (its handler still
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

        return { result: 'released', failureJob: null };
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
    const lingers = await executor.run(`DELETE FROM ${p}mutexes WHERE held_until < ${NOW} LIMIT ?`, [limit]);
    const orphanKeys = (await executor.query(`
        SELECT m.mutex_key FROM ${p}mutexes m
         WHERE m.held_until IS NULL AND NOT EXISTS (
             SELECT 1 FROM ${p}jobs j WHERE j.id = m.job_id AND j.status = 'running' AND j.lock_token = m.lock_token
         )
         LIMIT ?
    `, [limit])).map(row => String(row.mutex_key));
    const orphans = orphanKeys.length
        ? await executor.run(`
            DELETE m FROM ${p}mutexes m LEFT JOIN ${p}jobs j
                ON j.id = m.job_id AND j.status = 'running' AND j.lock_token = m.lock_token
             WHERE m.mutex_key IN (${placeholders(orphanKeys.length)}) AND m.held_until IS NULL AND j.id IS NULL
        `, orphanKeys)
        : 0;

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
 * The counts per job name, for alerts such as "queue stuck". Reads the status index only.
 * @param {Executor} executor
 * @param {string} p
 * @returns {Promise<import('../types.js').JobStats[]>}
 */
export async function getStats(executor, p) {
    const rows = await executor.query(`
        SELECT job_name,
               SUM(status = 'pending') AS pending,
               SUM(status = 'pending' AND run_at <= ${NOW}) AS due,
               SUM(status = 'running') AS running,
               SUM(status = 'running' AND timed_out_at IS NOT NULL) AS stuck,
               SUM(status = 'failed') AS failed,
               TIMESTAMPDIFF(MICROSECOND, MIN(IF(status = 'pending' AND run_at <= ${NOW}, run_at, NULL)), ${NOW})
                   DIV 1000 AS oldest_due_age_ms
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
