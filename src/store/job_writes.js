// The SQL of the bulk methods of sqlane.jobs: retry, cancel and remove, by phase (read, lock, write). Each function
// runs on the executor it gets: the queue's pool, a transaction of sqlane's own, or the caller's connection. So every
// statement returns one-word lowercase columns, which no transform of a driver renames (postgres.js `transform`). Id
// and status lists are one array parameter on PostgreSQL (one prepared statement for every length), and chunks of 500
// on MySQL and MariaDB (MariaDB turns an IN list of 1000 values into a semi-join; Prisma prepares on the server).
import { arrayParam } from './postgres_worker.js';

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('../types.js').JobStatus} JobStatus */

/**
 * Where the statements run.
 * @typedef {object} Db
 * @property {Executor} executor
 * @property {'mysql' | 'postgres'} family MariaDB runs the SQL of MySQL.
 * @property {string} p The table prefix.
 */

/** The ids of one MySQL statement */
const CHUNK_SIZE = 500;

/**
 * A job read before its lock.
 * @typedef {object} ReadJob
 * @property {string} id
 * @property {JobStatus} status
 * @property {boolean} found Its payload exists.
 */

/**
 * A job under its lock, in an accepted status.
 * @typedef {object} LockedJob
 * @property {string} id
 * @property {JobStatus} status
 * @property {number} attempts
 * @property {string[]} keys The keys of its global limits, as stored.
 * @property {string} name
 * @property {boolean} found Its payload exists.
 */

/**
 * The result of a write.
 * @typedef {object} Written
 * @property {number} count The jobs that it changed.
 * @property {string[] | null} ids Their exact ids on PostgreSQL; null on MySQL and MariaDB.
 */

/**
 * @template T
 * @param {readonly T[]} items
 * @returns {T[][]} Chunks of `CHUNK_SIZE`, in order.
 */
function chunksOf(items) {
    /** @type {T[][]} */
    const chunks = [];

    for (let at = 0; at < items.length; at += CHUNK_SIZE) {
        chunks.push(items.slice(at, at + CHUNK_SIZE));
    }

    return chunks;
}

/**
 * @param {number} count
 * @returns {string} `?, ?, …`
 */
