// The worker side of the store on MySQL: probe, candidates, claim. Times are computed in SQL, in UTC.
import { fitSlots } from './fit_slots.js';

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').ProbeRow} ProbeRow */
/** @typedef {import('./store.js').Candidate} Candidate */
/** @typedef {import('./store.js').ClaimParams} ClaimParams */
/** @typedef {import('./store.js').ClaimedJob} ClaimedJob */

/** The due jobs of each keyed name that the FIFO of the mutex keys reads */
export const MUTEX_WINDOW_SIZE = 500;

const NOW = 'UTC_TIMESTAMP(3)';
/**
 * @param {string} column
 * @returns {string} The epoch milliseconds of a time column.
 */
const epochMs = column => `TIMESTAMPDIFF(MICROSECOND, '1970-01-01', ${column}) DIV 1000`;
const HELD = `(m.held_until IS NULL OR m.held_until >= ${NOW})`;

/**
 * @param {number} count
 * @returns {string}
 */
function placeholders(count) {
    return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * @param {unknown} json
 * @returns {string[]}
 */
function parseKeys(json) {
    return json === null || json === undefined ? [] : JSON.parse(String(json));
}

/**
 * The SQL of the probe. `GROUP BY status, job_name`: the whole index prefix, else MySQL does not use a loose index
 * scan.
 * @param {string} p
 * @returns {string}
 */
export function probeSql(p) {
    return `
        SELECT job_name, TIMESTAMPDIFF(MICROSECOND, ${NOW}, MIN(run_at)) DIV 1000 AS delay_ms
          FROM ${p}jobs FORCE INDEX (${p}jobs_status_name_run_at)
         WHERE status = 'pending'
         GROUP BY status, job_name
    `;
}

/**
 * The next due time of each job name with pending jobs: one index dive per pending name (loose index scan).
 * @param {Executor} executor
 * @param {string} p
 * @returns {Promise<ProbeRow[]>}
 */
export async function probe(executor, p) {
    const rows = await executor.query(probeSql(p), []);

    return rows.map(row => ({ name: String(row.job_name), delayMs: Number(row.delay_ms) }));
}

/**
 * @param {string} p
 * @param {string[]} names
 * @param {(index: number) => string} limitSql
 * @returns {string} The oldest due jobs of each name, one index range per name.
 */
function dueJobsSql(p, names, limitSql) {
    return names.map((_, index) => `(
        SELECT id, job_name, run_at, mutex_keys FROM ${p}jobs FORCE INDEX (${p}jobs_status_name_run_at)
         WHERE status = 'pending' AND job_name = ? AND run_at <= ${NOW}
         ORDER BY run_at, id LIMIT ${limitSql(index)}
    )`).join(' UNION ALL ');
}

/**
 * The due jobs that can start now, oldest first: at most `limit` of each name. A job of a keyed name waits if one of
 * its keys is held, or an older due job of a keyed name has it (FIFO per key over the window of the keyed names).
 * @param {Executor} executor
 * @param {string} p
 * @param {Map<string, number>} limitsByName
 * @param {string[]} keyedNames The handled names whose definition has mutex keys.
 * @returns {Promise<Candidate[]>}
 */
export async function findCandidates(executor, p, limitsByName, keyedNames) {
    const keyed = new Set(keyedNames);
    const plainNames = [...limitsByName.keys()].filter(name => !keyed.has(name));
    const keyedRequested = [...limitsByName.keys()].filter(name => keyed.has(name));
    /** @type {Record<string, unknown>[]} */
    const rows = [];

    if (plainNames.length) {
        rows.push(...await executor.query(`
            SELECT id, job_name, ${epochMs('run_at')} AS run_at_ms
              FROM (${dueJobsSql(p, plainNames, () => '?')}) AS due
        `, plainNames.flatMap(name => [name, limitsByName.get(name)])));
    }

    if (keyedRequested.length) {
        const conditions = keyedRequested.map(() => '(job_name = ? AND name_rank <= ?)').join(' OR ');

        rows.push(...await executor.query(`
            WITH w AS (${dueJobsSql(p, keyedNames, () => String(MUTEX_WINDOW_SIZE))}),
            wk AS (
                SELECT w.id, k.mutex_key,
                       ROW_NUMBER() OVER (PARTITION BY k.mutex_key ORDER BY w.run_at, w.id) AS key_rank
                  FROM w, JSON_TABLE(w.mutex_keys, '$[*]' COLUMNS (
                      mutex_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PATH '$'
                  )) AS k
            ),
            busy AS (
                SELECT wk.mutex_key FROM wk JOIN ${p}mutexes m ON m.mutex_key = wk.mutex_key
                 WHERE wk.key_rank = 1 AND ${HELD}
            ),
            blocked AS (
                SELECT id FROM wk WHERE key_rank > 1
                 UNION SELECT wk.id FROM wk JOIN busy ON busy.mutex_key = wk.mutex_key
            ),
            eligible AS (
                SELECT w.id, w.job_name, w.run_at,
                       ROW_NUMBER() OVER (PARTITION BY w.job_name ORDER BY w.run_at, w.id) AS name_rank
                  FROM w WHERE NOT EXISTS (SELECT 1 FROM blocked b WHERE b.id = w.id)
            )
            SELECT id, job_name, ${epochMs('run_at')} AS run_at_ms FROM eligible WHERE ${conditions}
        `, [...keyedNames, ...keyedRequested.flatMap(name => [name, limitsByName.get(name)])]));
    }

    return rows
        .map(row => ({ id: String(row.id), name: String(row.job_name), runAtMs: Number(row.run_at_ms) }))
        .toSorted((a, b) => a.runAtMs - b.runAtMs || (a.id < b.id ? -1 : 1));
}

/**
 * Takes the keys of the picked jobs, all or none per job. A held key stays with its holder; an ended linger is taken
 * over. Keys are inserted in ascending order: no deadlocks between claims.
 * @param {Executor} executor
 * @param {string} p
 * @param {{ id: string, mutexKeys: readonly string[] }[]} jobs The picked keyed jobs: their keys are distinct.
 * @param {string} lockToken
 * @returns {Promise<Set<string>>} The ids of the jobs that got all their keys.
 */
async function takeKeys(executor, p, jobs, lockToken) {
    const holds = jobs
        .flatMap(job => job.mutexKeys.map(key => ({ key, id: job.id })))
        .toSorted((a, b) => (a.key < b.key ? -1 : 1));
    const keys = holds.map(hold => hold.key);
    // held_until last: MySQL sets the columns from left to right, and the others read its old value
    /**
     * @param {string} column
     * @returns {string} Takes the new value over an ended linger.
     */
    const takeOver = column => `${column} = IF(${p}mutexes.held_until < ${NOW}, new.${column}, ${p}mutexes.${column})`;

    await executor.query(`
        INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
        VALUES ${holds.map(() => `(?, ?, ?, NULL, ${NOW})`).join(', ')} AS new
        ON DUPLICATE KEY UPDATE ${takeOver('job_id')}, ${takeOver('lock_token')}, ${takeOver('created_at')},
            held_until = IF(${p}mutexes.held_until < ${NOW}, NULL, ${p}mutexes.held_until)
    `, holds.flatMap(hold => [hold.key, hold.id, lockToken]));

    const acquired = new Set((await executor.query(`
        SELECT mutex_key FROM ${p}mutexes WHERE mutex_key IN (${placeholders(keys.length)}) AND lock_token = ?
    `, [...keys, lockToken])).map(row => String(row.mutex_key)));
    const withAllKeys = new Set(jobs.filter(job => job.mutexKeys.every(key => acquired.has(key))).map(job => job.id));
    const partial = holds.filter(hold => !withAllKeys.has(hold.id) && acquired.has(hold.key));

    if (partial.length) {
        await executor.query(`
            DELETE FROM ${p}mutexes WHERE mutex_key IN (${placeholders(partial.length)}) AND lock_token = ?
        `, [...partial.map(hold => hold.key), lockToken]);
    }

    return withAllKeys;
}

/**
 * Claims due jobs among the candidates. Call it in a queue transaction.
 * @param {Executor} executor
 * @param {string} p
 * @param {ClaimParams} params
 * @returns {Promise<ClaimedJob[]>} In the order of run_at.
 */
export async function claim(executor, p, { candidateIds, lockToken, lockedBy, leaseMs, pick }) {
    if (!candidateIds.length) {
        return [];
    }

    const lockedRows = (await executor.query(`
        SELECT id, job_name, CAST(mutex_keys AS CHAR) AS mutex_keys, attempts, max_attempts, stalls, max_stalls,
               failure_job, ${epochMs('created_at')} AS created_at_ms,
               TIMESTAMPDIFF(MICROSECOND, run_at, ${NOW}) DIV 1000 AS waited_ms
          FROM ${p}jobs
         WHERE id IN (${placeholders(candidateIds.length)}) AND status = 'pending' AND run_at <= ${NOW}
         ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
    `, candidateIds)).map(row => ({
        id: String(row.id),
        name: String(row.job_name),
        mutexKeys: parseKeys(row.mutex_keys),
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        stalls: Number(row.stalls),
        maxStalls: Number(row.max_stalls),
        failureJob: row.failure_job === null ? null : String(row.failure_job),
        enqueuedAt: new Date(Number(row.created_at_ms)),
        waitedMs: Number(row.waited_ms),
        lockToken,
    }));
    const lockedKeys = [...new Set(lockedRows.flatMap(row => row.mutexKeys))];
    const busyKeys = lockedKeys.length
        ? new Set((await executor.query(`
            SELECT m.mutex_key FROM ${p}mutexes m WHERE m.mutex_key IN (${placeholders(lockedKeys.length)}) AND ${HELD}
        `, lockedKeys)).map(row => String(row.mutex_key)))
        : new Set();
    const picked = pick(lockedRows, busyKeys);
    const keyedPicked = picked.filter(row => row.mutexKeys.length);
    const withKeys = keyedPicked.length ? await takeKeys(executor, p, keyedPicked, lockToken) : new Set();
    const claimed = picked.filter(row => !row.mutexKeys.length || withKeys.has(row.id));

    if (claimed.length) {
        await executor.query(`
            UPDATE ${p}jobs
               SET status = 'running', lock_token = ?, locked_by = ?,
                   locked_until = ${NOW} + INTERVAL ? MICROSECOND, started_at = ${NOW}, timed_out_at = NULL,
                   updated_at = ${NOW}
             WHERE id IN (${placeholders(claimed.length)})
        `, [lockToken, lockedBy, leaseMs * 1000, ...claimed.map(row => row.id)]);
    }

    return claimed;
}

/**
 * Finds, claims and reads the due jobs of names without mutex keys. Call it in a queue transaction. One statement
 * locks the oldest due jobs of each name that no other claim holds (SKIP LOCKED), with their payloads; the ones that
 * fit the free slots (`fitSlots`) are claimed.
 * @param {Executor} executor
 * @param {string} p
 * @param {import('./store.js').ClaimDueParams} params
 * @returns {Promise<import('./store.js').StartableJob[]>} In the order of run_at.
 */
export async function claimDue(executor, p, { requests, laneFree, processMax, lockToken, lockedBy, leaseMs }) {
    if (!requests.length || processMax <= 0) {
        return [];
    }

    const locked = (await executor.query(requests.map(() => `(
        SELECT j.id, j.job_name, ${epochMs('j.run_at')} AS run_at_ms, j.attempts, j.max_attempts, j.stalls,
               j.max_stalls, j.failure_job, ${epochMs('j.created_at')} AS created_at_ms,
               TIMESTAMPDIFF(MICROSECOND, j.run_at, ${NOW}) DIV 1000 AS waited_ms,
               CAST(pl.payload AS CHAR) AS payload, pl.id IS NOT NULL AS payload_found
          FROM ${p}jobs j FORCE INDEX (${p}jobs_status_name_run_at)
          LEFT JOIN ${p}payloads pl ON pl.id = j.id
         WHERE j.status = 'pending' AND j.job_name = ? AND j.run_at <= ${NOW}
         ORDER BY j.run_at, j.id LIMIT ?
           FOR UPDATE OF j SKIP LOCKED
    )`).join(' UNION ALL '), requests.flatMap(request => [request.name, request.maxJobs])))
        .map(row => ({
            runAtMs: Number(row.run_at_ms),
            /** @type {import('./store.js').StartableJob} */
            job: {
                id: String(row.id),
                name: String(row.job_name),
                mutexKeys: [],
                attempts: Number(row.attempts),
                maxAttempts: Number(row.max_attempts),
                stalls: Number(row.stalls),
                maxStalls: Number(row.max_stalls),
                failureJob: row.failure_job === null ? null : String(row.failure_job),
                enqueuedAt: new Date(Number(row.created_at_ms)),
                waitedMs: Number(row.waited_ms),
                lockToken,
                payload: Number(row.payload_found)
                    ? { found: true, payload: JSON.parse(String(row.payload)) }
                    : { found: false, payload: undefined },
            },
        }))
        .toSorted((a, b) => a.runAtMs - b.runAtMs || (a.job.id < b.job.id ? -1 : 1))
        .map(({ job }) => job);
    const picked = fitSlots(locked, requests, laneFree, processMax);

    if (picked.length) {
        await executor.query(`
            UPDATE ${p}jobs
               SET status = 'running', lock_token = ?, locked_by = ?,
                   locked_until = ${NOW} + INTERVAL ? MICROSECOND, started_at = ${NOW}, timed_out_at = NULL,
                   updated_at = ${NOW}
             WHERE id IN (${placeholders(picked.length)})
        `, [lockToken, lockedBy, leaseMs * 1000, ...picked.map(job => job.id)]);
    }

    return picked;
}

/**
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} ids
 * @returns {Promise<Map<string, unknown>>} The payloads by job id, as JSON gives them back.
 */
export async function readPayloads(executor, p, ids) {
    if (!ids.length) {
        return new Map();
    }

    const rows = await executor.query(`
        SELECT id, CAST(payload AS CHAR) AS payload FROM ${p}payloads WHERE id IN (${placeholders(ids.length)})
    `, ids);

    return new Map(rows.map(row => [String(row.id), JSON.parse(String(row.payload))]));
}
