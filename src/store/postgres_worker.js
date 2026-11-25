// The worker side of the store on PostgreSQL: probe, candidates, claim. Times are computed in SQL.
import { incrementsOf, splitByRate } from '../gcra.js';
import { notPaused } from './pauses.js';

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').ProbeRow} ProbeRow */
/** @typedef {import('./store.js').Candidate} Candidate */
/** @typedef {import('./store.js').ClaimParams} ClaimParams */
/** @typedef {import('./store.js').ClaimedJob} ClaimedJob */

/** The due jobs of each lane with global limits that a search of candidates reads */
export const LIMIT_WINDOW_SIZE = 500;

/**
 * @param {string} column
 * @returns {string} The epoch milliseconds of a time column.
 */
const epochMs = column => `(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`;
const HELD = '(s.held_until IS NULL OR s.held_until >= clock_timestamp())';
/**
 * A column of the limits of a job, null for a job past its maxStalls: its claim fails it, so it takes no slot and no
 * quota, and is never blocked (docs/design.md › Leases and stalls).
 * @param {string} column
 * @returns {string}
 */
const unlessStalledOut = column => `CASE WHEN stalls > max_stalls THEN NULL ELSE ${column} END`;
/** The job has global limits, of concurrency or of rate: the claim of lanes with limits takes it */
const LIMITED = '(limit_keys IS NOT NULL OR rate_limits IS NOT NULL) AND stalls <= max_stalls';
/**
 * @param {string} tat
 * @returns {string} The debt of a rate key in µs (gcra.js): how far its tat is ahead of now.
 */
const debtUs = tat => `GREATEST((EXTRACT(EPOCH FROM ${tat} - clock_timestamp()) * 1000000)::bigint, 0)`;
/**
 * An array parameter, behind a subquery (an InitPlan): the planner does not see its elements, in a custom plan either.
 * PostgreSQL plans the first 5 executions of a prepared statement with the parameters' values, then keeps its generic
 * plan if that costs no more than the custom ones did. A generic plan assumes 10 elements in an array; a custom one,
 * which counts them, costs less with fewer, so each execution was planned again (planning took several times the
 * execution). With the count hidden from both, the generic plan wins, and is planned once per connection.
 * @param {number} position The parameter's position, from 1.
 * @param {'text' | 'integer' | 'bigint'} type The type of its elements.
 * @returns {string}
 */
export const arrayParam = (position, type) => `(SELECT $${position}::${type}[])::${type}[]`;
/**
 * The settings of the rate keys of a JSON array (`rate_limits`), with the increment of a start and the allowance of
 * the key in µs, as gcra.js computes them. Bigints: cost × per_us is at most 6 × 10^17.
 * @param {string} json
 * @returns {string} A FROM item `e`, with `key`, `inc` and `allow`.
 */
export const rateLimitsOf = json => `(
    SELECT r.key, (r.cost * r.per_us + r.max - 1) / r.max AS inc,
           (r.cost * r.per_us + r.max - 1) / r.max + (r.burst - r.cost) * r.per_us / r.max AS allow
      FROM jsonb_to_recordset(${json}) AS r(key text, max bigint, per_us bigint, burst bigint, cost bigint)
) AS e`;

/**
 * The next due time of each given lane with pending jobs, not paused: one index probe per lane.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} lanes
 * @returns {Promise<ProbeRow[]>}
 */
async function probeLanes(executor, p, lanes) {
    const rows = await executor.query(`
        SELECT request.name AS lane,
               (EXTRACT(EPOCH FROM next.run_at - clock_timestamp()) * 1000)::bigint AS delay_ms
          FROM unnest(${arrayParam(1, 'text')}) AS request(name)
         CROSS JOIN LATERAL (
             SELECT run_at FROM ${p}jobs
              WHERE status = 'pending' AND lane = request.name ORDER BY run_at LIMIT 1
         ) AS next
         WHERE ${notPaused(p, 'request.name')}
    `, [lanes]);

    return rows.map(row => ({ name: String(row.lane), delayMs: Number(row.delay_ms) }));
}

/**
 * The next due time of each given lane with pending jobs, not paused; null: of each lane. PostgreSQL has no loose index
 * scan: for all lanes, a recursive CTE skips from one pending lane to the next on the partial index, two index probes
 * per pending lane (a paused lane: one, and its row in `<p>paused_lanes`).
 * @param {Executor} executor
 * @param {string} p
 * @param {string[] | null} lanes
 * @returns {Promise<ProbeRow[]>}
 */
export async function probe(executor, p, lanes) {
    if (lanes) {
        return lanes.length ? probeLanes(executor, p, lanes) : [];
    }

    const rows = await executor.query(`
        WITH RECURSIVE lanes AS (
            (SELECT lane FROM ${p}jobs WHERE status = 'pending' ORDER BY lane LIMIT 1)
            UNION ALL
            SELECT (
                SELECT j.lane FROM ${p}jobs j
                 WHERE j.status = 'pending' AND j.lane > lanes.lane ORDER BY j.lane LIMIT 1
            ) FROM lanes WHERE lanes.lane IS NOT NULL
        )
        SELECT lanes.lane,
               (EXTRACT(EPOCH FROM (
                   SELECT j.run_at FROM ${p}jobs j
                    WHERE j.status = 'pending' AND j.lane = lanes.lane ORDER BY j.run_at LIMIT 1
               ) - clock_timestamp()) * 1000)::bigint AS delay_ms
          FROM lanes WHERE lanes.lane IS NOT NULL AND ${notPaused(p, 'lanes.lane')}
    `, []);

    return rows.map(row => ({ name: String(row.lane), delayMs: Number(row.delay_ms) }));
}

