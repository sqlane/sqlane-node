// The worker side of the store on PostgreSQL: probe, candidates, claim. Times are computed in SQL.

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').ProbeRow} ProbeRow */
/** @typedef {import('./store.js').Candidate} Candidate */
/** @typedef {import('./store.js').ClaimParams} ClaimParams */
/** @typedef {import('./store.js').ClaimedJob} ClaimedJob */

/** The due jobs of each name with mutex keys that the FIFO of the mutex keys reads */
export const MUTEX_WINDOW_SIZE = 500;
/** The first due jobs of a key among which the FIFO finds the oldest of a name with mutex keys */
export const KEY_WINDOW_SIZE = 100;

/**
 * @param {string} column
 * @returns {string} The epoch milliseconds of a time column.
 */
const epochMs = column => `(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`;
const HELD = '(m.held_until IS NULL OR m.held_until >= clock_timestamp())';

/**
 * The next due time of each given job name with pending jobs: one index probe per name.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} names
 * @returns {Promise<ProbeRow[]>}
 */
async function probeNames(executor, p, names) {
    const rows = await executor.query(`
        SELECT request.name AS job_name,
               (EXTRACT(EPOCH FROM next.run_at - clock_timestamp()) * 1000)::bigint AS delay_ms
          FROM unnest($1::text[]) AS request(name)
         CROSS JOIN LATERAL (
             SELECT run_at FROM ${p}jobs
              WHERE status = 'pending' AND job_name = request.name ORDER BY run_at LIMIT 1
         ) AS next
    `, [names]);

    return rows.map(row => ({ name: String(row.job_name), delayMs: Number(row.delay_ms) }));
}

/**
 * The next due time of each given job name with pending jobs; null: of each job name. PostgreSQL has no loose index
 * scan: for all names, a recursive CTE skips from one pending name to the next on the partial index, two index probes
 * per pending name.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[] | null} names
 * @returns {Promise<ProbeRow[]>}
 */
export async function probe(executor, p, names) {
    if (names) {
        return names.length ? probeNames(executor, p, names) : [];
    }

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
 * @param {string} p
 * @param {string} key The SQL of a mutex key.
 * @param {string} namesWithKeys The SQL of the names with mutex keys.
 * @returns {string} The oldest due job with the key among the names with mutex keys, within the first due jobs of
 *     the key. They are one range of the job_keys, with index conditions only (statement_timestamp() is stable,
 *     clock_timestamp() is not): the plan reads them in order, whatever the statistics. Then the names: a subquery,
 *     read once; `= ANY($n)` costs a custom plan an estimate per name.
 */
function headSql(p, key, namesWithKeys) {
    return `
        SELECT h.id, h.job_name FROM (
            SELECT jk.job_id AS id, jk.job_name, jk.run_at FROM ${p}job_keys jk
             WHERE jk.mutex_key = ${key} AND jk.run_at <= statement_timestamp()
             ORDER BY jk.run_at, jk.job_id LIMIT ${KEY_WINDOW_SIZE}
        ) AS h
         WHERE h.job_name = ANY((SELECT ${namesWithKeys}::text[])::text[])
         ORDER BY h.run_at, h.id LIMIT 1`;
}

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
        SELECT DISTINCT head.job_name
          FROM unnest($1::text[]) AS freed(mutex_key)
         CROSS JOIN LATERAL (${headSql(p, 'freed.mutex_key', '$2')}) AS head
    `, [keys, namesWithKeys]);

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
            SELECT due.id, due.job_name, ${epochMs('due.run_at')} AS run_at_ms
              FROM unnest($1::text[], $2::integer[]) AS request(name, max_jobs)
             CROSS JOIN LATERAL (
                 SELECT id, job_name, run_at FROM ${p}jobs
                  WHERE status = 'pending' AND job_name = request.name AND run_at <= clock_timestamp()
                  ORDER BY run_at, id LIMIT request.max_jobs
             ) AS due
        `, [plainNames, plainNames.map(name => limitsByName.get(name))]));
    }

    if (requestedWithKeys.length) {
        rows.push(...await executor.query(`
            WITH request AS (
                SELECT * FROM unnest($1::text[], $2::integer[]) AS request(name, max_jobs)
            ),
            w AS (
                SELECT due.* FROM request
                 CROSS JOIN LATERAL (
                     SELECT id, job_name, run_at, mutex_keys FROM ${p}jobs
                      WHERE status = 'pending' AND job_name = request.name AND run_at <= clock_timestamp()
                      ORDER BY run_at, id LIMIT ${MUTEX_WINDOW_SIZE}
                 ) AS due
            ),
            wk AS (
                SELECT w.id, k.mutex_key FROM w CROSS JOIN LATERAL unnest(w.mutex_keys) AS k(mutex_key)
            ),
            free_keys AS MATERIALIZED (
                SELECT DISTINCT wk.mutex_key FROM wk
                 WHERE NOT EXISTS (SELECT 1 FROM ${p}mutexes m WHERE m.mutex_key = wk.mutex_key AND ${HELD})
            ),
            heads AS (
                SELECT free_keys.mutex_key, head.id
                  FROM free_keys CROSS JOIN LATERAL (${headSql(p, 'free_keys.mutex_key', '$3')}) AS head
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
            SELECT e.id, e.job_name, ${epochMs('e.run_at')} AS run_at_ms
              FROM eligible e JOIN request ON request.name = e.job_name AND e.name_rank <= request.max_jobs
        `, [requestedWithKeys, requestedWithKeys.map(name => limitsByName.get(name)), namesWithKeys]));
    }

    return rows
        .map(row => ({ id: String(row.id), name: String(row.job_name), runAtMs: Number(row.run_at_ms) }))
        .toSorted((a, b) => a.runAtMs - b.runAtMs || (a.id < b.id ? -1 : 1));
}

