// The worker side of the store on MariaDB: probe, candidates, claim. Times are computed in SQL, in UTC. A copy of the
// MySQL version, changed where MariaDB differs: keep the two in step.

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').ProbeRow} ProbeRow */
/** @typedef {import('./store.js').Candidate} Candidate */
/** @typedef {import('./store.js').ClaimParams} ClaimParams */
/** @typedef {import('./store.js').ClaimedJob} ClaimedJob */

/** The due jobs of each name with mutex keys that the FIFO of the mutex keys reads */
export const MUTEX_WINDOW_SIZE = 500;

const NOW = 'UTC_TIMESTAMP(3)';
// The writes by a list of keys force the index: on a small table, MariaDB scans the whole table instead, and waits for
// the rows that other claims hold (a deadlock). The DELETE of several rows uses the multi-table form, which takes
// hints.
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
 * The SQL of the probe. `GROUP BY status, job_name`: the whole index prefix, else MariaDB does not use a loose index
 * scan.
 * @param {string} p
 * @param {number} [nameCount] The names of the probe, as parameters; none: all names.
 * @returns {string}
 */
export function probeSql(p, nameCount = 0) {
    const names = nameCount ? ` AND job_name IN (${Array.from({ length: nameCount }, () => '?').join(', ')})` : '';

    return `
        SELECT job_name, TIMESTAMPDIFF(MICROSECOND, ${NOW}, MIN(run_at)) DIV 1000 AS delay_ms
          FROM ${p}jobs FORCE INDEX (${p}jobs_status_name_run_at)
         WHERE status = 'pending'${names}
         GROUP BY status, job_name
    `;
}

/** Above it, the probe reads all names: a long list of names makes a slow range plan */
const MAX_PROBE_NAMES = 100;

/**
 * The next due time of each given job name with pending jobs; null, or many names: of each job name. One index dive
 * per name (loose index scan).
 * @param {Executor} executor
 * @param {string} p
 * @param {string[] | null} names
 * @returns {Promise<ProbeRow[]>}
 */
