// The worker side of the store on PostgreSQL: probe, candidates, claim. Times are computed in SQL.

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').ProbeRow} ProbeRow */
/** @typedef {import('./store.js').Candidate} Candidate */
/** @typedef {import('./store.js').ClaimParams} ClaimParams */
/** @typedef {import('./store.js').ClaimedJob} ClaimedJob */

/** The due jobs of each name with global limits that a search of candidates reads */
export const LIMIT_WINDOW_SIZE = 500;

/**
 * @param {string} column
 * @returns {string} The epoch milliseconds of a time column.
 */
const epochMs = column => `(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`;
const HELD = '(s.held_until IS NULL OR s.held_until >= clock_timestamp())';

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
 * The due jobs of names with global limits, oldest first: at most `limit` of each name whose keys have room, and those
 * with a full key, which the claim blocks. A key is full when its held slots reach the max of the job.
 * @param {Executor} executor
 * @param {string} p
 * @param {Map<string, number>} limitsByName
 * @returns {Promise<import('./store.js').FoundCandidates>}
 */
export async function findCandidates(executor, p, limitsByName) {
    const names = [...limitsByName.keys()];

    if (!names.length) {
        return { startable: [], full: [] };
    }

    const rows = await executor.query(`
        WITH request AS (
            SELECT * FROM unnest($1::text[], $2::integer[]) AS request(name, max_jobs)
        ),
        w AS (
            SELECT due.*, request.max_jobs FROM request
             CROSS JOIN LATERAL (
                 SELECT id, job_name, run_at, limit_keys, limit_maxes FROM ${p}jobs
                  WHERE status = 'pending' AND job_name = request.name AND run_at <= clock_timestamp()
                  ORDER BY run_at, id LIMIT ${LIMIT_WINDOW_SIZE}
             ) AS due
        ),
        wk AS (
            SELECT w.id, k.limit_key, k.max FROM w
             CROSS JOIN LATERAL unnest(w.limit_keys, w.limit_maxes) AS k(limit_key, max)
        ),
        held AS MATERIALIZED (
            SELECT k.limit_key, count(s.slot) AS held
              FROM (SELECT DISTINCT limit_key FROM wk) AS k
              LEFT JOIN ${p}concurrency_slots s ON s.limit_key = k.limit_key AND ${HELD}
             GROUP BY k.limit_key
        ),
        marked AS (
            SELECT w.id, w.job_name, w.run_at, w.max_jobs,
                   EXISTS (
                       SELECT 1 FROM wk JOIN held h ON h.limit_key = wk.limit_key WHERE wk.id = w.id AND h.held >= wk.max
                   ) AS is_full
              FROM w
        ),
        ranked AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY job_name, is_full ORDER BY run_at, id) AS name_rank FROM marked
        )
        SELECT id, job_name, ${epochMs('run_at')} AS run_at_ms, is_full FROM ranked WHERE is_full OR name_rank <= max_jobs
         ORDER BY run_at, id
    `, [names, names.map(name => limitsByName.get(name))]);
    const candidates = rows.map(row => ({
        id: String(row.id),
        name: String(row.job_name),
        runAtMs: Number(row.run_at_ms),
        full: Boolean(row.is_full),
    }));

    return {
        startable: candidates.filter(row => !row.full).map(({ id, name, runAtMs }) => ({ id, name, runAtMs })),
        full: candidates.filter(row => row.full).map(({ id, name, runAtMs }) => ({ id, name, runAtMs })),
    };
}

/**
 * Takes a slot of each key of the picked jobs, all or none per job: the lowest free slots. A held slot stays with its
 * holder; an ended linger is taken over. Slots are inserted in the order of (key, slot): no deadlocks between claims.
 * @param {Executor} executor
 * @param {string} p
 * @param {ClaimedJob[]} jobs The picked jobs with global limits.
 * @param {{ heldSlots: Map<string, Set<number>>, lockToken: string }} params The held slots of their keys.
 * @returns {Promise<Set<string>>} The ids of the jobs that got a slot of each key.
 */
