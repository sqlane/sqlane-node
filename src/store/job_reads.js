// The reads of sqlane.jobs: one job by its id, and a page of the jobs of a lane. Plain reads on the queue's pool,
// without a lock. MySQL and MariaDB share their SQL: JSON as text, times as epoch ms that SQL computes.
import { parseRateKey } from '../rate_limit_shape.js';
import { isRateKey } from '../rate_keys.js';
import { scheduledAtOf } from '../schedule.js';

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('../types.js').JobRecord} JobRecord */
/** @typedef {'mysql' | 'postgres'} Family */

/**
 * The SQL of one family.
 * @typedef {object} FamilySql
 * @property {(column: string) => string} epochMs A time as epoch ms, whatever the time zone of the session.
 * @property {(column: string) => string} json A JSON column as text.
 * @property {(column: string) => string} array An array of keys or maxes as JSON text.
 * @property {(ms: number, param: (value: unknown) => string) => string} time A time parameter, typed as the column.
 * @property {(index: number) => string} placeholder
 */

/** @type {Record<Family, FamilySql>} */
const SQL = {
    mysql: {
        epochMs: column => `TIMESTAMPDIFF(MICROSECOND, '1970-01-01', ${column}) DIV 1000`,
        json: column => `CAST(${column} AS CHAR)`,
        array: column => `CAST(${column} AS CHAR)`,
        // A UTC DATETIME, as enqueue sends runAt: no conversion by the time zone of the session
        time: (ms, param) => param(new Date(ms).toISOString().replace('T', ' ').replace('Z', '')),
        placeholder: () => '?',
    },
    postgres: {
        epochMs: column => `(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`,
        json: column => `${column}::text`,
        array: column => `array_to_json(${column})::text`,
        time: (ms, param) => `${param(new Date(ms).toISOString())}::timestamptz`,
        placeholder: index => `$${index}`,
    },
};

/**
 * The columns of a job, and its payload.
 * @param {Family} family
 * @param {boolean} withPayload
 * @returns {string}
 */
function columnsOf(family, withPayload) {
    const { epochMs, json, array } = SQL[family];
    const payload = withPayload ? `, ${json('pl.payload')} AS payload, pl.id IS NOT NULL AS payload_found` : '';

    return `j.id, j.lane, j.status, j.attempts, j.max_attempts, j.stalls, j.max_stalls,
            ${array('j.limit_keys')} AS limit_keys, ${array('j.limit_maxes')} AS limit_maxes,
            ${json('j.rate_limits')} AS rate_limits, j.blocked_on, ${json('j.last_error')} AS last_error,
            j.timed_out_at IS NOT NULL AS timed_out,
            ${epochMs('j.run_at')} AS run_at_ms, ${epochMs('j.created_at')} AS created_at_ms,
            ${epochMs('j.started_at')} AS started_at_ms, ${epochMs('j.finished_at')} AS finished_at_ms,
            ${epochMs('j.expires_at')} AS expires_at_ms${payload}`;
}

/**
 * @param {unknown} ms
 * @returns {Date | null}
 */
function dateOf(ms) {
    return ms === null || ms === undefined ? null : new Date(Number(ms));
}

/**
 * @param {unknown} value A JSON column as text, or null.
 * @returns {any}
 */
function parsed(value) {
    return value === null || value === undefined ? null : JSON.parse(String(value));
}

/**
 * @param {string} stored A key that a job is blocked on.
 * @returns {JobRecord['blockedOn']}
 */
