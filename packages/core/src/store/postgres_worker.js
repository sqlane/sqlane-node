// The worker side of the store on PostgreSQL: probe, candidates, claim. Times are computed in SQL.

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').ProbeRow} ProbeRow */
/** @typedef {import('./store.js').Candidate} Candidate */
/** @typedef {import('./store.js').ClaimParams} ClaimParams */
/** @typedef {import('./store.js').ClaimedJob} ClaimedJob */

/** The due jobs of each keyed name that the FIFO of the mutex keys reads */
export const MUTEX_WINDOW_SIZE = 500;

/**
 * @param {string} column
 * @returns {string} The epoch milliseconds of a time column.
 */
const epochMs = column => `(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`;
const HELD = '(m.held_until IS NULL OR m.held_until >= clock_timestamp())';

/**
 * The next due time of each job name with pending jobs. PostgreSQL has no loose index scan: a recursive CTE skips from
 * one pending name to the next on the partial index, two index probes per pending name.
 * @param {Executor} executor
 * @param {string} p
 * @returns {Promise<ProbeRow[]>}
 */
export async function probe(executor, p) {
    const rows = await executor.query(`
        WITH RECURSIVE names AS (
            (SELECT job_name FROM ${p}jobs WHERE status = 'pending' ORDER BY job_name LIMIT 1)
            UNION ALL
            SELECT (
                SELECT j.job_name FROM ${p}jobs j
                 WHERE j.status = 'pending' AND j.job_name > names.job_name ORDER BY j.job_name LIMIT 1
            ) FROM names WHERE names.job_name IS NOT NULL
        )
        SELECT names.job_name,
               (EXTRACT(EPOCH FROM (
                   SELECT j.run_at FROM ${p}jobs j
                    WHERE j.status = 'pending' AND j.job_name = names.job_name ORDER BY j.run_at LIMIT 1
               ) - clock_timestamp()) * 1000)::bigint AS delay_ms
          FROM names WHERE names.job_name IS NOT NULL
    `, []);

    return rows.map(row => ({ name: String(row.job_name), delayMs: Number(row.delay_ms) }));
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
            SELECT due.id, due.job_name, ${epochMs('due.run_at')} AS run_at_ms
              FROM unnest($1::text[], $2::integer[]) AS request(name, max_jobs)
             CROSS JOIN LATERAL (
                 SELECT id, job_name, run_at FROM ${p}jobs
                  WHERE status = 'pending' AND job_name = request.name AND run_at <= clock_timestamp()
                  ORDER BY run_at, id LIMIT request.max_jobs
             ) AS due
        `, [plainNames, plainNames.map(name => limitsByName.get(name))]));
    }

    if (keyedRequested.length) {
        rows.push(...await executor.query(`
            WITH w AS (
                SELECT due.* FROM unnest($1::text[]) AS keyed(name)
                 CROSS JOIN LATERAL (
                     SELECT id, job_name, run_at, mutex_keys FROM ${p}jobs
                      WHERE status = 'pending' AND job_name = keyed.name AND run_at <= clock_timestamp()
                      ORDER BY run_at, id LIMIT ${MUTEX_WINDOW_SIZE}
                 ) AS due
            ),
            wk AS (
                SELECT w.id, k.mutex_key,
                       ROW_NUMBER() OVER (PARTITION BY k.mutex_key ORDER BY w.run_at, w.id) AS key_rank
                  FROM w CROSS JOIN LATERAL unnest(w.mutex_keys) AS k(mutex_key)
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
            SELECT e.id, e.job_name, ${epochMs('e.run_at')} AS run_at_ms
              FROM eligible e JOIN unnest($2::text[], $3::integer[]) AS request(name, max_jobs)
                ON request.name = e.job_name AND e.name_rank <= request.max_jobs
        `, [keyedNames, keyedRequested, keyedRequested.map(name => limitsByName.get(name))]));
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
    const acquired = new Set((await executor.query(`
        INSERT INTO ${p}mutexes AS m (mutex_key, job_id, lock_token, held_until, created_at)
        SELECT hold.mutex_key, hold.job_id, $3, NULL, clock_timestamp()
          FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS hold(mutex_key, job_id, position)
         ORDER BY hold.position
        ON CONFLICT (mutex_key) DO UPDATE
           SET job_id = EXCLUDED.job_id, lock_token = EXCLUDED.lock_token, held_until = NULL,
               created_at = EXCLUDED.created_at
         WHERE m.held_until < clock_timestamp()
        RETURNING m.mutex_key
    `, [holds.map(hold => hold.key), holds.map(hold => hold.id), lockToken])).map(row => String(row.mutex_key)));
    const withAllKeys = new Set(jobs.filter(job => job.mutexKeys.every(key => acquired.has(key))).map(job => job.id));
    const partial = holds.filter(hold => !withAllKeys.has(hold.id) && acquired.has(hold.key));

    if (partial.length) {
        await executor.query(`DELETE FROM ${p}mutexes WHERE mutex_key = ANY($1::text[]) AND lock_token = $2`, [
            partial.map(hold => hold.key),
            lockToken,
        ]);
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
        SELECT id, job_name, array_to_json(mutex_keys)::text AS mutex_keys, attempts, max_attempts, stalls,
               max_stalls, failure_job, ${epochMs('created_at')} AS created_at_ms,
               (EXTRACT(EPOCH FROM clock_timestamp() - run_at) * 1000)::bigint AS waited_ms
          FROM ${p}jobs
         WHERE id = ANY($1::text[]) AND status = 'pending' AND run_at <= clock_timestamp()
         ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
    `, [candidateIds])).map(row => ({
        id: String(row.id),
        name: String(row.job_name),
        mutexKeys: row.mutex_keys === null ? [] : JSON.parse(String(row.mutex_keys)),
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
            SELECT m.mutex_key FROM ${p}mutexes m WHERE m.mutex_key = ANY($1::text[]) AND ${HELD}
        `, [lockedKeys])).map(row => String(row.mutex_key)))
        : new Set();
    const picked = pick(lockedRows, busyKeys);
    const keyedPicked = picked.filter(row => row.mutexKeys.length);
    const withKeys = keyedPicked.length ? await takeKeys(executor, p, keyedPicked, lockToken) : new Set();
    const claimed = picked.filter(row => !row.mutexKeys.length || withKeys.has(row.id));

    if (claimed.length) {
        await executor.query(`
            UPDATE ${p}jobs
               SET status = 'running', lock_token = $2, locked_by = $3,
                   locked_until = clock_timestamp() + $4 * interval '1 millisecond', started_at = clock_timestamp(),
                   timed_out_at = NULL, updated_at = clock_timestamp()
             WHERE id = ANY($1::text[])
        `, [claimed.map(row => row.id), lockToken, lockedBy, leaseMs]);
    }

    return claimed;
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
        SELECT id, payload::text AS payload FROM ${p}payloads WHERE id = ANY($1::text[])
    `, [ids]);

    return new Map(rows.map(row => [String(row.id), JSON.parse(String(row.payload))]));
}
