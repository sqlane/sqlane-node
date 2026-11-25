// Enqueue on PostgreSQL: one statement, atomic even outside a transaction.

/**
 * A job as the input of the insert: a row of `jsonb_to_recordset`. Shared with the insert of the schedules.
 * @param {import('../new_job.js').NewJob} job
 * @returns {Record<string, unknown>}
 */
export function toJobInput(job) {
    /** @type {Record<string, unknown>} */
    const input = {
        id: job.id,
        lane: job.lane,
        // As text: a JSON null in a jsonb column of the recordset would be SQL NULL
        payload: job.payloadJson,
        limit_keys: job.limits.length ? job.limits.map(limit => limit.key) : null,
        limit_maxes: job.limits.length ? job.limits.map(limit => limit.max) : null,
        rate_limits: job.rateLimits.length ? job.rateLimits : null,
        max_attempts: job.maxAttempts,
        max_stalls: job.maxStalls,
        completed_retention_ms: job.completedRetentionMs,
        failed_retention_ms: job.failedRetentionMs,
        delay_ms: job.delayMs,
        run_at: job.runAt?.toISOString() ?? null,
    };

    // Only a job with a group: a missing key of the recordset is null, and the rows of the lanes without groups stay
    // as small as in 10.0
    if (job.fairGroup !== null) {
        input.fair_group = job.fairGroup;
    }

    return input;
}

/**
 * The column of the fair group in the insert, only when a job has a group: an insert without groups runs on a schema
 * without `0011_fair_groups`.
 * @param {import('../new_job.js').NewJob[]} jobs
 * @returns {string} `, fair_group`, for the column list of the INSERT and of its SELECT; or '': the statement of 10.0,
 *     unchanged (its prepared statement too).
 */
export function fairGroupColumn(jobs) {
    return jobs.some(job => job.fairGroup !== null) ? ', fair_group' : '';
}

/**
 * Inserts the jobs and their payloads. With a notify channel, a NOTIFY of the lane when it created a job, in the
 * same statement.
 * @param {import('../types.js').Executor} executor
 * @param {string} p The table prefix.
 * @param {import('../new_job.js').NewJob[]} jobs Their ids are distinct, of one lane.
 * @param {{ enqueueToken: string, notifyChannel?: string | null }} options
 * @returns {Promise<Set<string>>} The ids that this call created.
 */
export async function insertJobsPostgres(executor, p, jobs, { enqueueToken, notifyChannel = null }) {
    const input = jobs.map(toJobInput);
    const group = fairGroupColumn(jobs);
    const rows = await executor.query(`
        WITH input AS (
            SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS r(
                  id text, lane text, payload text, limit_keys text[], limit_maxes integer[], rate_limits jsonb,
                  max_attempts integer, max_stalls integer, completed_retention_ms bigint, failed_retention_ms bigint,
                  delay_ms bigint, run_at timestamptz${group && ', fair_group text'}
            )
        ),
        inserted AS (
            INSERT INTO ${p}jobs (id, lane, status, run_at, max_attempts, max_stalls, limit_keys, limit_maxes,
                rate_limits, enqueue_token, completed_retention_ms, failed_retention_ms, created_at, updated_at${group})
            SELECT id, lane, 'pending',
                   -- Truncated: timestamptz(3) rounds, and a rounded-up time is not due for the claim
                   COALESCE(run_at, date_trunc('milliseconds', clock_timestamp() + delay_ms * interval '1 millisecond')),
                   max_attempts, max_stalls, limit_keys, limit_maxes, rate_limits, $2, completed_retention_ms,
                   failed_retention_ms, clock_timestamp(), clock_timestamp()${group}
              FROM input ORDER BY id
            ON CONFLICT (id) DO NOTHING
            RETURNING id
        ),
        payloads AS (
            INSERT INTO ${p}payloads (id, payload)
            SELECT input.id, input.payload::jsonb FROM input JOIN inserted ON inserted.id = input.id
            ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload
        ),
        -- One NOTIFY per transaction and name: PostgreSQL drops the repeated ones
        notified AS (
            SELECT pg_notify($3, $4) FROM (SELECT FROM inserted LIMIT 1) AS created WHERE $3::text IS NOT NULL
        )
        -- The NOTIFY runs once, at the first created row
        SELECT id FROM inserted WHERE (SELECT count(*) FROM notified) >= 0
    `, [JSON.stringify(input), enqueueToken, notifyChannel, jobs[0]?.lane ?? null]);

    return new Set(rows.map(row => String(row.id)));
}