/**
 * @param {string} p
 * @returns {string} The CTE that deletes the job_keys of the jobs with mutex keys of the CTE `claimed`: they are not
 *     pending.
 */
function unkeyClaimed(p) {
    return `dropped_job_keys AS (
            DELETE FROM ${p}job_keys jk USING claimed c WHERE c.has_keys AND jk.job_id = c.id
        )`;
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
    const pickedWithKeys = picked.filter(row => row.mutexKeys.length);
    const withKeys = pickedWithKeys.length ? await takeKeys(executor, p, pickedWithKeys, lockToken) : new Set();
    const claimed = picked.filter(row => !row.mutexKeys.length || withKeys.has(row.id));

    if (claimed.length) {
        await executor.query(`
            WITH running AS (
                UPDATE ${p}jobs
                   SET status = 'running', lock_token = $2, locked_by = $3,
                       locked_until = clock_timestamp() + $4 * interval '1 millisecond', started_at = clock_timestamp(),
                       timed_out_at = NULL, updated_at = clock_timestamp()
                 WHERE id = ANY($1::text[])
                RETURNING id
            )
            DELETE FROM ${p}job_keys WHERE job_id IN (SELECT id FROM running)
        `, [claimed.map(row => row.id), lockToken, lockedBy, leaseMs]);
    }

    return claimed;
}

/**
 * @param {string} p
 * @returns {string} The jobs of the CTE `claimed`, with their payloads, as a JSON text: oldest first.
 */
function claimedJobsJson(p) {
    return `(
        SELECT json_agg(json_build_object(
                   'id', c.id, 'name', c.job_name, 'attempts', c.attempts,
                   'maxAttempts', c.max_attempts, 'stalls', c.stalls, 'maxStalls', c.max_stalls,
                   'failureJob', c.failure_job, 'createdAtMs', c.created_at_ms, 'waitedMs', c.waited_ms,
                   'found', pl.id IS NOT NULL, 'payload', pl.payload
               ) ORDER BY c.run_at, c.id)
          FROM claimed c LEFT JOIN ${p}payloads pl ON pl.id = c.id
    )::text`;
}