function marks(count) {
    return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * @param {Record<string, unknown>} row
 * @returns {boolean} `found`: a boolean, 0/1, or a BigInt, by driver.
 */
function foundOf(row) {
    return Boolean(Number(row.found));
}

/**
 * MySQL and MariaDB: a statement by chunks of ids, one after the other, in their order.
 * @param {Executor} executor
 * @param {readonly string[]} ids
 * @param {(chunkMarks: string, chunk: string[]) => { sql: string, params: unknown[] }} statementOf
 * @returns {Promise<{ rows: Record<string, unknown>[], changed: number }>}
 */
async function byChunks(executor, ids, statementOf) {
    /** @type {Record<string, unknown>[]} */
    const rows = [];
    let changed = 0;

    for (const chunk of chunksOf(ids)) {
        const { sql, params } = statementOf(marks(chunk.length), chunk);

        if (/^\s*SELECT /.test(sql)) {
            // oxlint-disable-next-line no-await-in-loop -- one statement at a time, in id order
            rows.push(...await executor.query(sql, params));
        } else {
            // oxlint-disable-next-line no-await-in-loop -- one statement at a time, in id order
            changed += await executor.run(sql, params);
        }
    }

    return { rows, changed };
}

/**
 * The jobs of the ids, with their status and whether their payload exists. No lock.
 * @param {Db} db
 * @param {readonly string[]} ids
 * @returns {Promise<ReadJob[]>}
 */
export async function readByIds({ executor, family, p }, ids) {
    const select = `SELECT j.id AS id, j.status AS status, pl.id IS NOT NULL AS found FROM ${p}jobs j LEFT JOIN ${
        p}payloads pl ON pl.id = j.id`;
    const rows = family === 'postgres'
        ? await executor.query(`${select} WHERE j.id = ANY(${arrayParam(1, 'text')})`, [ids])
        : (await byChunks(executor, ids, (chunkMarks, chunk) => ({
                sql: `${select} WHERE j.id IN (${chunkMarks})`,
                params: chunk,
            }))).rows;

    return rows.map(row => ({
        id: String(row.id),
        status: /** @type {JobStatus} */ (row.status),
        found: foundOf(row),
    }));
}

/**
 * The jobs of a name in the statuses, and whether their payload exists. No lock.
 * @param {Db} db
 * @param {{ jobName: string, statuses: readonly JobStatus[] }} filter
 * @returns {Promise<{ id: string, found: boolean }[]>}
 */
export async function readByFilter({ executor, family, p }, { jobName, statuses }) {
    const select = `SELECT j.id AS id, pl.id IS NOT NULL AS found FROM ${p}jobs j LEFT JOIN ${
        p}payloads pl ON pl.id = j.id`;
    const rows = family === 'postgres'
        ? await executor.query(
                `${select} WHERE j.job_name = $1 AND j.status = ANY(${arrayParam(2, 'text')})`,
                [jobName, statuses],
            )
        : await executor.query(
                `${select} WHERE j.job_name = ? AND j.status IN (${marks(statuses.length)})`,
                [jobName, ...statuses],
            );

    return rows.map(row => ({ id: String(row.id), found: foundOf(row) }));
}

/**
 * The next batch of the jobs of a name in the statuses, in the order of `jobs.list`: after `after`, newest first. No
 * lock. It seeks in the index of 0008_job_list, as `jobs.list`.
 * @param {Db} db
 * @param {{ jobName: string, statuses: readonly JobStatus[], after: { ms: number, id: string } | null, limit: number }}
 *     params
 * @returns {Promise<{ id: string, ms: number }[]>}
 */
export async function readBatch({ executor, family, p }, { jobName, statuses, after, limit }) {
    if (family === 'postgres') {
        const keyset = after ? ' AND (j.created_at, j.id) < ($4::timestamptz, $5)' : '';
        const rows = await executor.query(`
            SELECT j.id AS id, (EXTRACT(EPOCH FROM j.created_at) * 1000)::bigint AS ms
              FROM ${p}jobs j
             WHERE j.job_name = $1 AND j.status = ANY(${arrayParam(2, 'text')})${keyset}
             ORDER BY j.created_at DESC, j.id DESC
             LIMIT $3
        `, after ? [jobName, statuses, limit, new Date(after.ms).toISOString(), after.id] : [jobName, statuses, limit]);

        return rows.map(row => ({ id: String(row.id), ms: Number(row.ms) }));
    }

    const time = after && new Date(after.ms).toISOString().replace('T', ' ').replace('Z', '');
    const keyset = after ? ' AND (j.created_at < ? OR (j.created_at = ? AND j.id < ?))' : '';
    const rows = await executor.query(`
        SELECT j.id AS id, TIMESTAMPDIFF(MICROSECOND, '1970-01-01', j.created_at) DIV 1000 AS ms
          FROM ${p}jobs j FORCE INDEX (${p}jobs_list)
         WHERE j.job_name = ? AND j.status IN (${marks(statuses.length)})${keyset}
         ORDER BY j.created_at DESC, j.id DESC
         LIMIT ?
    `, [jobName, ...statuses, ...(after ? [time, time, after.id] : []), limit]);

    return rows.map(row => ({ id: String(row.id), ms: Number(row.ms) }));
}

/**
 * Locks the jobs of the ids that are in the statuses, by primary key, in id order (the ids are sorted). In READ
 * COMMITTED, a row changed meanwhile is checked again; a row in another status is not locked.
 * @param {Db} db
 * @param {{ ids: readonly string[], statuses: readonly JobStatus[] }} target `ids` sorted.
 * @returns {Promise<LockedJob[]>}
 */
export async function lockJobs({ executor, family, p }, { ids, statuses }) {
    const limits = family === 'postgres' ? 'array_to_json(j.limit_keys)::text' : 'CAST(j.limit_keys AS CHAR)';
    const columns = `j.id AS id, j.status AS status, j.attempts AS attempts, ${limits} AS limits, j.job_name AS name, `
        + `EXISTS (SELECT 1 FROM ${p}payloads pl WHERE pl.id = j.id) AS found`;
    const rows = family === 'postgres'
        ? await executor.query(`SELECT ${columns} FROM ${p}jobs j WHERE j.id = ANY(${arrayParam(1, 'text')
            }) AND j.status = ANY(${arrayParam(2, 'text')}) ORDER BY j.id FOR UPDATE`, [ids, statuses])
        : (await byChunks(executor, ids, (chunkMarks, chunk) => ({
                sql: `SELECT ${columns} FROM ${p}jobs j FORCE INDEX (PRIMARY) WHERE j.id IN (${chunkMarks
                }) AND j.status IN (${marks(statuses.length)}) ORDER BY j.id FOR UPDATE`,
                params: [...chunk, ...statuses],
            }))).rows;

    return rows.map(row => ({
        id: String(row.id),
        status: /** @type {JobStatus} */ (row.status),
        attempts: Number(row.attempts),
        keys: row.limits === null || row.limits === undefined ? [] : JSON.parse(String(row.limits)),
        name: String(row.name),
        found: foundOf(row),
    }));
}

/**
 * Failed jobs back to pending: due now, or when the lingering slots of their earlier runs end. Guarded by the status.
 * @param {Db} db
 * @param {{ ids: readonly string[], budget: 'reset' | 'one_more' }} target
 * @returns {Promise<Written>}
 */
export async function retryJobs({ executor, family, p }, { ids, budget }) {
    const counts = budget === 'reset'
        ? 'j.attempts = 0, j.stalls = 0'
        : 'j.max_attempts = j.attempts + 1, j.max_stalls = GREATEST(j.max_stalls, j.stalls)';
    const linger = `(SELECT MAX(s.held_until) FROM ${p}concurrency_slots s WHERE s.job_id = j.id)`;

    if (family === 'postgres') {
        // PostgreSQL takes no alias on the columns of SET
        const rows = await executor.query(`
            UPDATE ${p}jobs j
               SET status = 'pending', ${counts.replaceAll(/j\.(\w+) =/g, '$1 =')},
                   run_at = GREATEST(date_trunc('milliseconds', clock_timestamp()), ${linger}),
                   blocked_on = NULL, finished_at = NULL, expires_at = NULL, updated_at = clock_timestamp()
             WHERE j.id = ANY(${arrayParam(1, 'text')}) AND j.status = 'failed'
            RETURNING j.id AS id
        `, [ids]);
        const changed = rows.map(row => String(row.id));

        return { count: changed.length, ids: changed };
    }

    const { changed } = await byChunks(executor, ids, (chunkMarks, chunk) => ({
        sql: `
            UPDATE ${p}jobs j FORCE INDEX (PRIMARY)
               SET j.status = 'pending', ${counts},
                   j.run_at = GREATEST(UTC_TIMESTAMP(3), COALESCE(${linger}, UTC_TIMESTAMP(3))),
                   j.blocked_on = NULL, j.finished_at = NULL, j.expires_at = NULL, j.updated_at = UTC_TIMESTAMP(3)
             WHERE j.id IN (${chunkMarks}) AND j.status = 'failed'
        `,
        params: chunk,
    }));

    return { count: changed, ids: null };
}

/**
 * Pending and blocked jobs to failed, with the error of a cancel, from now for their failed retention. Guarded by the
 * status.
 * @param {Db} db
 * @param {{ ids: readonly string[], statuses: readonly JobStatus[], errorJson: string }} target `statuses`: pending,
 *     blocked or both. `errorJson`: the `last_error` of the jobs.
 * @returns {Promise<Written>}
 */
export async function cancelJobs({ executor, family, p }, { ids, statuses, errorJson }) {
    if (family === 'postgres') {
        const rows = await executor.query(`
            UPDATE ${p}jobs
               SET status = 'failed', finished_at = clock_timestamp(),
                   expires_at = clock_timestamp() + failed_retention_ms * interval '1 millisecond', blocked_on = NULL,
                   last_error = $2::text::jsonb, updated_at = clock_timestamp()
             WHERE id = ANY(${arrayParam(1, 'text')}) AND status = ANY(${arrayParam(3, 'text')})
            RETURNING id AS id
        `, [ids, errorJson, statuses]);
        const changed = rows.map(row => String(row.id));

        return { count: changed.length, ids: changed };
    }

    const { changed } = await byChunks(executor, ids, (chunkMarks, chunk) => ({
        sql: `
            UPDATE ${p}jobs FORCE INDEX (PRIMARY)
               SET status = 'failed', finished_at = UTC_TIMESTAMP(3),
                   expires_at = UTC_TIMESTAMP(3) + INTERVAL failed_retention_ms * 1000 MICROSECOND, blocked_on = NULL,
                   last_error = ?, updated_at = UTC_TIMESTAMP(3)
             WHERE id IN (${chunkMarks}) AND status IN (${marks(statuses.length)})
        `,
        params: [errorJson, ...chunk, ...statuses],
    }));

    return { count: changed, ids: null };
}

/**
 * Deletes the jobs in the statuses, and their payloads. Guarded by the status: a job claimed meanwhile keeps its row
 * and its payload. The slots are not touched: a linger stays until its time.
 * @param {Db} db
 * @param {{ ids: readonly string[], statuses: readonly JobStatus[] }} target
 * @returns {Promise<Written>}
 */
export async function removeJobs({ executor, family, p }, { ids, statuses }) {
    if (family === 'postgres') {
        // The job ids, not the payloads: a completed job has none
        const rows = await executor.query(`
            WITH d AS (
                DELETE FROM ${p}jobs WHERE id = ANY(${arrayParam(1, 'text')}) AND status = ANY(${arrayParam(2, 'text')})
                RETURNING id
            ),
            pl AS (DELETE FROM ${p}payloads WHERE id IN (SELECT id FROM d))
            SELECT id AS id FROM d
        `, [ids, statuses]);
        const changed = rows.map(row => String(row.id));

        return { count: changed.length, ids: changed };
    }

    const { changed } = await byChunks(executor, ids, (chunkMarks, chunk) => ({
        sql: `
            DELETE j FROM ${p}jobs j FORCE INDEX (PRIMARY)
             WHERE j.id IN (${chunkMarks}) AND j.status IN (${marks(statuses.length)})
        `,
        params: [...chunk, ...statuses],
    }));

    // Only the payloads whose job is gone: outside a transaction, a job claimed between the lock and the delete keeps
    // its row, and must keep its payload
    await byChunks(executor, ids, (chunkMarks, chunk) => ({
        sql: `
            DELETE pl FROM ${p}payloads pl FORCE INDEX (PRIMARY) LEFT JOIN ${p}jobs j ON j.id = pl.id
             WHERE pl.id IN (${chunkMarks}) AND j.id IS NULL
        `,
        params: chunk,
    }));

    return { count: changed, ids: null };
}

/**
 * PostgreSQL with the `notify` option: the hint of the retried names, in the transaction (sent at its commit).
 * @param {Executor} executor
 * @param {string} channel
 * @param {readonly string[]} names
 * @returns {Promise<void>}
 */
export async function notifyNames(executor, channel, names) {
    await executor.query(
        `SELECT 1 AS ok FROM (SELECT pg_notify($1, n) FROM unnest(${arrayParam(2, 'text')}) AS n) s`,
        [channel, names],
    );
}