/**
 * The due jobs of lanes with global limits, oldest first: at most `limit` of each lane whose keys have room, and those
 * with a full key, which the claim blocks. A key is full when its held slots reach the max of the job, or a rate key
 * has no quota left for it after the older jobs of the search. Without `withRates`, the search leaves out the rate
 * keys, and returns its jobs that have some too, past the max of their lane: they tell their lanes (store.js).
 * @param {Executor} executor
 * @param {string} p
 * @param {Map<string, number>} limitsByLane
 * @param {{ withRates: boolean, paused?: readonly string[] | null }} options `paused`: MySQL and MariaDB only.
 * @returns {Promise<import('./store.js').FoundCandidatesOf>}
 */
export async function findCandidates(executor, p, limitsByLane, { withRates }) {
    const lanes = [...limitsByLane.keys()];

    if (!lanes.length) {
        return { startable: [], full: [], ratedLanes: [] };
    }

    const rows = await executor.query(candidatesSql(p, withRates), [lanes, lanes.map(lane => limitsByLane.get(lane))]);
    const candidates = rows.map(row => ({
        id: String(row.id),
        lane: String(row.lane),
        runAtMs: Number(row.run_at_ms),
        full: Boolean(row.is_full),
    }));

    return {
        startable: candidates.filter(row => !row.full).map(({ id, lane, runAtMs }) => ({ id, lane, runAtMs })),
        full: candidates.filter(row => row.full).map(({ id, lane, runAtMs }) => ({ id, lane, runAtMs })),
        ratedLanes: [...new Set(rows.filter(row => row.rated).map(row => String(row.lane)))],
    };
}

/**
 * @param {string} p
 * @param {boolean} withRates With the rate keys of the jobs. Without: a column `rated`, the job has rate keys, and
 *     the jobs with rate keys are returned too, past the max of their lane: they only tell their lanes.
 * @returns {string} The search of candidates, `$1` the lanes and `$2` the max jobs of each.
 */
function candidatesSql(p, withRates) {
    const rates = `
        wr AS (
            SELECT w.id, w.run_at, e.key AS limit_key, e.inc, e.allow FROM w
             CROSS JOIN LATERAL ${rateLimitsOf('w.rate_limits')}
        ),
        -- The debt of each rate key, and its oldest blocked job: the jobs after it wait behind it
        rate AS MATERIALIZED (
            SELECT k.limit_key, COALESCE(${debtUs('r.tat')}, 0) AS debt, head.run_at AS head_run_at, head.id AS head_id
              FROM (SELECT DISTINCT limit_key FROM wr) AS k
              LEFT JOIN ${p}rate_limits r ON r.limit_key = k.limit_key
              LEFT JOIN LATERAL (
                  SELECT b.run_at, b.id FROM ${p}jobs b
                   WHERE b.status = 'blocked' AND b.blocked_on = k.limit_key AND ${notPaused(p, 'b.lane')}
                   ORDER BY b.run_at, b.id LIMIT 1
              ) AS head ON true
        ),
        -- The jobs over the quota of a rate key, after the older jobs of the search
        rate_full AS (
            SELECT DISTINCT used.id FROM (
                SELECT wr.*, SUM(wr.inc) OVER (PARTITION BY wr.limit_key ORDER BY wr.run_at, wr.id) AS used FROM wr
            ) AS used
              JOIN rate ON rate.limit_key = used.limit_key
             WHERE rate.debt + used.used > used.allow OR (rate.head_run_at, rate.head_id) < (used.run_at, used.id)
        ),`;

    return `
        WITH request AS (
            SELECT * FROM unnest(${arrayParam(1, 'text')}, ${arrayParam(2, 'integer')}) AS request(name, max_jobs)
             WHERE ${notPaused(p, 'request.name')}
        ),
        w AS (
            SELECT due.*, request.max_jobs FROM request
             CROSS JOIN LATERAL (
                 SELECT id, lane, run_at, ${unlessStalledOut('limit_keys')} AS limit_keys,
                        ${unlessStalledOut('limit_maxes')} AS limit_maxes,
                        ${unlessStalledOut('rate_limits')}${withRates ? ' AS rate_limits' : ' IS NOT NULL AS rated'}
                   FROM ${p}jobs
                  WHERE status = 'pending' AND lane = request.name AND run_at <= clock_timestamp()
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
        ),${withRates ? rates : ''}
        marked AS (
            SELECT w.id, w.lane, w.run_at, w.max_jobs, ${withRates ? '' : 'w.rated,'}
                   EXISTS (
                       SELECT 1 FROM wk JOIN held h ON h.limit_key = wk.limit_key WHERE wk.id = w.id AND h.held >= wk.max
                   ) ${withRates ? 'OR w.id IN (SELECT id FROM rate_full)' : ''} AS is_full
              FROM w
        ),
        ranked AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY lane, is_full ORDER BY run_at, id) AS lane_rank FROM marked
        )
        SELECT id, lane, ${epochMs('run_at')} AS run_at_ms, is_full${withRates ? '' : ', rated'}
          FROM ranked WHERE is_full OR lane_rank <= max_jobs${withRates ? '' : ' OR rated'}
         ORDER BY run_at, id
    `;
}