/**
 * @param {unknown} json The text of `claimedJobsJson`: null for none.
 * @param {string} lockToken
 * @returns {import('./store.js').StartableJob[]}
 */
function parseClaimedJobs(json, lockToken) {
    /** @type {{ id: string, name: string, attempts: number, maxAttempts: number, stalls: number, maxStalls: number,
     *     failureJob: string | null, createdAtMs: number, waitedMs: number, found: boolean, payload: unknown }[]} */
    const jobs = (json ?? null) === null ? [] : JSON.parse(String(json));

    return jobs.map(job => ({
        id: job.id,
        name: job.name,
        mutexKeys: [],
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        stalls: job.stalls,
        maxStalls: job.maxStalls,
        failureJob: job.failureJob,
        enqueuedAt: new Date(job.createdAtMs),
        waitedMs: job.waitedMs,
        lockToken,
        payload: job.found ? { found: true, payload: job.payload } : { found: false, payload: undefined },
    }));
}

/**
 * Finds, claims and reads the due jobs of names without mutex keys, in one statement (a transaction of its own): the
 * oldest due jobs of each name that no other claim holds (SKIP LOCKED), within the free slots of their lanes and of
 * the process (as `fitSlots`), with their payloads. Then the next due time of each requested name, among its pending
 * jobs that this claim did not take.
 * @param {Executor} executor Outside a transaction.
 * @param {string} p
 * @param {import('./store.js').ClaimDueParams} params
 * @returns {Promise<import('./store.js').ClaimDueResult>} The jobs in the order of run_at.
 */
export async function claimDue(executor, p, { requests, laneFree, processMax, lockToken, lockedBy, leaseMs }) {
    if (!requests.length || processMax <= 0) {
        return { jobs: [], next: [] };
    }

    if (requests.length === 1) {
        const [{ name, maxJobs, lane }] = requests;

        return claimDueOfName(executor, p, {
            name,
            limit: Math.min(maxJobs, laneFree[lane], processMax),
            lockToken,
            lockedBy,
            leaseMs,
        });
    }

    // One row: the claimed jobs and the next due times, as JSON texts
    const [row] = await executor.query(`
        WITH locked AS (
            SELECT due.id, due.run_at, request.lane
              FROM unnest($1::text[], $2::integer[], $3::integer[]) AS request(name, max_jobs, lane)
             CROSS JOIN LATERAL (
                 SELECT id, run_at FROM ${p}jobs
                  WHERE status = 'pending' AND job_name = request.name AND run_at <= clock_timestamp()
                  ORDER BY run_at, id LIMIT request.max_jobs
                    FOR UPDATE SKIP LOCKED
             ) AS due
        ),
        in_lanes AS (
            SELECT id, run_at, lane,
                   ROW_NUMBER() OVER (PARTITION BY lane ORDER BY run_at, id) AS lane_rank
              FROM locked
        ),
        picked AS (
            SELECT id FROM in_lanes WHERE lane_rank <= ($4::integer[])[lane + 1] ORDER BY run_at, id LIMIT $5
        ),
        claimed AS (
            UPDATE ${p}jobs AS j
               SET status = 'running', lock_token = $6, locked_by = $7,
                   locked_until = clock_timestamp() + $8 * interval '1 millisecond', started_at = clock_timestamp(),
                   timed_out_at = NULL, updated_at = clock_timestamp()
              FROM picked
             WHERE j.id = picked.id
            RETURNING j.id, j.job_name, j.run_at, j.attempts, j.max_attempts, j.stalls, j.max_stalls, j.failure_job,
                      ${epochMs('j.created_at')} AS created_at_ms,
                      (EXTRACT(EPOCH FROM clock_timestamp() - j.run_at) * 1000)::bigint AS waited_ms,
                      j.mutex_keys IS NOT NULL AS has_keys
        ),
        ${unkeyClaimed(p)},
        -- The statement's snapshot: the picked jobs are still pending in it
        next AS (
            SELECT request.name AS job_name,
                   (EXTRACT(EPOCH FROM n.run_at - clock_timestamp()) * 1000)::bigint AS delay_ms
              FROM unnest($1::text[]) AS request(name)
             CROSS JOIN LATERAL (
                 SELECT run_at FROM ${p}jobs
                  WHERE status = 'pending' AND job_name = request.name AND id NOT IN (SELECT id FROM picked)
                  ORDER BY run_at LIMIT 1
             ) AS n
        )
        SELECT ${claimedJobsJson(p)} AS jobs,
               (SELECT json_agg(json_build_object('name', job_name, 'delayMs', delay_ms)) FROM next)::text AS next
    `, [
        requests.map(request => request.name),
        requests.map(request => request.maxJobs),
        requests.map(request => request.lane),
        laneFree,
        processMax,
        lockToken,
        lockedBy,
        leaseMs,
    ]);
    /** @type {ProbeRow[]} */
    const next = (row?.next ?? null) === null ? [] : JSON.parse(String(row?.next));

    return { jobs: parseClaimedJobs(row?.jobs, lockToken), next };
}