async function takeSlots(executor, p, jobs, { heldSlots, lockToken }) {
    /** @type {Map<string, number>} The next slot to try of each key */
    const nextSlot = new Map();
    const holds = jobs.flatMap(job => job.limits.map(({ key }) => {
        const taken = heldSlots.get(key) ?? new Set();
        let slot = nextSlot.get(key) ?? 0;

        while (taken.has(slot)) {
            slot++;
        }

        nextSlot.set(key, slot + 1);

        return { key, slot, id: job.id };
    })).toSorted((a, b) => (a.key === b.key ? a.slot - b.slot : Number(a.key > b.key) - Number(a.key < b.key)));
    const acquired = new Set((await executor.query(`
        INSERT INTO ${p}concurrency_slots AS s (limit_key, slot, job_id, lock_token, held_until, created_at)
        SELECT hold.limit_key, hold.slot, hold.job_id, $4, NULL, clock_timestamp()
          FROM unnest($1::text[], $2::integer[], $3::text[]) WITH ORDINALITY AS hold(limit_key, slot, job_id, position)
         ORDER BY hold.position
        ON CONFLICT (limit_key, slot) DO UPDATE
           SET job_id = EXCLUDED.job_id, lock_token = EXCLUDED.lock_token, held_until = NULL,
               created_at = EXCLUDED.created_at
         WHERE s.held_until < clock_timestamp()
        RETURNING s.job_id, s.limit_key
    `, [holds.map(hold => hold.key), holds.map(hold => hold.slot), holds.map(hold => hold.id), lockToken]))
        .map(row => `${row.job_id}\n${row.limit_key}`));
    const withAll = new Set(jobs
        .filter(job => job.limits.every(({ key }) => acquired.has(`${job.id}\n${key}`)))
        .map(job => job.id));
    const partial = holds.filter(hold => !withAll.has(hold.id) && acquired.has(`${hold.id}\n${hold.key}`));

    if (partial.length) {
        await executor.query(`
            DELETE FROM ${p}concurrency_slots s
             USING unnest($1::text[], $2::integer[]) AS hold(limit_key, slot)
             WHERE s.limit_key = hold.limit_key AND s.slot = hold.slot AND s.lock_token = $3
        `, [partial.map(hold => hold.key), partial.map(hold => hold.slot), lockToken]);
    }

    return withAll;
}

/**
 * @param {Record<string, unknown>} row With `limit_keys` and `limit_maxes` as JSON texts.
 * @returns {import('../concurrency_keys.js').GlobalLimit[]}
 */
function limitsOf(row) {
    if (row.limit_keys === null) {
        return [];
    }

    /** @type {string[]} */
    const keys = JSON.parse(String(row.limit_keys));
    /** @type {number[]} */
    const maxes = JSON.parse(String(row.limit_maxes));

    return keys.map((key, at) => ({ key, max: maxes[at] }));
}

/**
 * Claims due jobs among the candidates, and blocks those with a full key. Call it in a queue transaction.
 * @param {Executor} executor
 * @param {string} p
 * @param {ClaimParams} params
 * @returns {Promise<import('./store.js').ClaimResult>}
 */