/**
 * Takes a slot of each key of the picked jobs, all or none per job: the lowest free slots. A held slot stays with its
 * holder; an ended linger is taken over. Slots are inserted in the order of (key, slot): no deadlocks between claims.
 * @param {Executor} executor
 * @param {string} p
 * @param {ClaimedJob[]} jobs The picked jobs with global limits.
 * @param {{ heldSlots: Map<string, Set<number>>, lockToken: string }} params The held slots of their keys.
 * @returns {Promise<{ withAll: Set<string>, nowUs: number | null }>} The ids of the jobs that got a slot of each key;
 *     the time of their slots, as stored (null: no slot was taken). The claim writes it to the jobs it starts.
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
    // One time for all the slots of the claim (a materialized CTE, evaluated once): the start of its runs
    const acquiredRows = await executor.query(`
        WITH t AS MATERIALIZED (
            SELECT clock_timestamp() AS now
        )
        INSERT INTO ${p}concurrency_slots AS s (limit_key, slot, job_id, lock_token, held_until, created_at)
        SELECT hold.limit_key, hold.slot, hold.job_id, $4, NULL, t.now
          FROM unnest(${arrayParam(1, 'text')}, ${arrayParam(2, 'integer')}, ${arrayParam(3, 'text')})
               WITH ORDINALITY AS hold(limit_key, slot, job_id, position)
         CROSS JOIN t
         ORDER BY hold.position
        ON CONFLICT (limit_key, slot) DO UPDATE
           SET job_id = EXCLUDED.job_id, lock_token = EXCLUDED.lock_token, held_until = NULL,
               created_at = EXCLUDED.created_at
         WHERE s.held_until < clock_timestamp()
        RETURNING s.job_id, s.limit_key, (extract(epoch FROM s.created_at) * 1000000)::bigint AS createdus
    `, [holds.map(hold => hold.key), holds.map(hold => hold.slot), holds.map(hold => hold.id), lockToken]);
    const acquired = new Set(acquiredRows.map(row => `${row.job_id}\n${row.limit_key}`));
    const withAll = new Set(jobs
        .filter(job => job.limits.every(({ key }) => acquired.has(`${job.id}\n${key}`)))
        .map(job => job.id));
    const partial = holds.filter(hold => !withAll.has(hold.id) && acquired.has(`${hold.id}\n${hold.key}`));

    if (partial.length) {
        await executor.query(`
            DELETE FROM ${p}concurrency_slots s
             USING unnest(${arrayParam(1, 'text')}, ${arrayParam(2, 'integer')}) AS hold(limit_key, slot)
             WHERE s.limit_key = hold.limit_key AND s.slot = hold.slot AND s.lock_token = $3
        `, [partial.map(hold => hold.key), partial.map(hold => hold.slot), lockToken]);
    }

    return { withAll, nowUs: acquiredRows.length ? Number(acquiredRows[0].createdus) : null };
}

/**
 * Locks the rows of the rate keys, in the order of the keys (no deadlocks between claims), and creates the missing
 * ones: a new key has its full quota. The claim's first statement does it, with the jobs, when the candidates may have
 * rate keys (`withRates`); else this one, for the keys that it found.
 * @param {string} p
 * @param {string} keys A FROM item `k` with the keys as `limit_key`, sorted, and its ORDER BY.
 * @returns {string}
 */
const lockRateKeysSql = (p, keys) => `
    INSERT INTO ${p}rate_limits AS r (limit_key, tat)
    SELECT k.limit_key, clock_timestamp() FROM ${keys}
    ON CONFLICT (limit_key) DO UPDATE SET tat = r.tat`;

/**
 * Reads the locked rows of the rate keys, with the oldest job blocked on each key. A statement after the lock: its
 * snapshot sees the jobs that another claim blocked while it held a row (a statement sees what committed before it
 * started, and that claim committed before the lock was given).
 * @param {Executor} executor In the transaction of the claim, after the lock of the rows.
 * @param {string} p
 * @param {string[]} keys
 * @returns {Promise<Map<string, import('../gcra.js').RateKeyState>>}
 */
