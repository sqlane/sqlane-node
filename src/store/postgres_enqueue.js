// Enqueue on PostgreSQL: one statement, atomic even outside a transaction.

/**
 * Inserts the jobs and their payloads. With a notify channel, a NOTIFY of the job name when it created a job, in the
 * same statement.
 * @param {import('../types.js').Executor} executor
 * @param {string} p The table prefix.
 * @param {import('../new_job.js').NewJob[]} jobs Their ids are distinct, of one name.
 * @param {{ enqueueToken: string, notifyChannel?: string | null }} options
 * @returns {Promise<Set<string>>} The ids that this call created.
 */
export async function insertJobsPostgres(executor, p, jobs, { enqueueToken, notifyChannel = null }) {
    const input = jobs.map(job => ({
        id: job.id,
        job_name: job.name,
        payload: JSON.parse(job.payloadJson),
        mutex_keys: job.mutexKeys.length ? job.mutexKeys : null,
        max_attempts: job.maxAttempts,
        max_stalls: job.maxStalls,
        completed_retention_ms: job.completedRetentionMs,
        failed_retention_ms: job.failedRetentionMs,
        failure_job: job.failureJob,
        delay_ms: job.delayMs,
        run_at: job.runAt?.toISOString() ?? null,
    }));
    const rows = await executor.query(`
        WITH input AS (
            SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS r(
                  id text, job_name text, payload jsonb, mutex_keys text[], max_attempts integer,
                  max_stalls integer, completed_retention_ms bigint, failed_retention_ms bigint, failure_job text,
                  delay_ms bigint, run_at timestamptz
            )
        ),
        inserted AS (
            INSERT INTO ${p}jobs (id, job_name, status, run_at, max_attempts, max_stalls, mutex_keys, enqueue_token,
                completed_retention_ms, failed_retention_ms, failure_job, created_at, updated_at)
            SELECT id, job_name, 'pending',
                   -- Truncated: timestamptz(3) rounds, and a rounded-up time is not due for the claim
                   COALESCE(run_at, date_trunc('milliseconds', clock_timestamp() + delay_ms * interval '1 millisecond')),
                   max_attempts, max_stalls, mutex_keys, $2, completed_retention_ms, failed_retention_ms, failure_job,
                   clock_timestamp(), clock_timestamp()
              FROM input ORDER BY id
            ON CONFLICT (id) DO NOTHING
            RETURNING id, run_at, job_name, mutex_keys
        ),
        job_keys AS (
            INSERT INTO ${p}job_keys (mutex_key, run_at, job_id, job_name)
            SELECT k.mutex_key, inserted.run_at, inserted.id, inserted.job_name
              FROM inserted CROSS JOIN LATERAL unnest(inserted.mutex_keys) AS k(mutex_key)
            ON CONFLICT DO NOTHING
        ),
        payloads AS (
            INSERT INTO ${p}payloads (id, payload)
            SELECT input.id, input.payload FROM input JOIN inserted ON inserted.id = input.id
            ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload
        ),
        -- One NOTIFY per transaction and name: PostgreSQL drops the repeated ones
        notified AS (
            SELECT pg_notify($3, $4) FROM (SELECT FROM inserted LIMIT 1) AS created WHERE $3::text IS NOT NULL
        )
        -- The NOTIFY runs once, at the first created row
        SELECT id FROM inserted WHERE (SELECT count(*) FROM notified) >= 0
    `, [JSON.stringify(input), enqueueToken, notifyChannel, jobs[0]?.name ?? null]);

    return new Set(rows.map(row => String(row.id)));
}
