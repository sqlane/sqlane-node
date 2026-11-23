// The worker side of the store on MariaDB: probe, candidates, claim. Times are computed in SQL, in UTC. A copy of the
// MySQL version, changed where MariaDB differs: keep the two in step.
import { incrementsOf, splitByRate } from '../gcra.js';

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').ProbeRow} ProbeRow */
/** @typedef {import('./store.js').Candidate} Candidate */
/** @typedef {import('./store.js').ClaimParams} ClaimParams */
/** @typedef {import('./store.js').ClaimedJob} ClaimedJob */
/** @typedef {{ key: string, slot: number, id: string }} SlotHold A slot of a key, taken for a job */

/** The due jobs of each name with global limits that a search of candidates reads */
export const LIMIT_WINDOW_SIZE = 500;

const NOW = 'UTC_TIMESTAMP(3)';
/** The clock of the rate keys: µs */
const NOW_US = 'UTC_TIMESTAMP(6)';
// The writes by a list of keys force the index: on a small table, MariaDB scans the whole table instead, and waits for
// the rows that other claims hold (a deadlock). The DELETE of several rows uses the multi-table form, which takes
// hints.
/**
 * @param {string} column
 * @returns {string} The epoch milliseconds of a time column.
 */
const epochMs = column => `TIMESTAMPDIFF(MICROSECOND, '1970-01-01', ${column}) DIV 1000`;
const HELD = `(s.held_until IS NULL OR s.held_until >= ${NOW})`;
/**
 * The settings of the rate keys of a JSON array (`rate_limits`), as JSON_TABLE columns.
 * @param {string} json
 * @returns {string} `e`, with `limit_key`, `max_starts`, `per_us`, `burst` and `cost`.
 */
export const rateLimitsTable = json => `JSON_TABLE(${json}, '$[*]' COLUMNS (
    limit_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PATH '$.key',
    max_starts BIGINT PATH '$.max',
    per_us BIGINT PATH '$.per_us',
    burst BIGINT PATH '$.burst',
    cost BIGINT PATH '$.cost'
)) AS e`;

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
 * The SQL of the probe. `GROUP BY status, lane`: the whole index prefix, else MariaDB does not use a loose index
 * scan.
 * @param {string} p
 * @param {number} [nameCount] The names of the probe, as parameters; none: all names.
 * @returns {string}
 */