async function readRateKeys(executor, p, keys) {
    const rows = await executor.query(`
        SELECT r.limit_key, ${debtUs('r.tat')} AS debt_us, head.id AS head_id, ${epochMs('head.run_at')} AS head_run_at_ms
          FROM ${p}rate_limits r
          LEFT JOIN LATERAL (
              SELECT b.id, b.run_at FROM ${p}jobs b
               WHERE b.status = 'blocked' AND b.blocked_on = r.limit_key AND ${notPaused(p, 'b.lane')}
               ORDER BY b.run_at, b.id LIMIT 1
          ) AS head ON true
         WHERE r.limit_key = ANY(${arrayParam(1, 'text')})
    `, [keys]);

    return new Map(rows.map(row => [String(row.limit_key), {
        debtUs: Number(row.debt_us),
        head: row.head_id === null ? null : { runAtMs: Number(row.head_run_at_ms), id: String(row.head_id) },
    }]));
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
 * Claims due jobs among the candidates, and blocks those with a full key. Call it in a queue transaction. The order of
 * the locks: the jobs, the rows of their rate keys, then their slots; the tat of a rate key moves only for the jobs
 * that got all their slots, so nothing is given back. With `withRates`, the statement that locks the jobs locks the
 * rows of their rate keys too: the read of the rows, after it, sees the blocked jobs as they are, without a statement
 * of its own for the lock.
 * @param {Executor} executor
 * @param {string} p
 * @param {ClaimParams} params
 * @returns {Promise<import('./store.js').ClaimResult>}
 */
export async function claim(executor, p, {
    candidateIds, fullIds, lockToken, lockedBy, leaseMs, pick, withRates, withFairGroups = false,
}) {
    const ids = [...candidateIds, ...fullIds];

    if (!ids.length) {
        return { jobs: [], blockedKeys: [], blockedLanes: [], rateWaits: [] };
    }

    const columns = `id, lane, array_to_json(${unlessStalledOut('limit_keys')})::text AS limit_keys,
               array_to_json(${unlessStalledOut('limit_maxes')})::text AS limit_maxes,
               ${unlessStalledOut('rate_limits')}::text AS rate_limits, attempts, max_attempts, stalls, max_stalls,
               ${epochMs('created_at')} AS created_at_ms,
               ${epochMs('run_at')} AS run_at_ms,
               (EXTRACT(EPOCH FROM clock_timestamp() - run_at) * 1000)::bigint AS waited_ms${
    withFairGroups ? ', fair_group' : ''}`;
    const pending = `FROM ${p}jobs j
         WHERE j.id = ANY(${arrayParam(1, 'text')}) AND j.status = 'pending' AND j.run_at <= clock_timestamp()
           AND ${notPaused(p, 'j.lane')}
         ORDER BY j.run_at, j.id
           FOR UPDATE SKIP LOCKED`;
    // With the rows of the rate keys of the jobs, once each, in order: "C" sorts their ASCII as JavaScript does
    const locked = (await executor.query(withRates
        ? `
        WITH locked AS (
            SELECT * ${pending}
        ),
        rate_rows AS (${lockRateKeysSql(p, `(
            SELECT DISTINCT e.key COLLATE "C" AS limit_key
              FROM locked CROSS JOIN LATERAL jsonb_to_recordset(locked.rate_limits) AS e(key text)
             WHERE locked.stalls <= locked.max_stalls
        ) AS k ORDER BY k.limit_key`)})
        SELECT ${columns} FROM locked ORDER BY run_at, id`
        : `SELECT ${columns} ${pending}`, [ids])).map(row => ({
        runAtMs: Number(row.run_at_ms),
        /** @type {ClaimedJob} */
        job: {
            id: String(row.id),
            lane: String(row.lane),
            limits: limitsOf(row),
            rateLimits: row.rate_limits === null ? [] : JSON.parse(String(row.rate_limits)),
            attempts: Number(row.attempts),
            maxAttempts: Number(row.max_attempts),
            stalls: Number(row.stalls),
            maxStalls: Number(row.max_stalls),
            enqueuedAt: new Date(Number(row.created_at_ms)),
            runAt: new Date(Number(row.run_at_ms)),
            // Set by the write of the claim
            startedAt: new Date(Number.NaN),
            waitedMs: Number(row.waited_ms),
            lockToken,
            fairGroup: /** @type {string | null | undefined} */ (row.fair_group) ?? null,
        },
    }));
    const keys = [...new Set(locked.flatMap(({ job }) => job.limits.map(limit => limit.key)))];
    /** @type {Map<string, Set<number>>} */
    const heldSlots = new Map();

    if (keys.length) {
        const slotRows = await executor.query(`
            SELECT s.limit_key, s.slot FROM ${p}concurrency_slots s
             WHERE s.limit_key = ANY(${arrayParam(1, 'text')}) AND ${HELD}
        `, [keys]);

        for (const row of slotRows) {
            const key = String(row.limit_key);

            heldSlots.set(key, (heldSlots.get(key) ?? new Set()).add(Number(row.slot)));
        }
    }

    const held = new Map([...heldSlots].map(([key, slots]) => [key, slots.size]));
    /** @type {{ id: string, lane: string, key: string }[]} */
    const blocked = [];
    /** @type {{ job: ClaimedJob, runAtMs: number }[]} */
    const withRoom = [];

    for (const row of locked) {
        // A full concurrency key first: its release unblocks the job, without a timer
        const fullLimit = row.job.limits.find(({ key, max }) => (held.get(key) ?? 0) >= max);

        if (fullLimit) {
            blocked.push({ id: row.job.id, lane: row.job.lane, key: fullLimit.key });
        } else {
            withRoom.push(row);
        }
    }

    const rateKeys = [...new Set(withRoom.flatMap(({ job }) => job.rateLimits.map(limit => limit.key)))].toSorted();

    if (rateKeys.length && !withRates) {
        await executor.query(
            lockRateKeysSql(
                p,
                `unnest(${arrayParam(1, 'text')}) WITH ORDINALITY AS k(limit_key, position) ORDER BY k.position`,
            ),
            [rateKeys],
        );
    }

    const rateStates = rateKeys.length ? await readRateKeys(executor, p, rateKeys) : new Map();
    const { open, blocked: overRate, waits } = splitByRate(withRoom, rateStates);

    blocked.push(...overRate);

    if (blocked.length) {
        await executor.query(`
            UPDATE ${p}jobs j SET status = 'blocked', blocked_on = b.limit_key, updated_at = clock_timestamp()
              FROM unnest(${arrayParam(1, 'text')}, ${arrayParam(2, 'text')}) AS b(id, limit_key)
             WHERE j.id = b.id
        `, [blocked.map(job => job.id), blocked.map(job => job.key)]);
    }

    const picked = pick(open, held, new Map([...rateStates].map(([key, state]) => [key, state.debtUs])));
    const pickedWithLimits = picked.filter(row => row.limits.length);
    const slotsTaken = pickedWithLimits.length
        ? await takeSlots(executor, p, pickedWithLimits, { heldSlots, lockToken })
        : { withAll: new Set(), nowUs: null };
    const claimed = picked.filter(row => !row.limits.length || slotsTaken.withAll.has(row.id));
    // With slots taken, their time, taken when their insert starts: a wait in it on another claim's insert of the same
    // slot comes after that time, so the start is early by that wait (the rest of the other transaction). Taking the
    // time after the inserts would cost one more statement. Without slots, the time of the statement that starts the
    // jobs
    const slotsNowUs = claimed.some(row => row.limits.length) ? slotsTaken.nowUs : null;
    // Only the jobs that start take their quota
    const increments = incrementsOf(claimed);

    // In the same statement: their tat moves by the increments
    const moveTat = `tat AS (
        UPDATE ${p}rate_limits r SET tat = GREATEST(r.tat, clock_timestamp()) + u.inc * interval '1 microsecond'
          FROM unnest(${arrayParam(6, 'text')}, ${arrayParam(7, 'bigint')}) AS u(limit_key, inc)
         WHERE r.limit_key = u.limit_key
    ),`;

    if (claimed.length) {
        // The start of the runs, evaluated once (a materialized CTE): the time of their slots when they took some (as
        // stored, in epoch µs: exact), else now. RETURNING gives the stored value, rounded to the millisecond
        const rows = await executor.query(`
            WITH ${increments.size ? moveTat : ''}
            t AS MATERIALIZED (
                SELECT COALESCE(timestamptz 'epoch' + $5::bigint * interval '1 microsecond', clock_timestamp()) AS now
            )
            UPDATE ${p}jobs j
               SET status = 'running', lock_token = $2, locked_by = $3,
                   locked_until = t.now + $4 * interval '1 millisecond', started_at = t.now,
                   timed_out_at = NULL, updated_at = t.now
              FROM t
             WHERE j.id = ANY(${arrayParam(1, 'text')})
            RETURNING j.id AS id, ${epochMs('j.started_at')} AS startedat
        `, [
            claimed.map(row => row.id),
            lockToken,
            lockedBy,
            leaseMs,
            slotsNowUs,
            ...increments.size ? [[...increments.keys()], [...increments.values()]] : [],
        ]);
        const startedAt = new Map(rows.map(row => [String(row.id), new Date(Number(row.startedat))]));

        for (const job of claimed) {
            job.startedAt = /** @type {Date} */ (startedAt.get(job.id));
        }
    }

    return {
        jobs: claimed,
        blockedKeys: [...new Set(blocked.map(job => job.key))],
        blockedLanes: [...new Set(blocked.map(job => job.lane))],
        rateWaits: waits,
    };
}

/**
 * @param {boolean} withFairGroups The schema has the column of the groups: RETURNING has it.
 * @returns {string} The column of the fair group in the RETURNING of a claim: ', j.fair_group', or ''.
 */
const returnedGroup = withFairGroups => (withFairGroups ? ', j.fair_group' : '');

/**
 * @param {string} p
 * @param {boolean} withFairGroups The CTE `claimed` returns the fair group.
 * @returns {string} The jobs of the CTE `claimed`, with their payloads, as a JSON text: oldest first.
 */
function claimedJobsJson(p, withFairGroups) {
    return `(
        SELECT json_agg(json_build_object(
                   ${withFairGroups ? '\'fairGroup\', c.fair_group, ' : ''}'id', c.id, 'lane', c.lane, 'attempts', c.attempts,
                   'maxAttempts', c.max_attempts, 'stalls', c.stalls, 'maxStalls', c.max_stalls,
                   'createdAtMs', c.created_at_ms, 'waitedMs', c.waited_ms,
                   'runAtMs', ${epochMs('c.run_at')}, 'startedAtMs', ${epochMs('c.started_at')},
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
    /** @type {{ id: string, lane: string, attempts: number, maxAttempts: number, stalls: number, maxStalls: number,
     *     createdAtMs: number, waitedMs: number, runAtMs: number, startedAtMs: number, found: boolean,
     *     payload: unknown, fairGroup?: string | null }[]} */
    const jobs = (json ?? null) === null ? [] : JSON.parse(String(json));

    return jobs.map(job => ({
        id: job.id,
        lane: job.lane,
        limits: [],
        rateLimits: [],
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        stalls: job.stalls,
        maxStalls: job.maxStalls,
        enqueuedAt: new Date(job.createdAtMs),
        runAt: new Date(Number(job.runAtMs)),
        startedAt: new Date(Number(job.startedAtMs)),
        waitedMs: job.waitedMs,
        lockToken,
        fairGroup: job.fairGroup ?? null,
        payload: job.found ? { found: true, payload: job.payload } : { found: false, payload: undefined },
    }));
}

/**
 * The choice of a claim of due jobs among the rows of the CTE `locked` (`id`, `limits`, `share`, `tie`, `run_at`), as
 * `fill()`: by share, then the tie, row by row. Without local limits, the free slots of the instance are the only cap:
 * the first rows by share. With them, a walk row by row: a row is taken while the instance and each of its limits have
 * room (a lane can have several limits, so one `ROW_NUMBER` per limit would not do). `$7`: the rooms; `$8`: the free
 * slots.
 * @param {boolean} withLimits A request has local limits.
 * @returns {string} The CTEs `ordered`, `walk` and `picked`, or `picked` alone; each followed by a comma.
 */
function pickSql(withLimits) {
    return withLimits
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
}

/**
 * Finds, chooses, claims and reads the due jobs of lanes without global limits, in one statement (a transaction of its
 * own). Each lane locks its oldest due jobs that no other claim holds (SKIP LOCKED), up to its `maxJobs`. The locked
 * rows are taken in the order of their share, `(running + rank in the lane − 1) / weight`, then the tie order, within
 * the free slots of the local limits and of the instance: the order of `fill()` (fair_share.js), row by row. Then the
 * next due time of each requested lane, among its pending jobs that this claim did not take.
 * @param {Executor} executor Outside a transaction.
 * @param {string} p
 * @param {import('./store.js').ClaimDueParams} params
 * @returns {Promise<import('./store.js').ClaimDueResult>} The jobs in the order of run_at.
 */
export async function claimDue(executor, p, {
    requests, limitRooms, free, lockToken, lockedBy, leaseMs, withFairGroups = false,
}) {
    if (!requests.length || free <= 0) {
        return { jobs: [], next: [], unpicked: [], limited: [] };
    }

    if (requests.some(request => request.groups)) {
        // A lane with fair groups: the general statement, which orders its rows by group and cuts at its maxJobs
        return claimDueGrouped(executor, p, { requests, limitRooms, free, lockToken, lockedBy, leaseMs });
    }

    if (requests.length === 1) {
        const [{ name, maxJobs }] = requests;
        // One lane: nothing to share
        const result = await claimDueOfLane(executor, p, {
            name,
            limit: Math.min(maxJobs, free),
            lockToken,
            lockedBy,
            leaseMs,
            withFairGroups,
        });

        return { ...result, unpicked: [] };
    }

    const pick = pickSql(requests.some(request => request.limits.length));
    // One row: the claimed jobs, the next due times and the lanes of the locked rows left, as JSON texts. Bigints: a
    // localMaxConcurrency may be above 2^31
    const [row] = await executor.query(`
        WITH RECURSIVE limit_rooms AS (
            -- Typed here: only the walk reads it
            SELECT $7::bigint[] AS rooms
        ),
        -- The requested lanes that no pause holds: the claim and the next due times read them
        request AS (
            SELECT r.name, r.max_jobs, r.running, r.weight, r.limits::integer[] AS limits, r.tie
              FROM unnest(
                       ${arrayParam(1, 'text')}, ${arrayParam(2, 'bigint')}, ${arrayParam(3, 'bigint')},
                       ${arrayParam(4, 'integer')}, ${arrayParam(5, 'text')}, ${arrayParam(6, 'integer')}
                   )
                AS r(name, max_jobs, running, weight, limits, tie)
             WHERE ${notPaused(p, 'r.name')}
        ),
        locked_all AS (
            SELECT due.id, due.run_at, due.limited, request.name, request.limits, request.tie, request.running,
                   request.weight
              FROM request
             CROSS JOIN LATERAL (
                 SELECT id, run_at, ${LIMITED} AS limited FROM ${p}jobs
                  WHERE status = 'pending' AND lane = request.name AND run_at <= clock_timestamp()
                  ORDER BY run_at, id LIMIT request.max_jobs
                    FOR UPDATE SKIP LOCKED
             ) AS due
        ),
        -- The rows with global limits (from their enqueue options) are left to the claim of lanes with limits
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
            RETURNING j.id, j.lane, j.run_at, j.started_at, j.attempts, j.max_attempts, j.stalls, j.max_stalls,
                      ${epochMs('j.created_at')} AS created_at_ms,
                      (EXTRACT(EPOCH FROM clock_timestamp() - j.run_at) * 1000)::bigint AS waited_ms${returnedGroup(withFairGroups)}
        ),
        -- The statement's snapshot: the picked jobs are still pending in it. A full claim does not read them: the next
        -- turn claims again
        next AS (
            SELECT request.name AS lane,
                   (EXTRACT(EPOCH FROM n.run_at - clock_timestamp()) * 1000)::bigint AS delay_ms
              FROM request
             CROSS JOIN LATERAL (
                 SELECT run_at FROM ${p}jobs
                  WHERE status = 'pending' AND lane = request.name AND id NOT IN (SELECT id FROM picked)
                  ORDER BY run_at LIMIT 1
             ) AS n
             WHERE (SELECT count(*) FROM picked) < $8
        )
        SELECT ${claimedJobsJson(p, withFairGroups)} AS jobs,
               (SELECT count(*) FROM picked) >= $8 AS full,
               (SELECT json_agg(json_build_object('name', lane, 'delayMs', delay_ms)) FROM next)::text AS next,
               -- The lanes with a locked row left, under any cap: the runner replays the choice for its tie pointer
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
 * Claims the due jobs of one lane, as `claimDue`. Scalar parameters: PostgreSQL caches a generic plan of the prepared
 * statement, and plans it no more.
 * @param {Executor} executor Outside a transaction.
 * @param {string} p
 * @param {{ name: string, limit: number, lockToken: string, lockedBy: string, leaseMs: number,
 *     withFairGroups: boolean }} params
 * @returns {Promise<import('./store.js').ClaimDueResult>}
 */
async function claimDueOfLane(executor, p, { name, limit, lockToken, lockedBy, leaseMs, withFairGroups }) {
    const [row] = await executor.query(`
        WITH locked AS (
            SELECT id, ${LIMITED} AS limited FROM ${p}jobs
             WHERE status = 'pending' AND lane = $1 AND run_at <= clock_timestamp() AND ${notPaused(p, '$1')}
             ORDER BY run_at, id LIMIT $2
               FOR UPDATE SKIP LOCKED
        ),
        -- The rows with global limits (from their enqueue options) are left to the claim of lanes with limits
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
            RETURNING j.id, j.lane, j.run_at, j.started_at, j.attempts, j.max_attempts, j.stalls, j.max_stalls,
                      ${epochMs('j.created_at')} AS created_at_ms,
                      (EXTRACT(EPOCH FROM clock_timestamp() - j.run_at) * 1000)::bigint AS waited_ms${returnedGroup(withFairGroups)}
        )
        -- The statement's snapshot: the picked jobs are still pending in it
        SELECT ${claimedJobsJson(p, withFairGroups)} AS jobs,
               (
                   SELECT (EXTRACT(EPOCH FROM run_at - clock_timestamp()) * 1000)::bigint FROM ${p}jobs
                    WHERE status = 'pending' AND lane = $1 AND id NOT IN (SELECT id FROM picked)
                      AND ${notPaused(p, '$1')}
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
 * `claimDue` with lanes with fair groups (their requests have `groups`). As `claimDue`, but a grouped lane locks the
 * oldest due jobs of each requested group, not of the lane: per group request, in two CTEs (`grouped`: a group;
 * `ungrouped`: the null group), each a LATERAL with an ordered scan of `<p>jobs_pending_group` (`ORDER BY fair_group,
 * run_at, id`: the group is fixed per branch, and the order makes the generic plan read the index, not filter the lane;
 * no `OR`, which would lose the ordered scan; no `FOR UPDATE` in a `UNION`, which PostgreSQL rejects). The rows of a
 * grouped lane rank in the order of `fill()` over its groups (`fair_groups.js`): by `running + rank in the group − 1`,
 * then the tie of the group; its rows past its `maxJobs` are cut (it locks more: the extra groups and the slack). Then
 * the lane share of the k-th row and the pick, as `claimDue`. Always returns the fair group.
 * @param {Executor} executor Outside a transaction.
 * @param {string} p
 * @param {Omit<import('./store.js').ClaimDueParams, 'choose'>} params
 * @returns {Promise<import('./store.js').ClaimDueResult>}
 */
async function claimDueGrouped(executor, p, { requests, limitRooms, free, lockToken, lockedBy, leaseMs }) {
    const groups = requests.flatMap(request => (request.groups ?? []).map(({ group, running, tie, maxJobs }) => ({
        lane: request.name, group, running, tie, maxJobs,
    })));
    const [row] = await executor.query(`
        WITH RECURSIVE limit_rooms AS (
            SELECT $7::bigint[] AS rooms
        ),
        request AS (
            SELECT r.name, r.max_jobs, r.running, r.weight, r.limits::integer[] AS limits, r.tie
              FROM unnest(
                       ${arrayParam(1, 'text')}, ${arrayParam(2, 'bigint')}, ${arrayParam(3, 'bigint')},
                       ${arrayParam(4, 'integer')}, ${arrayParam(5, 'text')}, ${arrayParam(6, 'integer')}
                   )
                AS r(name, max_jobs, running, weight, limits, tie)
             WHERE ${notPaused(p, 'r.name')}
        ),
        -- The groups of the lanes that no pause holds
        group_request AS (
            SELECT g.lane, g.grp, g.running AS g_running, g.tie AS g_tie, g.max_jobs AS g_max
              FROM unnest(
                       ${arrayParam(12, 'text')}, ${arrayParam(13, 'text')}, ${arrayParam(14, 'bigint')},
                       ${arrayParam(15, 'integer')}, ${arrayParam(16, 'bigint')}
                   )
                AS g(lane, grp, running, tie, max_jobs)
             WHERE g.lane IN (SELECT name FROM request)
        ),
        plain AS (
            SELECT due.id, due.run_at, due.limited, due.fair_group, request.name, request.limits, request.tie,
                   request.running, request.weight, request.max_jobs, 0::bigint AS g_running, 0 AS g_tie,
                   false AS grouped
              FROM request
             CROSS JOIN LATERAL (
                 SELECT id, run_at, fair_group, ${LIMITED} AS limited FROM ${p}jobs
                  WHERE status = 'pending' AND lane = request.name AND run_at <= clock_timestamp()
                  ORDER BY run_at, id LIMIT request.max_jobs
                    FOR UPDATE SKIP LOCKED
             ) AS due
             WHERE request.name NOT IN (SELECT lane FROM group_request)
        ),
        grouped AS (
            SELECT due.id, due.run_at, due.limited, due.fair_group, request.name, request.limits, request.tie,
                   request.running, request.weight, request.max_jobs, gr.g_running, gr.g_tie, true AS grouped
              FROM group_request gr
              JOIN request ON request.name = gr.lane
             CROSS JOIN LATERAL (
                 SELECT id, run_at, fair_group, ${LIMITED} AS limited FROM ${p}jobs
                  WHERE status = 'pending' AND lane = gr.lane AND fair_group = gr.grp
                    AND run_at <= clock_timestamp()
                  ORDER BY fair_group, run_at, id LIMIT gr.g_max
                    FOR UPDATE SKIP LOCKED
             ) AS due
             WHERE gr.grp IS NOT NULL
        ),
        ungrouped AS (
            SELECT due.id, due.run_at, due.limited, due.fair_group, request.name, request.limits, request.tie,
                   request.running, request.weight, request.max_jobs, gr.g_running, gr.g_tie, true AS grouped
              FROM group_request gr
              JOIN request ON request.name = gr.lane
             CROSS JOIN LATERAL (
                 SELECT id, run_at, fair_group, ${LIMITED} AS limited FROM ${p}jobs
                  WHERE status = 'pending' AND lane = gr.lane AND fair_group IS NULL
                    AND run_at <= clock_timestamp()
                  ORDER BY fair_group, run_at, id LIMIT gr.g_max
                    FOR UPDATE SKIP LOCKED
             ) AS due
             WHERE gr.grp IS NULL
        ),
        locked_all AS (
            SELECT * FROM plain UNION ALL SELECT * FROM grouped UNION ALL SELECT * FROM ungrouped
        ),
        -- The rank of a row in its group (a plain lane: one group), then in its lane: the order of fill() over the
        -- groups. The rows with global limits (from their enqueue options) are left to the claim of lanes with limits
        in_group AS (
            SELECT *, ROW_NUMBER() OVER (
                       PARTITION BY name, CASE WHEN grouped THEN fair_group END ORDER BY run_at, id
                   ) AS group_rank
              FROM locked_all WHERE NOT limited
        ),
        in_lane AS (
            SELECT *, ROW_NUMBER() OVER (
                       PARTITION BY name ORDER BY g_running + group_rank - 1, g_tie, run_at, id
                   ) AS lane_rank
              FROM in_group
        ),
        locked AS (
            SELECT id, run_at, name, limits, tie, (running + lane_rank - 1)::float8 / weight AS share
              FROM in_lane WHERE lane_rank <= max_jobs
        ),
        ${pickSql(requests.some(request => request.limits.length))}
        claimed AS (
            UPDATE ${p}jobs AS j
               SET status = 'running', lock_token = $9, locked_by = $10,
                   locked_until = clock_timestamp() + $11 * interval '1 millisecond', started_at = clock_timestamp(),
                   timed_out_at = NULL, updated_at = clock_timestamp()
              FROM picked
             WHERE j.id = picked.id
            RETURNING j.id, j.lane, j.run_at, j.started_at, j.attempts, j.max_attempts, j.stalls, j.max_stalls,
                      ${epochMs('j.created_at')} AS created_at_ms,
                      (EXTRACT(EPOCH FROM clock_timestamp() - j.run_at) * 1000)::bigint AS waited_ms${returnedGroup(true)}
        ),
        next AS (
            SELECT request.name AS lane,
                   (EXTRACT(EPOCH FROM n.run_at - clock_timestamp()) * 1000)::bigint AS delay_ms
              FROM request
             CROSS JOIN LATERAL (
                 SELECT run_at FROM ${p}jobs
                  WHERE status = 'pending' AND lane = request.name AND id NOT IN (SELECT id FROM picked)
                  ORDER BY run_at LIMIT 1
             ) AS n
             WHERE (SELECT count(*) FROM picked) < $8
        )
        SELECT ${claimedJobsJson(p, true)} AS jobs,
               (SELECT count(*) FROM picked) >= $8 AS full,
               (SELECT json_agg(json_build_object('name', lane, 'delayMs', delay_ms)) FROM next)::text AS next,
               (SELECT json_agg(DISTINCT name) FROM locked WHERE id NOT IN (SELECT id FROM picked))::text AS unpicked,
               (SELECT json_agg(DISTINCT name) FROM locked_all WHERE limited)::text AS limited,
               -- The groups of the grouped lanes with a locked row left, cut or not: the replay of their pointers
               (
                   SELECT json_agg(DISTINCT jsonb_build_array(name, fair_group))
                     FROM in_lane WHERE grouped AND id NOT IN (SELECT id FROM picked)
               )::text AS left_groups
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
        groups.map(group => group.lane),
        groups.map(group => group.group),
        groups.map(group => group.running),
        groups.map(group => group.tie),
        groups.map(group => group.maxJobs),
    ]);
    /** @type {ProbeRow[] | null} */
    let next = (row?.next ?? null) === null ? [] : JSON.parse(String(row?.next));

    if (row?.full) {
        next = null;
    }

    /** @type {Map<string, (string | null)[]>} */
    const leftGroups = new Map();

    for (const [lane, group] of (row?.left_groups ?? null) === null ? [] : JSON.parse(String(row?.left_groups))) {
        leftGroups.set(lane, [...leftGroups.get(lane) ?? [], group]);
    }

    return {
        jobs: parseClaimedJobs(row?.jobs, lockToken),
        next,
        unpicked: (row?.unpicked ?? null) === null ? [] : JSON.parse(String(row?.unpicked)),
        limited: (row?.limited ?? null) === null ? [] : JSON.parse(String(row?.limited)),
        leftGroups,
    };
}