export async function probe(executor, p, names) {
    if (names && !names.length) {
        return [];
    }

    const some = names && names.length <= MAX_PROBE_NAMES ? names : [];
    const rows = await executor.query(probeSql(p, some.length), some);

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
 * @param {string} p
 * @param {number} nameCount The names with mutex keys, as parameters.
 * @returns {string} The oldest due job with the key `f.mutex_key` among the names with mutex keys: one range of
 *     the job_keys, read in order up to the first job of such a name.
 */
const headSql = (p, nameCount) => `(
                SELECT jk.job_id FROM ${p}job_keys jk
                 WHERE jk.mutex_key = f.mutex_key AND jk.run_at <= ${NOW}
                   AND jk.job_name IN (${placeholders(nameCount)})
                 ORDER BY jk.run_at, jk.job_id LIMIT 1
            )`;

/**
 * The names whose jobs may start after a release of the keys: of the oldest due job of each key.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} keys
 * @param {string[]} namesWithKeys The handled names whose definition has mutex keys.
 * @returns {Promise<string[]>}
 */
export async function namesWaitingFor(executor, p, keys, namesWithKeys) {
    if (!keys.length || !namesWithKeys.length) {
        return [];
    }

    const rows = await executor.query(`
        SELECT DISTINCT j.job_name FROM (
            SELECT ${headSql(p, namesWithKeys.length)} AS id
              FROM JSON_TABLE(?, '$[*]' COLUMNS (
                  mutex_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PATH '$'
              )) AS f
        ) AS head JOIN ${p}jobs j ON j.id = head.id
    `, [...namesWithKeys, JSON.stringify(keys)]);

    return rows.map(row => String(row.job_name));
}

/**
 * The due jobs that can start now, oldest first: at most `limit` of each name. A job of a name with mutex keys waits
 * if one of its keys is held, or an older due job of such a name has it (FIFO per key, from the job_keys).
 * @param {Executor} executor
 * @param {string} p
 * @param {Map<string, number>} limitsByName
 * @param {string[]} namesWithKeys The handled names whose definition has mutex keys.
 * @returns {Promise<Candidate[]>}
 */
export async function findCandidates(executor, p, limitsByName, namesWithKeys) {
    const hasKeys = new Set(namesWithKeys);
    const plainNames = [...limitsByName.keys()].filter(name => !hasKeys.has(name));
    const requestedWithKeys = [...limitsByName.keys()].filter(name => hasKeys.has(name));
    /** @type {Record<string, unknown>[]} */
    const rows = [];

    if (plainNames.length) {
        rows.push(...await executor.query(`
            SELECT id, job_name, ${epochMs('run_at')} AS run_at_ms
              FROM (${dueJobsSql(p, plainNames, () => '?')}) AS due
        `, plainNames.flatMap(name => [name, limitsByName.get(name)])));
    }

    if (requestedWithKeys.length) {
        const conditions = requestedWithKeys.map(() => '(job_name = ? AND name_rank <= ?)').join(' OR ');

        rows.push(...await executor.query(`
            WITH w AS (${dueJobsSql(p, requestedWithKeys, () => String(MUTEX_WINDOW_SIZE))}),
            wk AS (
                SELECT w.id, k.mutex_key FROM w, JSON_TABLE(w.mutex_keys, '$[*]' COLUMNS (
                    mutex_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PATH '$'
                )) AS k
            ),
            heads AS (
                SELECT f.mutex_key, ${headSql(p, namesWithKeys.length)} AS id
                  FROM (SELECT DISTINCT mutex_key FROM wk) AS f
                 WHERE NOT EXISTS (SELECT 1 FROM ${p}mutexes m WHERE m.mutex_key = f.mutex_key AND ${HELD})
            ),
            eligible AS (
                SELECT w.id, w.job_name, w.run_at,
                       ROW_NUMBER() OVER (PARTITION BY w.job_name ORDER BY w.run_at, w.id) AS name_rank
                  FROM w
                 WHERE NOT EXISTS (
                     SELECT 1 FROM wk WHERE wk.id = w.id
                        AND NOT EXISTS (SELECT 1 FROM heads h WHERE h.mutex_key = wk.mutex_key AND h.id = w.id)
                 )
            )
            SELECT id, job_name, ${epochMs('run_at')} AS run_at_ms FROM eligible WHERE ${conditions}
        `, [
            ...requestedWithKeys,
            ...namesWithKeys,
            ...requestedWithKeys.flatMap(name => [name, limitsByName.get(name)]),
        ]));
    }

    return rows
        .map(row => ({ id: String(row.id), name: String(row.job_name), runAtMs: Number(row.run_at_ms) }))
        .toSorted((a, b) => a.runAtMs - b.runAtMs || (a.id < b.id ? -1 : 1));
}

/**
 * Deletes the job_keys of claimed jobs: they are not pending. Call it in the claim transaction.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} ids The claimed jobs with keys.
 * @returns {Promise<void>}
 */
async function unkey(executor, p, ids) {
    if (ids.length) {
        await executor.run(`DELETE FROM ${p}job_keys WHERE job_id IN (${placeholders(ids.length)})`, ids);
    }
}

/**
 * Takes the keys of the picked jobs, all or none per job. A held key stays with its holder; an ended linger is taken
 * over. Keys are inserted in ascending order: no deadlocks between claims.
 * @param {Executor} executor
 * @param {string} p
 * @param {{ id: string, mutexKeys: readonly string[] }[]} jobs The picked jobs with mutex keys: their keys are
 *     distinct.
 * @param {string} lockToken
 * @returns {Promise<Set<string>>} The ids of the jobs that got all their keys.
 */
async function takeKeys(executor, p, jobs, lockToken) {
    const holds = jobs
        .flatMap(job => job.mutexKeys.map(key => ({ key, id: job.id })))
        .toSorted((a, b) => (a.key < b.key ? -1 : 1));
    const keys = holds.map(hold => hold.key);
    // held_until last: MariaDB sets the columns from left to right, and the others read its old value
    /**
     * @param {string} column
     * @returns {string} Takes the new value over an ended linger.
     */
    const takeOver = column => `${column} = IF(${p}mutexes.held_until < ${NOW}, VALUES(${column}), ${p}mutexes.${column})`;

    await executor.query(`
        INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
        VALUES ${holds.map(() => `(?, ?, ?, NULL, ${NOW})`).join(', ')}
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
            DELETE m FROM ${p}mutexes m FORCE INDEX (PRIMARY)
             WHERE m.mutex_key IN (${placeholders(partial.length)}) AND m.lock_token = ?
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
    const pickedWithKeys = picked.filter(row => row.mutexKeys.length);
    const withKeys = pickedWithKeys.length ? await takeKeys(executor, p, pickedWithKeys, lockToken) : new Set();
    const claimed = picked.filter(row => !row.mutexKeys.length || withKeys.has(row.id));

    if (claimed.length) {
        await executor.query(`
            UPDATE ${p}jobs FORCE INDEX (PRIMARY)
               SET status = 'running', lock_token = ?, locked_by = ?,
                   locked_until = ${NOW} + INTERVAL ? MICROSECOND, started_at = ${NOW}, timed_out_at = NULL,
                   updated_at = ${NOW}
             WHERE id IN (${placeholders(claimed.length)})
        `, [lockToken, lockedBy, leaseMs * 1000, ...claimed.map(row => row.id)]);
        await unkey(executor, p, claimed.filter(row => row.mutexKeys.length).map(row => row.id));
    }

    return claimed;
}

/**
 * Finds, claims and reads the due jobs of names without mutex keys. Call it in a queue transaction. One statement
 * locks the oldest due jobs of each name that no other claim holds (SKIP LOCKED), with their payloads; the ones that
 * the choice by share takes (`choose`) are claimed. A second read gets the payloads that the statement did not see.
 * @param {Executor} executor
 * @param {string} p
 * @param {import('./store.js').ClaimDueParams} params
 * @returns {Promise<import('./store.js').ClaimDueResult>} The jobs in the order of run_at.
 */
export async function claimDue(executor, p, { requests, free, lockToken, lockedBy, leaseMs, choose }) {
    if (!requests.length || free <= 0) {
        return { jobs: [], next: [] };
    }

    const locked = (await executor.query(requests.map(() => `(
        SELECT j.id, j.job_name, ${epochMs('j.run_at')} AS run_at_ms, j.attempts, j.max_attempts, j.stalls,
               j.max_stalls, j.failure_job, ${epochMs('j.created_at')} AS created_at_ms, j.mutex_keys IS NOT NULL AS has_keys,
               TIMESTAMPDIFF(MICROSECOND, j.run_at, ${NOW}) DIV 1000 AS waited_ms,
               -- A subquery, not a join: MariaDB has no FOR UPDATE OF, so a join would lock the payload row too
               (SELECT CAST(pl.payload AS CHAR) FROM ${p}payloads pl WHERE pl.id = j.id) AS payload
          FROM ${p}jobs j FORCE INDEX (${p}jobs_status_name_run_at)
         WHERE j.status = 'pending' AND j.job_name = ? AND j.run_at <= ${NOW}
         ORDER BY j.run_at, j.id LIMIT ?
           FOR UPDATE SKIP LOCKED
    )`).join(' UNION ALL '), requests.flatMap(request => [request.name, request.maxJobs])))
        .map(row => ({
            runAtMs: Number(row.run_at_ms),
            hasKeys: Boolean(Number(row.has_keys)),
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
                // payload is NOT NULL: a null is a missing payload row
                payload: row.payload !== null
                    ? { found: true, payload: JSON.parse(String(row.payload)) }
                    : { found: false, payload: undefined },
            },
        }))
        .toSorted((a, b) => a.runAtMs - b.runAtMs || (a.job.id < b.job.id ? -1 : 1));
    const idsWithKeys = new Set(locked.filter(row => row.hasKeys).map(row => row.job.id));
    // The choice by share, among the locked rows
    const picked = choose(locked.map(({ job }) => job));
    // The payload subquery is a consistent read, from the read view of the statement's first one: a job whose enqueue
    // committed later in the statement is locked without its payload. A new statement (READ COMMITTED) sees it
    const unseen = picked.filter(job => !job.payload.found).map(job => job.id);

    if (unseen.length) {
        const payloads = await readPayloads(executor, p, unseen);

        for (const job of picked) {
            if (payloads.has(job.id)) {
                job.payload = { found: true, payload: payloads.get(job.id) };
            }
        }
    }

    if (picked.length) {
        await executor.query(`
            UPDATE ${p}jobs FORCE INDEX (PRIMARY)
               SET status = 'running', lock_token = ?, locked_by = ?,
                   locked_until = ${NOW} + INTERVAL ? MICROSECOND, started_at = ${NOW}, timed_out_at = NULL,
                   updated_at = ${NOW}
             WHERE id IN (${placeholders(picked.length)})
        `, [lockToken, lockedBy, leaseMs * 1000, ...picked.map(job => job.id)]);
        // A job with keys of a name without them: its keys are not taken, its job_keys go
        await unkey(executor, p, picked.filter(job => idsWithKeys.has(job.id)).map(job => job.id));
    }

    // In the transaction: the claimed jobs are running
    // A full claim: the next turn claims again; the next due times only after a claim that took fewer
    return {
        jobs: picked,
        next: picked.length >= free ? null : await probe(executor, p, requests.map(request => request.name)),
    };
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