export function probeSql(p, nameCount = 0) {
    const names = nameCount ? ` AND lane IN (${Array.from({ length: nameCount }, () => '?').join(', ')})` : '';

    return `
        SELECT lane, TIMESTAMPDIFF(MICROSECOND, ${NOW}, MIN(run_at)) DIV 1000 AS delay_ms
          FROM ${p}jobs FORCE INDEX (${p}jobs_status_lane_run_at)
         WHERE status = 'pending'${names}
         GROUP BY status, lane
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

    return rows.map(row => ({ name: String(row.lane), delayMs: Number(row.delay_ms) }));
}

/**
 * @param {string} p
 * @param {string[]} names
 * @param {(index: number) => string} limitSql
 * @param {boolean} withRates With the rate keys of the jobs; without, a column `rated`: the job has rate keys.
 * @returns {string} The oldest due jobs of each name, one index range per name.
 */
function dueJobsSql(p, names, limitSql, withRates) {
    return names.map((_, index) => `(
        SELECT id, lane, run_at, limit_keys, limit_maxes,
               ${withRates ? 'rate_limits' : 'rate_limits IS NOT NULL AS rated'} FROM ${p}jobs
          FORCE INDEX (${p}jobs_status_lane_run_at)
         WHERE status = 'pending' AND lane = ? AND run_at <= ${NOW}
         ORDER BY run_at, id LIMIT ${limitSql(index)}
    )`).join(' UNION ALL ');
}

/**
 * The due jobs of names with global limits, oldest first: at most `limit` of each name whose keys have room, and those
 * with a full key, which the claim blocks. A key is full when its held slots reach the max of the job, or a rate key
 * has no quota left for it after the older jobs of the search. Without `withRates`, the search leaves out the rate
 * keys, and returns its jobs that have some too, past the max of their name: they tell their names (store.js).
 * @param {Executor} executor
 * @param {string} p
 * @param {Map<string, number>} limitsByName
 * @param {boolean} withRates
 * @returns {Promise<import('./store.js').FoundCandidatesOf>}
 */
export async function findCandidates(executor, p, limitsByName, withRates) {
    const names = [...limitsByName.keys()];

    if (!names.length) {
        return { startable: [], full: [], ratedNames: [] };
    }

    const conditions = names.map(() => '(lane = ? AND name_rank <= ?)').join(' OR ');
    /**
     * @param {string} column
     * @returns {string} Of the oldest job blocked on the key.
     */
    const ofHead = column => `(
        SELECT ${column} FROM ${p}jobs b FORCE INDEX (${p}jobs_blocked)
         WHERE b.status = 'blocked' AND b.blocked_on = f.limit_key ORDER BY b.run_at, b.id LIMIT 1
    )`;
    const rates = `
        wr AS (
            SELECT w.id, w.run_at, e.limit_key, (e.cost * e.per_us + e.max_starts - 1) DIV e.max_starts AS inc_us,
                   (e.cost * e.per_us + e.max_starts - 1) DIV e.max_starts
                       + (e.burst - e.cost) * e.per_us DIV e.max_starts AS allow_us
              FROM w, ${rateLimitsTable('w.rate_limits')}
        ),
        -- The debt of each rate key, and its oldest blocked job: the jobs after it wait behind it
        rate AS (
            SELECT f.limit_key,
                   COALESCE((
                       SELECT GREATEST(TIMESTAMPDIFF(MICROSECOND, ${NOW_US}, r.tat), 0) FROM ${p}rate_limits r
                        WHERE r.limit_key = f.limit_key
                   ), 0) AS debt_us,
                   ${ofHead('b.run_at')} AS head_run_at, ${ofHead('b.id')} AS head_id
              FROM (SELECT DISTINCT limit_key FROM wr) AS f
        ),
        -- The jobs over the quota of a rate key, after the older jobs of the search
        rate_full AS (
            SELECT DISTINCT x.id FROM (
                SELECT wr.*, SUM(wr.inc_us) OVER (PARTITION BY wr.limit_key ORDER BY wr.run_at, wr.id) AS used_us
                  FROM wr
            ) AS x
              JOIN rate ON rate.limit_key = x.limit_key
             WHERE rate.debt_us + x.used_us > x.allow_us OR rate.head_run_at < x.run_at
                OR (rate.head_run_at = x.run_at AND rate.head_id < x.id)
        ),`;
    const rows = await executor.query(`
        WITH w AS (${dueJobsSql(p, names, () => String(LIMIT_WINDOW_SIZE), withRates)}),
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
        ),${withRates ? rates : ''}
        marked AS (
            SELECT w.id, w.lane, w.run_at, ${withRates ? '' : 'w.rated,'}
                   EXISTS (
                       SELECT 1 FROM wk JOIN held h ON h.limit_key = wk.limit_key
                        WHERE wk.id = w.id AND h.held >= wk.max_slots
                   ) ${withRates ? 'OR w.id IN (SELECT id FROM rate_full)' : ''} AS is_full
              FROM w
        ),
        ranked AS (
            SELECT marked.*, ROW_NUMBER() OVER (PARTITION BY lane, is_full ORDER BY run_at, id) AS name_rank
              FROM marked
        )
        SELECT id, lane, ${epochMs('run_at')} AS run_at_ms, is_full${withRates ? '' : ', rated'}
          FROM ranked WHERE is_full OR ${conditions}${withRates ? '' : ' OR rated'}
         ORDER BY run_at, id
    `, [...names, ...names.flatMap(name => [name, limitsByName.get(name)])]);
    const candidates = rows.map(row => ({
        id: String(row.id),
        name: String(row.lane),
        runAtMs: Number(row.run_at_ms),
        full: Boolean(Number(row.is_full)),
    }));

    return {
        startable: candidates.filter(row => !row.full).map(({ id, name, runAtMs }) => ({ id, name, runAtMs })),
        full: candidates.filter(row => row.full).map(({ id, name, runAtMs }) => ({ id, name, runAtMs })),
        ratedNames: [...new Set(rows.filter(row => Number(row.rated)).map(row => String(row.lane)))],
    };
}

/**
 * Takes a slot of each key of the picked jobs, all or none per job: the lowest free slots. A held slot stays with its
 * holder; an ended linger is taken over. Slots are inserted in the order of (key, slot): no deadlocks between claims.
 * @param {Executor} executor
 * @param {string} p
 * @param {ClaimedJob[]} jobs The picked jobs with global limits.
 * @param {{ heldSlots: Map<string, Set<number>>, lockToken: string }} params The held slots of their keys.
 * @returns {Promise<{ withAll: Set<string>, holds: SlotHold[], nowMs: number }>} The ids of the jobs that got a slot
 *     of each key; their slots; the database time of the read of the slots, after the waits of the insert.
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
    // held_until last: MariaDB sets the columns from left to right, and the others read its old value
    /**
     * @param {string} column
     * @returns {string} Takes the new value over an ended linger.
     */
    const takeOver = column => `${column} = IF(${p}concurrency_slots.held_until < ${NOW}, VALUES(${column}), `
        + `${p}concurrency_slots.${column})`;

    await executor.query(`
        INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
        VALUES ${holds.map(() => `(?, ?, ?, ?, NULL, ${NOW})`).join(', ')}
        ON DUPLICATE KEY UPDATE ${takeOver('job_id')}, ${takeOver('lock_token')}, ${takeOver('created_at')},
            held_until = IF(${p}concurrency_slots.held_until < ${NOW}, NULL, ${p}concurrency_slots.held_until)
    `, holds.flatMap(hold => [hold.key, hold.slot, hold.id, lockToken]));

    // One more row, without a slot: the read gives its time also when it acquired nothing, after the waits of the
    // insert
    const acquiredRows = await executor.query(`
        SELECT limit_key, job_id, ${epochMs(NOW)} AS nowms FROM ${p}concurrency_slots
         WHERE (limit_key, slot) IN (${holds.map(() => '(?, ?)').join(', ')}) AND lock_token = ?
        UNION ALL
        SELECT NULL, NULL, ${epochMs(NOW)}
    `, [...holds.flatMap(hold => [hold.key, hold.slot]), lockToken]);
    const acquired = new Set(acquiredRows.filter(row => row.job_id !== null)
        .map(row => `${row.job_id}\n${row.limit_key}`));
    const withAll = new Set(jobs
        .filter(job => job.limits.every(({ key }) => acquired.has(`${job.id}\n${key}`)))
        .map(job => job.id));
    const partial = holds.filter(hold => !withAll.has(hold.id) && acquired.has(`${hold.id}\n${hold.key}`));

    if (partial.length) {
        await executor.query(`
            DELETE s FROM ${p}concurrency_slots s FORCE INDEX (PRIMARY)
             WHERE (s.limit_key, s.slot) IN (${partial.map(() => '(?, ?)').join(', ')}) AND s.lock_token = ?
        `, [...partial.flatMap(hold => [hold.key, hold.slot]), lockToken]);
    }

    return {
        withAll,
        holds: holds.filter(hold => withAll.has(hold.id)),
        nowMs: Number(acquiredRows[0].nowms),
    };
}

/**
 * Locks the rows of the rate keys, in the order of the keys (no deadlocks between claims), and creates the missing
 * ones: a new key has its full quota. Then reads them, with the oldest job blocked on each key: a plain read sees the
 * locked rows as they are.
 * @param {Executor} executor In the transaction of the claim.
 * @param {string} p
 * @param {string[]} keys Sorted.
 * @returns {Promise<{ states: Map<string, import('../gcra.js').RateKeyState>, nowMs: number | null }>} The states of
 *     the keys, and the database time of their read.
 */
async function lockRateKeys(executor, p, keys) {
    await executor.query(`
        INSERT INTO ${p}rate_limits (limit_key, tat) VALUES ${keys.map(() => `(?, ${NOW_US})`).join(', ')}
        ON DUPLICATE KEY UPDATE tat = tat
    `, keys);

    /**
     * @param {string} column
     * @returns {string} Of the oldest job blocked on the key.
     */
    const ofHead = column => `(
        SELECT ${column} FROM ${p}jobs b FORCE INDEX (${p}jobs_blocked)
         WHERE b.status = 'blocked' AND b.blocked_on = r.limit_key ORDER BY b.run_at, b.id LIMIT 1
    )`;
    const rows = await executor.query(`
        SELECT r.limit_key, GREATEST(TIMESTAMPDIFF(MICROSECOND, ${NOW_US}, r.tat), 0) AS debt_us, ${epochMs(NOW)} AS nowms,
               ${ofHead('b.id')} AS head_id, ${ofHead(epochMs('b.run_at'))} AS head_run_at_ms
          FROM ${p}rate_limits r WHERE r.limit_key IN (${placeholders(keys.length)})
    `, keys);

    return {
        states: new Map(rows.map(row => [String(row.limit_key), {
            debtUs: Number(row.debt_us),
            head: row.head_id === null ? null : { runAtMs: Number(row.head_run_at_ms), id: String(row.head_id) },
        }])),
        nowMs: rows.length ? Number(rows[0].nowms) : null,
    };
}

/**
 * @param {string} j The alias of the jobs, with its dot, or nothing.
 * @returns {string} The columns of a started job: 4 parameters, the lock token, the process, the lease in µs and the
 *     start in epoch µs.
 */
const startedColumns = j => `${j}status = 'running', ${j}lock_token = ?, ${j}locked_by = ?,
               ${j}locked_until = ${NOW} + INTERVAL ? MICROSECOND, ${j}started_at = '1970-01-01' + INTERVAL ? MICROSECOND,
               ${j}timed_out_at = NULL, ${j}updated_at = ${NOW}`;

/**
 * Starts the claimed jobs: running, with their lease, and `started_at` at `nowMs`, the database time of the claim's
 * latest read. Their new slots get the same time, in the same statement: the slots of `holds` are read by their
 * primary key, through a derived table of the holds, one row each. Its columns are ascii, as the columns that it joins:
 * with the utf8mb4 of a bare parameter, the join cannot use a key on the derived table, and reads it once per job; a
 * collation mix fails on MariaDB 11.8. The CASTs are in each branch of the UNION: MySQL 8.4 fails a prepared statement
 * whose branches differ. No `UPDATE … RETURNING` on MySQL and MariaDB: the time is written, not read back. As epoch µs,
 * never as a Date, which the time zone settings of a driver would shift.
 * @param {Executor} executor In the transaction of the claim: the jobs and the slots are locked by it.
 * @param {string} p
 * @param {{ ids: string[], holds: SlotHold[], nowMs: number, lockToken: string,
 *     lockedBy: string, leaseMs: number }} params
 * @returns {Promise<void>}
 */
async function startJobs(executor, p, { ids, holds, nowMs, lockToken, lockedBy, leaseMs }) {
    const setParams = [lockToken, lockedBy, leaseMs * 1000, nowMs * 1000];

    if (!holds.length) {
        await executor.query(`
            UPDATE ${p}jobs FORCE INDEX (PRIMARY)
               SET ${startedColumns('')}
             WHERE id IN (${placeholders(ids.length)})
        `, [...setParams, ...ids]);

        return;
    }

    const ascii = 'CAST(? AS CHAR(255) CHARACTER SET ascii) COLLATE ascii_bin';
    const rows = holds.map(() => `SELECT ${ascii} AS k, CAST(? AS SIGNED) AS sl, ${ascii} AS jid`).join(' UNION ALL ');

    await executor.query(`
        UPDATE ${p}jobs j FORCE INDEX (PRIMARY)
          LEFT JOIN (${rows}) h ON h.jid = j.id
          LEFT JOIN ${p}concurrency_slots s FORCE INDEX (PRIMARY)
            ON s.limit_key = h.k AND s.slot = h.sl AND s.job_id = j.id AND s.lock_token = ?
           SET ${startedColumns('j.')}, s.created_at = '1970-01-01' + INTERVAL ? MICROSECOND
         WHERE j.id IN (${placeholders(ids.length)})
    `, [
        ...holds.flatMap(hold => [hold.key, hold.slot, hold.id]),
        lockToken,
        ...setParams,
        nowMs * 1000,
        ...ids,
    ]);
}

/**
 * Claims due jobs among the candidates, and blocks those with a full key. Call it in a queue transaction. The order of
 * the locks: the jobs, the rows of their rate keys, then their slots; the tat of a rate key moves only for the jobs
 * that got all their slots, so nothing is given back.
 * @param {Executor} executor
 * @param {string} p
 * @param {ClaimParams} params
 * @returns {Promise<import('./store.js').ClaimResult>}
 */
export async function claim(executor, p, { candidateIds, fullIds, lockToken, lockedBy, leaseMs, pick }) {
    const ids = [...candidateIds, ...fullIds];

    if (!ids.length) {
        return { jobs: [], blockedKeys: [], blockedNames: [], rateWaits: [] };
    }

    const lockedRows = await executor.query(`
        SELECT id, lane, CAST(limit_keys AS CHAR) AS limit_keys, CAST(limit_maxes AS CHAR) AS limit_maxes,
               CAST(rate_limits AS CHAR) AS rate_limits, attempts, max_attempts, stalls, max_stalls, failure_lane,
               ${epochMs('created_at')} AS created_at_ms, ${epochMs('run_at')} AS run_at_ms,
               TIMESTAMPDIFF(MICROSECOND, run_at, ${NOW}) DIV 1000 AS waited_ms, ${epochMs(NOW)} AS nowms
          FROM ${p}jobs
         WHERE id IN (${placeholders(ids.length)}) AND status = 'pending' AND run_at <= ${NOW}
         ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
    `, ids);
    // The database time of the claim's latest read before it writes the jobs: their start, and the time of their slots
    let nowMs = lockedRows.length ? Number(lockedRows[0].nowms) : null;
    const locked = lockedRows.map(row => ({
        runAtMs: Number(row.run_at_ms),
        /** @type {ClaimedJob} */
        job: {
            id: String(row.id),
            name: String(row.lane),
            limits: limitsOf(row),
            rateLimits: (row.rate_limits ?? null) === null ? [] : JSON.parse(String(row.rate_limits)),
            attempts: Number(row.attempts),
            maxAttempts: Number(row.max_attempts),
            stalls: Number(row.stalls),
            maxStalls: Number(row.max_stalls),
            failureJob: row.failure_lane === null ? null : String(row.failure_lane),
            enqueuedAt: new Date(Number(row.created_at_ms)),
            runAt: new Date(Number(row.run_at_ms)),
            // Set by the write of the claim
            startedAt: new Date(Number.NaN),
            waitedMs: Number(row.waited_ms),
            lockToken,
        },
    }));
    const keys = [...new Set(locked.flatMap(({ job }) => job.limits.map(limit => limit.key)))];
    /** @type {Map<string, Set<number>>} */
    const heldSlots = new Map();

    if (keys.length) {
        const slotRows = await executor.query(`
            SELECT s.limit_key, s.slot, ${epochMs(NOW)} AS nowms FROM ${p}concurrency_slots s
             WHERE s.limit_key IN (${placeholders(keys.length)}) AND ${HELD}
        `, keys);

        nowMs = slotRows.length ? Number(slotRows[0].nowms) : nowMs;

        for (const row of slotRows) {
            const key = String(row.limit_key);

            heldSlots.set(key, (heldSlots.get(key) ?? new Set()).add(Number(row.slot)));
        }
    }

    const held = new Map([...heldSlots].map(([key, slots]) => [key, slots.size]));
    /** @type {{ id: string, name: string, key: string }[]} */
    const blocked = [];
    /** @type {{ job: ClaimedJob, runAtMs: number }[]} */
    const withRoom = [];

    for (const row of locked) {
        // A full concurrency key first: its release unblocks the job, without a timer
        const fullLimit = row.job.limits.find(({ key, max }) => (held.get(key) ?? 0) >= max);

        if (fullLimit) {
            blocked.push({ id: row.job.id, name: row.job.name, key: fullLimit.key });
        } else {
            withRoom.push(row);
        }
    }

    const rateKeys = [...new Set(withRoom.flatMap(({ job }) => job.rateLimits.map(limit => limit.key)))].toSorted();
    const rateRead = rateKeys.length ? await lockRateKeys(executor, p, rateKeys) : { states: new Map(), nowMs: null };
    const rateStates = rateRead.states;

    nowMs = rateRead.nowMs ?? nowMs;
    const { open, blocked: overRate, waits } = splitByRate(withRoom, rateStates);

    blocked.push(...overRate);

    if (blocked.length) {
        await executor.query(`
            UPDATE ${p}jobs FORCE INDEX (PRIMARY)
               SET status = 'blocked', blocked_on = CASE id ${blocked.map(() => 'WHEN ? THEN ?').join(' ')} END,
                   updated_at = ${NOW}
             WHERE id IN (${placeholders(blocked.length)})
        `, [...blocked.flatMap(job => [job.id, job.key]), ...blocked.map(job => job.id)]);
    }

    const picked = pick(open, held, new Map([...rateStates].map(([key, state]) => [key, state.debtUs])));
    const pickedWithLimits = picked.filter(row => row.limits.length);
    const slotsTaken = pickedWithLimits.length
        ? await takeSlots(executor, p, pickedWithLimits, { heldSlots, lockToken })
        : { withAll: new Set(), holds: [], nowMs: /** @type {number | null} */ (null) };
    const claimed = picked.filter(row => !row.limits.length || slotsTaken.withAll.has(row.id));

    nowMs = slotsTaken.nowMs ?? nowMs;
    // Only the jobs that start take their quota
    const increments = [...incrementsOf(claimed)];

    if (increments.length) {
        await executor.query(`
            UPDATE ${p}rate_limits FORCE INDEX (PRIMARY)
               SET tat = GREATEST(tat, ${NOW_US})
                   + INTERVAL (CASE limit_key ${increments.map(() => 'WHEN ? THEN ?').join(' ')} END) MICROSECOND
             WHERE limit_key IN (${placeholders(increments.length)})
        `, [...increments.flat(), ...increments.map(([key]) => key)]);
    }

    if (claimed.length) {
        await startJobs(executor, p, {
            ids: claimed.map(row => row.id),
            holds: slotsTaken.holds,
            nowMs: /** @type {number} */ (nowMs),
            lockToken,
            lockedBy,
            leaseMs,
        });

        for (const job of claimed) {
            job.startedAt = new Date(/** @type {number} */ (nowMs));
        }
    }

    return {
        jobs: claimed,
        blockedKeys: [...new Set(blocked.map(job => job.key))],
        blockedNames: [...new Set(blocked.map(job => job.name))],
        rateWaits: waits,
    };
}

/**
 * The prefix of the claim statement of claimDue. With `innodb_snapshot_isolation` (MariaDB 10.11.8, 11.0.6, 11.1.5,
 * 11.2.4, 11.4.2 and later; ON by default since 11.6.2), a locking read of a row that the statement's read view does
 * not see fails with ER_CHECKREAD (1020): the payload subquery opens that view, so a job whose enqueue commits during
 * the statement fails the whole claim. OFF: the row is locked, its payload is not seen and is read again, as on 10.11
 * and MySQL. A versioned comment: older versions skip it; the ones in between (11.0.0 to 11.4.1) know no such variable
 * (ER_UNKNOWN_SYSTEM_VARIABLE), and the store claims without it from then on.
 */
export const SNAPSHOT_ISOLATION_OFF = '/*M!101108 SET STATEMENT innodb_snapshot_isolation = OFF FOR */ ';

/**
 * Finds, claims and reads the due jobs of names without global limits. Call it in a queue transaction. One statement
 * locks the oldest due jobs of each name that no other claim holds (SKIP LOCKED), with their payloads; the ones that
 * the choice by share takes (`choose`) are claimed. A second read gets the payloads that the statement did not see.
 * @param {Executor} executor
 * @param {string} p
 * @param {import('./store.js').ClaimDueParams} params
 * @param {{ snapshotIsolationOff?: boolean }} [options] `snapshotIsolationOff` (default: true): the claim statement
 *     turns `innodb_snapshot_isolation` off (SNAPSHOT_ISOLATION_OFF). False on a server that does not know it.
 * @returns {Promise<import('./store.js').ClaimDueResult>} The jobs in the order of run_at.
 */
export async function claimDue(executor, p, { requests, free, lockToken, lockedBy, leaseMs, choose },
    { snapshotIsolationOff = true } = {}) {
    if (!requests.length || free <= 0) {
        return { jobs: [], next: [], limited: [] };
    }

    const prefix = snapshotIsolationOff ? SNAPSHOT_ISOLATION_OFF : '';
    const locked = (await executor.query(prefix + requests.map(() => `(
        SELECT j.id, j.lane, ${epochMs('j.run_at')} AS run_at_ms, j.attempts, j.max_attempts, j.stalls,
               j.max_stalls, j.failure_lane, ${epochMs('j.created_at')} AS created_at_ms, j.limit_keys IS NOT NULL OR j.rate_limits IS NOT NULL AS has_limits,
               TIMESTAMPDIFF(MICROSECOND, j.run_at, ${NOW}) DIV 1000 AS waited_ms, ${epochMs(NOW)} AS nowms,
               -- A subquery, not a join: MariaDB has no FOR UPDATE OF, so a join would lock the payload row too
               (SELECT CAST(pl.payload AS CHAR) FROM ${p}payloads pl WHERE pl.id = j.id) AS payload
          FROM ${p}jobs j FORCE INDEX (${p}jobs_status_lane_run_at)
         WHERE j.status = 'pending' AND j.lane = ? AND j.run_at <= ${NOW}
         ORDER BY j.run_at, j.id LIMIT ?
           FOR UPDATE SKIP LOCKED
    )`).join(' UNION ALL '), requests.flatMap(request => [request.name, request.maxJobs])))
        .map(row => ({
            runAtMs: Number(row.run_at_ms),
            hasLimits: Boolean(Number(row.has_limits)),
            /** @type {import('./store.js').StartableJob} */
            job: {
                id: String(row.id),
                name: String(row.lane),
                limits: [],
                rateLimits: [],
                attempts: Number(row.attempts),
                maxAttempts: Number(row.max_attempts),
                stalls: Number(row.stalls),
                maxStalls: Number(row.max_stalls),
                failureJob: row.failure_lane === null ? null : String(row.failure_lane),
                enqueuedAt: new Date(Number(row.created_at_ms)),
                runAt: new Date(Number(row.run_at_ms)),
                // The time of the lock read: nothing waits after it (SKIP LOCKED; then a plain read of payloads)
                startedAt: new Date(Number(row.nowms)),
                waitedMs: Number(row.waited_ms),
                lockToken,
                // payload is NOT NULL: a null is a missing payload row
                payload: row.payload !== null
                    ? { found: true, payload: JSON.parse(String(row.payload)) }
                    : { found: false, payload: undefined },
            },
        }))
        .toSorted((a, b) => a.runAtMs - b.runAtMs || (a.job.id < b.job.id ? -1 : 1));
    // The rows with global limits (from their enqueue options) are left to the claim of names with limits
    const limited = [...new Set(locked.filter(row => row.hasLimits).map(row => row.job.name))];
    // The choice by share, among the locked rows
    const picked = choose(locked.filter(row => !row.hasLimits).map(({ job }) => job));
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
        await startJobs(executor, p, {
            ids: picked.map(job => job.id),
            holds: [],
            nowMs: Number(picked[0].startedAt),
            lockToken,
            lockedBy,
            leaseMs,
        });
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