/**
 * The groups of each given lane with pending jobs, and the next due time of each (zero or less: due), not paused. A
 * recursive CTE skips from one group to the next on `<p>jobs_pending_group` (`min(fair_group) > the last one`), then
 * one
 * lookup of the first due time per group; and a lookup of the null group (`ORDER BY fair_group, run_at`: the same
 * index). Two index lookups per pending group.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} lanes
 * @returns {Promise<import('./store.js').GroupProbeRow[]>}
 */
export async function probeGroups(executor, p, lanes) {
    if (!lanes.length) {
        return [];
    }

    const rows = await executor.query(`
        WITH RECURSIVE lane AS (
            SELECT r.name FROM unnest(${arrayParam(1, 'text')}) AS r(name) WHERE ${notPaused(p, 'r.name')}
        ),
        named AS (
            SELECT lane.name, (
                       SELECT min(j.fair_group) FROM ${p}jobs j WHERE j.status = 'pending' AND j.lane = lane.name
                   ) AS grp
              FROM lane
            UNION ALL
            SELECT named.name, (
                       SELECT min(j.fair_group) FROM ${p}jobs j
                        WHERE j.status = 'pending' AND j.lane = named.name AND j.fair_group > named.grp
                   )
              FROM named WHERE named.grp IS NOT NULL
        ),
        heads AS (
            SELECT named.name, named.grp, (
                       SELECT j.run_at FROM ${p}jobs j
                        WHERE j.status = 'pending' AND j.lane = named.name AND j.fair_group = named.grp
                        ORDER BY j.fair_group, j.run_at LIMIT 1
                   ) AS run_at
              FROM named WHERE named.grp IS NOT NULL
            UNION ALL
            SELECT lane.name, NULL, (
                       SELECT j.run_at FROM ${p}jobs j
                        WHERE j.status = 'pending' AND j.lane = lane.name AND j.fair_group IS NULL
                        ORDER BY j.fair_group, j.run_at LIMIT 1
                   )
              FROM lane
        )
        SELECT name AS lane, grp AS fair_group,
               (EXTRACT(EPOCH FROM run_at - clock_timestamp()) * 1000)::bigint AS delay_ms
          FROM heads WHERE run_at IS NOT NULL
    `, [lanes]);

    return rows.map(row => ({
        lane: String(row.lane),
        group: (row.fair_group ?? null) === null ? null : String(row.fair_group),
        delayMs: Number(row.delay_ms),
    }));
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
        SELECT id, payload::text AS payload FROM ${p}payloads WHERE id = ANY(${arrayParam(1, 'text')})
    `, [ids]);

    return new Map(rows.map(row => [String(row.id), JSON.parse(String(row.payload))]));
}
