// Enqueue on MySQL: in the caller's transaction. MySQL has no RETURNING: the rows of this call are the rows with its
// enqueue token.

/** Rows per INSERT: 14 placeholders a row stay far below the 65,535 of MySQL. */
const CHUNK_SIZE = 500;

/**
 * @param {Date} date
 * @returns {string} The UTC time, as DATETIME(3) reads it.
 */
function toUtcDatetime(date) {
    return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * @param {import('../new_job.js').NewJob} job
 * @returns {{ sql: string, params: unknown[] }} The run_at expression of the job.
 */
function runAtSql(job) {
    return job.runAt
        ? { sql: '?', params: [toUtcDatetime(job.runAt)] }
        : { sql: 'UTC_TIMESTAMP(3) + INTERVAL ? MICROSECOND', params: [job.delayMs * 1000] };
}

/**
 * @param {import('../types.js').Executor} executor
 * @param {string} p
 * @param {import('../new_job.js').NewJob[]} jobs
 * @param {string} enqueueToken
 * @returns {Promise<Set<string>>} The ids that this call created.
 */
async function insertChunk(executor, p, jobs, enqueueToken) {
    const values = jobs.map(job => `(?, ?, 'pending', ${runAtSql(job).sql}, ?, ?, ?, ?, ?, ?, ?, `
        + 'UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))');
    const params = jobs.flatMap(job => [
        job.id,
        job.name,
        ...runAtSql(job).params,
        job.maxAttempts,
        job.maxStalls,
        job.mutexKeys.length ? JSON.stringify(job.mutexKeys) : null,
        enqueueToken,
        job.completedRetentionMs,
        job.failedRetentionMs,
        job.failureJob,
    ]);

    // A duplicate id keeps its row: its token is not this one.
    await executor.query(`
        INSERT INTO ${p}jobs (id, job_name, status, run_at, max_attempts, max_stalls, mutex_keys, enqueue_token,
            completed_retention_ms, failed_retention_ms, failure_job, created_at, updated_at)
        VALUES ${values.join(', ')}
        ON DUPLICATE KEY UPDATE id = id
    `, params);

    const ids = jobs.map(job => job.id);
    const rows = await executor.query(`
        SELECT id FROM ${p}jobs WHERE id IN (${ids.map(() => '?').join(', ')}) AND enqueue_token = ?
    `, [...ids, enqueueToken]);
    const created = new Set(rows.map(row => String(row.id)));
    const createdJobs = jobs.filter(job => created.has(job.id));

    if (createdJobs.length) {
        // A payload row without its job (a manual change) belongs to the new job.
        await executor.query(`
            INSERT INTO ${p}payloads (id, payload) VALUES ${createdJobs.map(() => '(?, ?)').join(', ')} AS new
            ON DUPLICATE KEY UPDATE payload = new.payload
        `, createdJobs.flatMap(job => [job.id, job.payloadJson]));
    }

    const withKeys = createdJobs.filter(job => job.mutexKeys.length);

    if (withKeys.length) {
        await executor.query(`
            INSERT INTO ${p}job_keys (mutex_key, run_at, job_id, job_name)
            SELECT k.mutex_key, j.run_at, j.id, j.job_name FROM ${p}jobs j, JSON_TABLE(j.mutex_keys, '$[*]' COLUMNS (
                mutex_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PATH '$'
            )) AS k
             WHERE j.id IN (${withKeys.map(() => '?').join(', ')})
            ON DUPLICATE KEY UPDATE job_id = job_id
        `, withKeys.map(job => job.id));
    }

    return created;
}

/**
 * Inserts the jobs and their payloads. Call it in a transaction.
 * @param {import('../types.js').Executor} executor
 * @param {string} p The table prefix.
 * @param {import('../new_job.js').NewJob[]} jobs Their ids are distinct.
 * @param {string} enqueueToken
 * @returns {Promise<Set<string>>} The ids that this call created.
 */
export async function insertJobsMysql(executor, p, jobs, enqueueToken) {
    const created = new Set();
    // In the order of the ids: concurrent enqueues lock the rows in one order, without deadlocks.
    const sortedJobs = jobs.toSorted((a, b) => (a.id < b.id ? -1 : 1));

    for (let start = 0; start < sortedJobs.length; start += CHUNK_SIZE) {
        const chunk = sortedJobs.slice(start, start + CHUNK_SIZE);
        // oxlint-disable-next-line no-await-in-loop -- one connection: the chunks run one after the other
        const chunkCreated = await insertChunk(executor, p, chunk, enqueueToken);

        for (const id of chunkCreated) {
            created.add(id);
        }
    }

    return created;
}
