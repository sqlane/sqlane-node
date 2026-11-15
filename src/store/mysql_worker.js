// The worker side of the store on MySQL: probe, candidates, claim. Times are computed in SQL, in UTC.

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').ProbeRow} ProbeRow */
/** @typedef {import('./store.js').Candidate} Candidate */
/** @typedef {import('./store.js').ClaimParams} ClaimParams */
/** @typedef {import('./store.js').ClaimedJob} ClaimedJob */

/** The due jobs of each name with global limits that a search of candidates reads */
export const LIMIT_WINDOW_SIZE = 500;

const NOW = 'UTC_TIMESTAMP(3)';
/**
 * @param {string} column
 * @returns {string} The epoch milliseconds of a time column.
 */
const epochMs = column => `TIMESTAMPDIFF(MICROSECOND, '1970-01-01', ${column}) DIV 1000`;
const HELD = `(s.held_until IS NULL OR s.held_until >= ${NOW})`;

/**
 * @param {number} count
 * @returns {string}
 */
function placeholders(count) {
    return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * @param {Record<string, unknown>} row With `limit_keys` and `limit_maxes` as JSON texts.
 * @returns {import('../concurrency_keys.js').GlobalLimit[]}
 */
function limitsOf(row) {
    if (row.limit_keys === null || row.limit_keys === undefined) {
        return [];
    }

    /** @type {string[]} */
    const keys = JSON.parse(String(row.limit_keys));
    /** @type {number[]} */
    const maxes = JSON.parse(String(row.limit_maxes));

    return keys.map((key, at) => ({ key, max: maxes[at] }));
}

/**
 * The SQL of the probe. `GROUP BY status, job_name`: the whole index prefix, else MySQL does not use a loose index
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
        SELECT id, job_name, run_at, limit_keys, limit_maxes FROM ${p}jobs FORCE INDEX (${p}jobs_status_name_run_at)
         WHERE status = 'pending' AND job_name = ? AND run_at <= ${NOW}
         ORDER BY run_at, id LIMIT ${limitSql(index)}
    )`).join(' UNION ALL ');
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

    const conditions = names.map(() => '(job_name = ? AND name_rank <= ?)').join(' OR ');
    const rows = await executor.query(`
        WITH w AS (${dueJobsSql(p, names, () => String(LIMIT_WINDOW_SIZE))}),
        wk AS (
            SELECT w.id, k.limit_key,
                   CAST(JSON_EXTRACT(w.limit_maxes, CONCAT('$[', k.position - 1, ']')) AS UNSIGNED) AS max_slots
              FROM w, JSON_TABLE(w.limit_keys, '$[*]' COLUMNS (
                  position FOR ORDINALITY,
                  limit_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PATH '$'
              )) AS k
        ),
        held AS (
            SELECT f.limit_key, (SELECT COUNT(*) FROM ${p}concurrency_slots s WHERE s.limit_key = f.limit_key AND ${HELD})
                       AS held
              FROM (SELECT DISTINCT limit_key FROM wk) AS f
        ),
        marked AS (
            SELECT w.id, w.job_name, w.run_at,
                   EXISTS (
                       SELECT 1 FROM wk JOIN held h ON h.limit_key = wk.limit_key
                        WHERE wk.id = w.id AND h.held >= wk.max_slots
                   ) AS is_full
              FROM w
        ),
        ranked AS (
            SELECT marked.*, ROW_NUMBER() OVER (PARTITION BY job_name, is_full ORDER BY run_at, id) AS name_rank
              FROM marked
        )
        SELECT id, job_name, ${epochMs('run_at')} AS run_at_ms, is_full FROM ranked WHERE is_full OR ${conditions}
         ORDER BY run_at, id
    `, [...names, ...names.flatMap(name => [name, limitsByName.get(name)])]);
    const candidates = rows.map(row => ({
        id: String(row.id),
        name: String(row.job_name),
        runAtMs: Number(row.run_at_ms),
        full: Boolean(Number(row.is_full)),
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
    // held_until last: MySQL sets the columns from left to right, and the others read its old value
    /**
     * @param {string} column
     * @returns {string} Takes the new value over an ended linger.
     */
    const takeOver = column => `${column} = IF(${p}concurrency_slots.held_until < ${NOW}, new.${column}, `
        + `${p}concurrency_slots.${column})`;

    await executor.query(`
        INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
        VALUES ${holds.map(() => `(?, ?, ?, ?, NULL, ${NOW})`).join(', ')} AS new
        ON DUPLICATE KEY UPDATE ${takeOver('job_id')}, ${takeOver('lock_token')}, ${takeOver('created_at')},
            held_until = IF(${p}concurrency_slots.held_until < ${NOW}, NULL, ${p}concurrency_slots.held_until)
    `, holds.flatMap(hold => [hold.key, hold.slot, hold.id, lockToken]));

    const acquired = new Set((await executor.query(`
        SELECT limit_key, job_id FROM ${p}concurrency_slots
         WHERE (limit_key, slot) IN (${holds.map(() => '(?, ?)').join(', ')}) AND lock_token = ?
    `, [...holds.flatMap(hold => [hold.key, hold.slot]), lockToken])).map(row => `${row.job_id}\n${row.limit_key}`));
    const withAll = new Set(jobs
        .filter(job => job.limits.every(({ key }) => acquired.has(`${job.id}\n${key}`)))
        .map(job => job.id));
    const partial = holds.filter(hold => !withAll.has(hold.id) && acquired.has(`${hold.id}\n${hold.key}`));

    if (partial.length) {
        await executor.query(`
            DELETE FROM ${p}concurrency_slots
             WHERE (limit_key, slot) IN (${partial.map(() => '(?, ?)').join(', ')}) AND lock_token = ?
        `, [...partial.flatMap(hold => [hold.key, hold.slot]), lockToken]);
    }

    return withAll;
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
        SELECT id, job_name, CAST(limit_keys AS CHAR) AS limit_keys, CAST(limit_maxes AS CHAR) AS limit_maxes,
               attempts, max_attempts, stalls, max_stalls, failure_job, ${epochMs('created_at')} AS created_at_ms,
               TIMESTAMPDIFF(MICROSECOND, run_at, ${NOW}) DIV 1000 AS waited_ms
          FROM ${p}jobs
         WHERE id IN (${placeholders(ids.length)}) AND status = 'pending' AND run_at <= ${NOW}
         ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
    `, ids)).map(row => ({
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
            SELECT s.limit_key, s.slot FROM ${p}concurrency_slots s
             WHERE s.limit_key IN (${placeholders(keys.length)}) AND ${HELD}
        `, keys);

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
            UPDATE ${p}jobs
               SET status = 'blocked', blocked_on = CASE id ${blocked.map(() => 'WHEN ? THEN ?').join(' ')} END,
                   updated_at = ${NOW}
             WHERE id IN (${placeholders(blocked.length)})
        `, [...blocked.flatMap(job => [job.id, job.key]), ...blocked.map(job => job.id)]);
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
               SET status = 'running', lock_token = ?, locked_by = ?,
                   locked_until = ${NOW} + INTERVAL ? MICROSECOND, started_at = ${NOW}, timed_out_at = NULL,
                   updated_at = ${NOW}
             WHERE id IN (${placeholders(claimed.length)})
        `, [lockToken, lockedBy, leaseMs * 1000, ...claimed.map(row => row.id)]);
    }

    return {
        jobs: claimed,
        blockedKeys: [...new Set(blocked.map(job => job.key))],
        blockedNames: [...new Set(blocked.map(job => job.name))],
    };
}