export async function claim(executor, p, { candidateIds, fullIds, lockToken, lockedBy, leaseMs, pick }) {
    const ids = [...candidateIds, ...fullIds];

    if (!ids.length) {
        return { jobs: [], blockedKeys: [], blockedNames: [] };
    }

    /** @type {ClaimedJob[]} */
    const lockedRows = (await executor.query(`
        SELECT id, job_name, array_to_json(limit_keys)::text AS limit_keys,
               array_to_json(limit_maxes)::text AS limit_maxes, attempts, max_attempts, stalls, max_stalls, failure_job,
               ${epochMs('created_at')} AS created_at_ms,
               (EXTRACT(EPOCH FROM clock_timestamp() - run_at) * 1000)::bigint AS waited_ms
          FROM ${p}jobs
         WHERE id = ANY($1::text[]) AND status = 'pending' AND run_at <= clock_timestamp()
         ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
    `, [ids])).map(row => ({
        id: String(row.id),
        name: String(row.job_name),
        limits: limitsOf(row),
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        stalls: Number(row.stalls),
        maxStalls: Number(row.max_stalls),
        failureJob: row.failure_job === null ? null : String(row.failure_job),
        enqueuedAt: new Date(Number(row.created_at_ms)),
        waitedMs: Number(row.waited_ms),
        lockToken,
    }));
    const keys = [...new Set(lockedRows.flatMap(row => row.limits.map(limit => limit.key)))];
    /** @type {Map<string, Set<number>>} */
    const heldSlots = new Map();

    if (keys.length) {
        const slotRows = await executor.query(`
            SELECT s.limit_key, s.slot FROM ${p}concurrency_slots s WHERE s.limit_key = ANY($1::text[]) AND ${HELD}
        `, [keys]);

        for (const row of slotRows) {
            const key = String(row.limit_key);

            heldSlots.set(key, (heldSlots.get(key) ?? new Set()).add(Number(row.slot)));
        }
    }

    const held = new Map([...heldSlots].map(([key, slots]) => [key, slots.size]));
    /** @type {{ id: string, name: string, key: string }[]} */
    const blocked = [];
    /** @type {ClaimedJob[]} */
    const open = [];

    for (const row of lockedRows) {
        const fullLimit = row.limits.find(({ key, max }) => (held.get(key) ?? 0) >= max);

        if (fullLimit) {
            blocked.push({ id: row.id, name: row.name, key: fullLimit.key });
        } else {
            open.push(row);
        }
    }

    if (blocked.length) {
        await executor.query(`
            UPDATE ${p}jobs j SET status = 'blocked', blocked_on = b.limit_key, updated_at = clock_timestamp()
              FROM unnest($1::text[], $2::text[]) AS b(id, limit_key)
             WHERE j.id = b.id
        `, [blocked.map(job => job.id), blocked.map(job => job.key)]);
    }

    const picked = pick(open, held);
    const pickedWithLimits = picked.filter(row => row.limits.length);
    const withSlots = pickedWithLimits.length
        ? await takeSlots(executor, p, pickedWithLimits, { heldSlots, lockToken })
        : new Set();
    const claimed = picked.filter(row => !row.limits.length || withSlots.has(row.id));

    if (claimed.length) {
        await executor.query(`
            UPDATE ${p}jobs
               SET status = 'running', lock_token = $2, locked_by = $3,
                   locked_until = clock_timestamp() + $4 * interval '1 millisecond', started_at = clock_timestamp(),
                   timed_out_at = NULL, updated_at = clock_timestamp()
             WHERE id = ANY($1::text[])
        `, [claimed.map(row => row.id), lockToken, lockedBy, leaseMs]);
    }

    return {
        jobs: claimed,
        blockedKeys: [...new Set(blocked.map(job => job.key))],
        blockedNames: [...new Set(blocked.map(job => job.name))],
    };
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
        limits: [],
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
 * Finds, chooses, claims and reads the due jobs of names without global limits, in one statement (a transaction of its
 * own). Each name locks its oldest due jobs that no other claim holds (SKIP LOCKED), up to its `maxJobs`. The locked
 * rows are taken in the order of their share, `(running + rank in the name − 1) / weight`, then the tie order, within
 * the free slots of the local limits and of the instance: the order of `fill()` (fair_share.js), row by row. Then the
 * next due time of each requested name, among its pending jobs that this claim did not take.
 * @param {Executor} executor Outside a transaction.
 * @param {string} p
 * @param {import('./store.js').ClaimDueParams} params
 * @returns {Promise<import('./store.js').ClaimDueResult>} The jobs in the order of run_at.
 */
export async function claimDue(executor, p, { requests, limitRooms, free, lockToken, lockedBy, leaseMs }) {
    if (!requests.length || free <= 0) {
        return { jobs: [], next: [], unpicked: [], limited: [] };
    }

    if (requests.length === 1) {
        const [{ name, maxJobs }] = requests;
        // One name: nothing to share
        const result = await claimDueOfName(executor, p, {
            name,
            limit: Math.min(maxJobs, free),
            lockToken,
            lockedBy,
            leaseMs,
        });

        return { ...result, unpicked: [] };
    }

    // Without local limits, the free slots of the instance are the only cap: the first rows by share. With them, a
    // walk row by row, as fill(): a row is taken while the instance and each of its limits have room
    const pick = requests.some(request => request.limits.length)
        ? `
        ordered AS (
            SELECT id, limits, ROW_NUMBER() OVER (ORDER BY share, tie, run_at, id) AS n FROM locked
        ),
        walk AS (
            SELECT 0::bigint AS n, (SELECT rooms FROM limit_rooms) AS rooms, 0::bigint AS taken, NULL::text COLLATE "C" AS id
            UNION ALL
            SELECT o.n,
                   CASE WHEN step.ok
                        THEN ARRAY(SELECT u.room - (u.at - 1 = ANY(o.limits))::integer
                                     FROM unnest(w.rooms) WITH ORDINALITY AS u(room, at) ORDER BY u.at)
                        ELSE w.rooms END,
                   w.taken + step.ok::integer,
                   CASE WHEN step.ok THEN o.id END
              FROM walk w
              JOIN ordered o ON o.n = w.n + 1
             CROSS JOIN LATERAL (
                 SELECT NOT EXISTS (SELECT 1 FROM unnest(o.limits) AS l(at) WHERE w.rooms[l.at + 1] <= 0) AS ok
             ) AS step
             WHERE w.taken < $8
        ),
        picked AS (
            SELECT id FROM walk WHERE id IS NOT NULL
        ),`
        : `
        picked AS (
            SELECT id FROM locked ORDER BY share, tie, run_at, id LIMIT $8
        ),`;
    // One row: the claimed jobs, the next due times and the names of the locked rows left, as JSON texts. Bigints: a
    // localMaxConcurrency may be above 2^31
    const [row] = await executor.query(`
        WITH RECURSIVE limit_rooms AS (
            -- Typed here: only the walk reads it
            SELECT $7::bigint[] AS rooms
        ),
        request AS (
            SELECT r.name, r.max_jobs, r.running, r.weight, r.limits::integer[] AS limits, r.tie
              FROM unnest($1::text[], $2::bigint[], $3::bigint[], $4::integer[], $5::text[], $6::integer[])
                AS r(name, max_jobs, running, weight, limits, tie)
        ),
        locked_all AS (
            SELECT due.id, due.run_at, due.limited, request.name, request.limits, request.tie, request.running,
                   request.weight
              FROM request
             CROSS JOIN LATERAL (
                 SELECT id, run_at, limit_keys IS NOT NULL AS limited FROM ${p}jobs
                  WHERE status = 'pending' AND job_name = request.name AND run_at <= clock_timestamp()
                  ORDER BY run_at, id LIMIT request.max_jobs
                    FOR UPDATE SKIP LOCKED
             ) AS due
        ),
        -- The rows with global limits (from their enqueue options) are left to the claim of names with limits
        locked AS (
            SELECT id, run_at, name, limits, tie,
                   (running + ROW_NUMBER() OVER (PARTITION BY name ORDER BY run_at, id) - 1)::float8 / weight AS share
              FROM locked_all WHERE NOT limited
        ),
        ${pick}
        claimed AS (
            UPDATE ${p}jobs AS j
               SET status = 'running', lock_token = $9, locked_by = $10,
                   locked_until = clock_timestamp() + $11 * interval '1 millisecond', started_at = clock_timestamp(),
                   timed_out_at = NULL, updated_at = clock_timestamp()
              FROM picked
             WHERE j.id = picked.id
            RETURNING j.id, j.job_name, j.run_at, j.attempts, j.max_attempts, j.stalls, j.max_stalls, j.failure_job,
                      ${epochMs('j.created_at')} AS created_at_ms,
                      (EXTRACT(EPOCH FROM clock_timestamp() - j.run_at) * 1000)::bigint AS waited_ms
        ),
        -- The statement's snapshot: the picked jobs are still pending in it. A full claim does not read them: the next
        -- turn claims again
        next AS (
            SELECT request.name AS job_name,
                   (EXTRACT(EPOCH FROM n.run_at - clock_timestamp()) * 1000)::bigint AS delay_ms
              FROM unnest($1::text[]) AS request(name)
             CROSS JOIN LATERAL (
                 SELECT run_at FROM ${p}jobs
                  WHERE status = 'pending' AND job_name = request.name AND id NOT IN (SELECT id FROM picked)
                  ORDER BY run_at LIMIT 1
             ) AS n
             WHERE (SELECT count(*) FROM picked) < $8
        )
        SELECT ${claimedJobsJson(p)} AS jobs,
               (SELECT count(*) FROM picked) >= $8 AS full,
               (SELECT json_agg(json_build_object('name', job_name, 'delayMs', delay_ms)) FROM next)::text AS next,
               -- The names with a locked row left, under any cap: the runner replays the choice for its tie pointer
               (SELECT json_agg(DISTINCT name) FROM locked WHERE id NOT IN (SELECT id FROM picked))::text AS unpicked,
               (SELECT json_agg(DISTINCT name) FROM locked_all WHERE limited)::text AS limited
    `, [
        requests.map(request => request.name),
        requests.map(request => request.maxJobs),
        requests.map(request => request.running),
        requests.map(request => request.weight),
        requests.map(request => `{${request.limits.join(',')}}`),
        requests.map(request => request.tie),
        limitRooms,
        free,
        lockToken,
        lockedBy,
        leaseMs,
    ]);
    /** @type {ProbeRow[] | null} */
    let next = (row?.next ?? null) === null ? [] : JSON.parse(String(row?.next));

    if (row?.full) {
        next = null;
    }

    return {
        jobs: parseClaimedJobs(row?.jobs, lockToken),
        next,
        unpicked: (row?.unpicked ?? null) === null ? [] : JSON.parse(String(row?.unpicked)),
        limited: (row?.limited ?? null) === null ? [] : JSON.parse(String(row?.limited)),
    };
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
        WITH locked AS (
            SELECT id, limit_keys IS NOT NULL AS limited FROM ${p}jobs
             WHERE status = 'pending' AND job_name = $1 AND run_at <= clock_timestamp()
             ORDER BY run_at, id LIMIT $2
               FOR UPDATE SKIP LOCKED
        ),
        -- The rows with global limits (from their enqueue options) are left to the claim of names with limits
        picked AS (
            SELECT id FROM locked WHERE NOT limited
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
                      (EXTRACT(EPOCH FROM clock_timestamp() - j.run_at) * 1000)::bigint AS waited_ms
        )
        -- The statement's snapshot: the picked jobs are still pending in it
        SELECT ${claimedJobsJson(p)} AS jobs,
               (
                   SELECT (EXTRACT(EPOCH FROM run_at - clock_timestamp()) * 1000)::bigint FROM ${p}jobs
                    WHERE status = 'pending' AND job_name = $1 AND id NOT IN (SELECT id FROM picked)
                    ORDER BY run_at LIMIT 1
               ) AS next_delay_ms,
               (SELECT bool_or(limited) FROM locked) AS limited
    `, [name, limit, lockToken, lockedBy, leaseMs]);
    const nextDelay = row?.next_delay_ms ?? null;

    return {
        jobs: parseClaimedJobs(row?.jobs, lockToken),
        next: nextDelay === null ? [] : [{ name, delayMs: Number(nextDelay) }],
        limited: row?.limited ? [name] : [],
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