/**
 * Claims the due jobs of one name, as `claimDue`. Scalar parameters: PostgreSQL caches a generic plan of the prepared
 * statement, and plans it no more.
 * @param {Executor} executor Outside a transaction.
 * @param {string} p
 * @param {{ name: string, limit: number, lockToken: string, lockedBy: string, leaseMs: number }} params
 * @returns {Promise<import('./store.js').ClaimDueResult>}
 */
async function claimDueOfName(executor, p, { name, limit, lockToken, lockedBy, leaseMs }) {
    const [row] = await executor.query(`
        WITH picked AS (
            SELECT id FROM ${p}jobs
             WHERE status = 'pending' AND job_name = $1 AND run_at <= clock_timestamp()
             ORDER BY run_at, id LIMIT $2
               FOR UPDATE SKIP LOCKED
        ),
        claimed AS (
            UPDATE ${p}jobs AS j
               SET status = 'running', lock_token = $3, locked_by = $4,
                   locked_until = clock_timestamp() + $5 * interval '1 millisecond', started_at = clock_timestamp(),
                   timed_out_at = NULL, updated_at = clock_timestamp()
              FROM picked
             WHERE j.id = picked.id
            RETURNING j.id, j.job_name, j.run_at, j.attempts, j.max_attempts, j.stalls, j.max_stalls, j.failure_job,
                      ${epochMs('j.created_at')} AS created_at_ms,
                      (EXTRACT(EPOCH FROM clock_timestamp() - j.run_at) * 1000)::bigint AS waited_ms,
                      j.mutex_keys IS NOT NULL AS has_keys
        ),
        ${unkeyClaimed(p)}
        -- The statement's snapshot: the picked jobs are still pending in it
        SELECT ${claimedJobsJson(p)} AS jobs,
               (
                   SELECT (EXTRACT(EPOCH FROM run_at - clock_timestamp()) * 1000)::bigint FROM ${p}jobs
                    WHERE status = 'pending' AND job_name = $1 AND id NOT IN (SELECT id FROM picked)
                    ORDER BY run_at LIMIT 1
               ) AS next_delay_ms
    `, [name, limit, lockToken, lockedBy, leaseMs]);
    const nextDelay = row?.next_delay_ms ?? null;

    return {
        jobs: parseClaimedJobs(row?.jobs, lockToken),
        next: nextDelay === null ? [] : [{ name, delayMs: Number(nextDelay) }],
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
        SELECT id, payload::text AS payload FROM ${p}payloads WHERE id = ANY($1::text[])
    `, [ids]);

    return new Map(rows.map(row => [String(row.id), JSON.parse(String(row.payload))]));
}