/**
 * Finds, claims and reads the due jobs of names without global limits. Call it in a queue transaction. One statement
 * locks the oldest due jobs of each name that no other claim holds (SKIP LOCKED), with their payloads; the ones that
 * the choice by share takes (`choose`) are claimed. A second read gets the payloads that the statement did not see.
 * @param {Executor} executor
 * @param {string} p
 * @param {import('./store.js').ClaimDueParams} params
 * @returns {Promise<import('./store.js').ClaimDueResult>} The jobs in the order of run_at.
 */
export async function claimDue(executor, p, { requests, free, lockToken, lockedBy, leaseMs, choose }) {
    if (!requests.length || free <= 0) {
        return { jobs: [], next: [], limited: [] };
    }

    const locked = (await executor.query(requests.map(() => `(
        SELECT j.id, j.job_name, ${epochMs('j.run_at')} AS run_at_ms, j.attempts, j.max_attempts, j.stalls,
               j.max_stalls, j.failure_job, ${epochMs('j.created_at')} AS created_at_ms, j.limit_keys IS NOT NULL AS has_limits,
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
            hasLimits: Boolean(Number(row.has_limits)),
            /** @type {import('./store.js').StartableJob} */
            job: {
                id: String(row.id),
                name: String(row.job_name),
                limits: [],
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
        .toSorted((a, b) => a.runAtMs - b.runAtMs || (a.job.id < b.job.id ? -1 : 1));
    // The rows with global limits (from their enqueue options) are left to the claim of names with limits
    const limited = [...new Set(locked.filter(row => row.hasLimits).map(row => row.job.name))];
    // The choice by share, among the locked rows
    const picked = choose(locked.filter(row => !row.hasLimits).map(({ job }) => job));
    // `OF j` leaves the payloads to a consistent read, from the read view of the statement's first one: a job whose
    // enqueue committed later in the statement is locked without its payload. A new statement (READ COMMITTED) sees it
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
            UPDATE ${p}jobs
               SET status = 'running', lock_token = ?, locked_by = ?,
                   locked_until = ${NOW} + INTERVAL ? MICROSECOND, started_at = ${NOW}, timed_out_at = NULL,
                   updated_at = ${NOW}
             WHERE id IN (${placeholders(picked.length)})
        `, [lockToken, lockedBy, leaseMs * 1000, ...picked.map(job => job.id)]);
    }

    // In the transaction: the claimed jobs are running
    // A full claim: the next turn claims again; the next due times only after a claim that took fewer
    return {
        jobs: picked,
        next: picked.length >= free ? null : await probe(executor, p, requests.map(request => request.name)),
        limited,
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