function blockedOnOf(stored) {
    return isRateKey(stored) ? { type: 'rate', ...parseRateKey(stored) } : { type: 'concurrency', key: stored };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {JobRecord}
 */
function recordOf(row) {
    const id = String(row.id);
    const status = /** @type {import('../types.js').JobStatus} */ (String(row.status));
    /** @type {string[]} */
    const keys = parsed(row.limit_keys) ?? [];
    /** @type {number[]} */
    const maxes = parsed(row.limit_maxes) ?? [];
    /** @type {import('../rate_keys.js').GlobalRateLimit[]} */
    const rates = parsed(row.rate_limits) ?? [];
    const found = row.payload_found !== undefined && Boolean(Number(row.payload_found));

    return {
        id,
        lane: String(row.lane),
        status,
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        stalls: Number(row.stalls),
        maxStalls: Number(row.max_stalls),
        runAt: /** @type {Date} */ (dateOf(row.run_at_ms)),
        enqueuedAt: /** @type {Date} */ (dateOf(row.created_at_ms)),
        startedAt: dateOf(row.started_at_ms),
        finishedAt: dateOf(row.finished_at_ms),
        expiresAt: dateOf(row.expires_at_ms),
        scheduledAt: scheduledAtOf(id),
        stuck: status === 'running' && Boolean(Number(row.timed_out)),
        lastError: parsed(row.last_error),
        globalConcurrencyLimits: keys.map((key, at) => ({ key, max: Number(maxes[at]) })),
        globalRateLimits: rates.map((rate) => {
            const { limit, key } = parseRateKey(rate.key);

            return { limit, key, max: rate.max, per: rate.per_us / 1000, burst: rate.burst, cost: rate.cost };
        }),
        blockedOn: status === 'blocked' && row.blocked_on !== null ? blockedOnOf(String(row.blocked_on)) : null,
        ...(found && { payload: parsed(row.payload) }),
    };
}

/**
 * One job by its full id, with its payload. Null: no such job.
 * @param {Executor} executor
 * @param {Family} family
 * @param {string} p
 * @param {string} id
 * @returns {Promise<JobRecord | null>}
 */
export async function getJob(executor, family, p, id) {
    const [row] = await executor.query(`
        SELECT ${columnsOf(family, true)}
          FROM ${p}jobs j LEFT JOIN ${p}payloads pl ON pl.id = j.id
         WHERE j.id = ${SQL[family].placeholder(1)}
    `, [id]);

    return row ? recordOf(row) : null;
}

/**
 * @typedef {object} ListParams
 * @property {string} lane
 * @property {readonly import('../types.js').JobStatus[] | null} statuses Null: every status.
 * @property {number} limit
 * @property {{ enqueuedAtMs: number, id: string } | null} after The last job of the previous page.
 * @property {boolean} includePayload
 */

/**
 * A page of the jobs of a lane, newest first: by enqueue time, then by id. One row more than the limit tells whether
 * a next page exists. Both families seek in the index `(lane, created_at, id)` of 0008_job_list: PostgreSQL with
 * a row comparison, which it does not do with an OR; MySQL and MariaDB with the OR, which they turn into ranges, and an
 * index hint, without which MariaDB 10.11 filters the rows of the lane, and MySQL 8.4 and MariaDB 11.8 sort the rows of
 * a status.
 * @param {Executor} executor
 * @param {Family} family
 * @param {string} p
 * @param {ListParams} params
 * @returns {Promise<{ jobs: JobRecord[], last: { enqueuedAtMs: number, id: string } | null }>} `last`: the last job of
 *     the page, when a next page may exist.
 */
export async function listJobs(executor, family, p, { lane, statuses, limit, after, includePayload }) {
    const sql = SQL[family];
    /** @type {unknown[]} */
    const params = [];
    const param = (/** @type {unknown} */ value) => {
        params.push(value);

        return sql.placeholder(params.length);
    };
    const conditions = [`j.lane = ${param(lane)}`];

    if (statuses) {
        conditions.push(`j.status IN (${statuses.map(status => param(status)).join(', ')})`);
    }

    if (after) {
        conditions.push(family === 'postgres'
            ? `(j.created_at, j.id) < (${sql.time(after.enqueuedAtMs, param)}, ${param(after.id)})`
            : `(j.created_at < ${sql.time(after.enqueuedAtMs, param)}
               OR (j.created_at = ${sql.time(after.enqueuedAtMs, param)} AND j.id < ${param(after.id)}))`);
    }

    const hint = family === 'postgres' ? '' : ` FORCE INDEX (${p}jobs_list)`;
    const join = includePayload ? ` LEFT JOIN ${p}payloads pl ON pl.id = j.id` : '';
    const rows = await executor.query(`
        SELECT ${columnsOf(family, includePayload)}
          FROM ${p}jobs j${hint}${join}
         WHERE ${conditions.join(' AND ')}
         ORDER BY j.created_at DESC, j.id DESC
         LIMIT ${param(limit + 1)}
    `, params);
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page.at(-1) : undefined;

    return {
        jobs: page.map(recordOf),
        last: last ? { enqueuedAtMs: Number(last.created_at_ms), id: String(last.id) } : null,
    };
}
