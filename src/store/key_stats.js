// sqlane.jobs.keyStats(): the keys with blocked jobs, or with held or lingering slots. One statement per family on the
// queue's pool, with one database time; the max of a key and the next start of a rate key are computed in JS, from the
// stored settings of the head job, as the unblock computes them. No index of its own: the loose scans read one entry
// per blocked key, and the slots are a small table.
import { waitMsOf, waitUs } from '../gcra.js';
import { parseRateKey } from '../rate_limit_shape.js';

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('../types.js').KeyStats} KeyStats */

/** The blocked jobs that a key counts: one more is read, and means more */
export const BLOCKED_CAP = 1000;

/**
 * @typedef {object} KeyStatsParams
 * @property {number} limit
 * @property {'concurrency' | 'rate' | null} type Null: every type.
 * @property {'blocked' | 'held'} orderBy
 */

/**
 * The SQL of one family: the times, the casts of JSON, and the forms that differ.
 * @typedef {object} Dialect
 * @property {string} now The database time of the statement, constant in it.
 * @property {(column: string) => string} ageMs Of a time column at `now`, in integer ms (null for null).
 * @property {(column: string) => string} jsonText A JSON or array column, as JSON text.
 * @property {boolean} recursive `heads` is a recursive CTE.
 * @property {string} heads The CTE `heads`: one row per blocked key, `k` and `head_run_at`.
 * @property {string} headOrder The ORDER BY of the blocked jobs `b` of a key, by its index.
 * @property {string} blockedIndex The index hint of the blocked jobs, or nothing.
 * @property {string} keys The CTE `ks`: `k`, `head_run_at`, `held`, `lingering`, `oldest_slot`.
 * @property {(sortT: string) => string} nullsLast `sortT` ascending, nulls last, then the key in byte order.
 * @property {string} firstChar The first character of `k`.
 * @property {string} debtUs The debt of the rate key `r.k`, in µs, at `now`: null without a row.
 * @property {string} limitParam The placeholder of the limit.
 */

/**
 * @param {string} p
 * @returns {Dialect}
 */
function postgresDialect(p) {
    const now = 'statement_timestamp()';

    return {
        now,
        ageMs: column => `(EXTRACT(EPOCH FROM ${now} - ${column}) * 1000)::bigint`,
        jsonText: column => (column === 'rate_limits' || column.endsWith('.rate_limits')
            ? `${column}::text`
            : `array_to_json(${column})::text`),
        recursive: true,
        // A loose scan of the partial index (blocked_on, run_at, id) WHERE status = 'blocked': one entry per key
        heads: `blocked_keys AS (
            (SELECT blocked_on FROM ${p}jobs WHERE status = 'blocked' ORDER BY blocked_on LIMIT 1)
            UNION ALL
            SELECT (
                SELECT j.blocked_on FROM ${p}jobs j
                 WHERE j.status = 'blocked' AND j.blocked_on > b.blocked_on ORDER BY j.blocked_on LIMIT 1
            ) FROM blocked_keys b WHERE b.blocked_on IS NOT NULL
        ),
        heads AS (
            SELECT b.blocked_on AS k, (
                SELECT j.run_at FROM ${p}jobs j
                 WHERE j.status = 'blocked' AND j.blocked_on = b.blocked_on ORDER BY j.run_at, j.id LIMIT 1
            ) AS head_run_at
              FROM blocked_keys b WHERE b.blocked_on IS NOT NULL
        )`,
        headOrder: 'b.blocked_on, b.run_at, b.id',
        blockedIndex: '',
        keys: `ks AS (
            SELECT COALESCE(h.k, s.k) AS k, h.head_run_at, COALESCE(s.held, 0) AS held,
                   COALESCE(s.lingering, 0) AS lingering, s.oldest_slot
              FROM heads h FULL JOIN slot_keys s ON s.k = h.k
        )`,
        nullsLast: sortT => `${sortT} ASC NULLS LAST, k COLLATE "C"`,
        firstChar: 'left(r.k, 1)',
        debtUs: `(SELECT GREATEST((EXTRACT(EPOCH FROM rl.tat - ${now}) * 1000000)::bigint, 0)
                    FROM ${p}rate_limits rl WHERE rl.limit_key = r.k)`,
        limitParam: '$1',
    };
}

/**
 * @param {string} p
 * @returns {Dialect}
 */
function mysqlDialect(p) {
    // In µs: the ages and the debt of the rate keys come from one time, constant in the statement
    const now = 'UTC_TIMESTAMP(6)';

    return {
        now,
        ageMs: column => `TIMESTAMPDIFF(MICROSECOND, ${column}, ${now}) DIV 1000`,
        jsonText: column => `CAST(${column} AS CHAR)`,
        recursive: false,
        // A loose index scan of (status, blocked_on, run_at, id): the whole prefix in GROUP BY, MIN of the next column
        heads: `heads AS (
            SELECT blocked_on AS k, MIN(run_at) AS head_run_at FROM ${p}jobs FORCE INDEX (${p}jobs_blocked)
             WHERE status = 'blocked' GROUP BY status, blocked_on
        )`,
        // The full index prefix: MySQL 8.4 sorts the rows of a correlated subquery without it
        headOrder: 'b.status, b.blocked_on, b.run_at, b.id',
        blockedIndex: ` FORCE INDEX (${p}jobs_blocked)`,
        // No FULL JOIN: the keys of both, grouped
        keys: `ks AS (
            SELECT k, MAX(head_run_at) AS head_run_at, COALESCE(MAX(held), 0) AS held,
                   COALESCE(MAX(lingering), 0) AS lingering, MIN(oldest_slot) AS oldest_slot
              FROM (
                  SELECT k, head_run_at, CAST(NULL AS SIGNED) AS held, CAST(NULL AS SIGNED) AS lingering,
                         CAST(NULL AS DATETIME(3)) AS oldest_slot
                    FROM heads
                  UNION ALL
                  SELECT k, CAST(NULL AS DATETIME(3)), held, lingering, oldest_slot FROM slot_keys
              ) AS u
             GROUP BY k
        )`,
        nullsLast: sortT => `(${sortT} IS NULL), ${sortT}, k`,
        firstChar: 'LEFT(r.k, 1)',
        debtUs: `(SELECT GREATEST(TIMESTAMPDIFF(MICROSECOND, ${now}, rl.tat), 0)
                    FROM ${p}rate_limits rl WHERE rl.limit_key = r.k)`,
        limitParam: '?',
    };
}

/**
 * @param {Dialect} d
 * @param {string} p
 * @param {KeyStatsParams} params
 * @returns {string} The statement: one row per key of the page, with its details, in the order of the page.
 */
function keyStatsSql(d, p, { type, orderBy }) {
    const held = `(s.held_until IS NULL OR s.held_until >= ${d.now})`;
    const rate = `LEFT(k, 1) = '@'`;
    const filter = type === null ? '' : `WHERE ${type === 'rate' ? rate : `NOT ${rate}`}`;
    // `held`: the concurrency keys with slots, by their oldest slot; then the other concurrency keys; then the rate
    // keys, by their oldest blocked job. `blocked`: by the oldest blocked job. The type of a key is its first
    // character (`@`: rate, else concurrency); a later type of key must be mapped here explicitly, to the last tier
    const tier = orderBy === 'held' ? `CASE WHEN ${rate} THEN 2 WHEN held + lingering > 0 THEN 0 ELSE 1 END` : '0';
    const sortT = orderBy === 'held'
        ? `CASE WHEN ${rate} OR held + lingering = 0 THEN head_run_at ELSE oldest_slot END`
        : 'head_run_at';
    /**
     * @param {string} column
     * @returns {string} Of the oldest job blocked on the key `r.k`.
     */
    const ofHead = column => `(
        SELECT ${column} FROM ${p}jobs b${d.blockedIndex}
         WHERE b.status = 'blocked' AND b.blocked_on = r.k ORDER BY ${d.headOrder} LIMIT 1
    )`;
    const holder = `(
        SELECT s.job_id FROM ${p}concurrency_slots s WHERE s.limit_key = r.k AND ${held}
         ORDER BY s.created_at DESC, s.job_id DESC LIMIT 1
    )`;
    /**
     * @param {string} column
     * @returns {string} Of the job of the newest slot of the key, when no job is blocked on it.
     */
    const ofHolder = column => `CASE WHEN r.head_run_at IS NULL THEN (
        SELECT ${d.jsonText(`j.${column}`)} FROM ${p}jobs j WHERE j.id = ${holder}
    ) END`;

    return `
        WITH${d.recursive ? ' RECURSIVE' : ''} ${d.heads},
        slot_keys AS (
            SELECT s.limit_key AS k,
                   COUNT(CASE WHEN s.held_until IS NULL THEN 1 END) AS held,
                   COUNT(CASE WHEN s.held_until >= ${d.now} THEN 1 END) AS lingering,
                   MIN(CASE WHEN ${held} THEN s.created_at END) AS oldest_slot
              FROM ${p}concurrency_slots s
             GROUP BY s.limit_key
            HAVING COUNT(CASE WHEN s.held_until IS NULL THEN 1 END) + COUNT(CASE WHEN s.held_until >= ${d.now} THEN 1 END) > 0
        ),
        ${d.keys},
        sorted AS (
            SELECT k, head_run_at, held, lingering, oldest_slot, ${tier} AS tier, ${sortT} AS sort_t FROM ks ${filter}
        ),
        ranked AS (
            SELECT k, head_run_at, held, lingering, oldest_slot,
                   ROW_NUMBER() OVER (ORDER BY tier, ${d.nullsLast('sort_t')}) AS n, COUNT(*) OVER () AS total
              FROM sorted
        )
        SELECT r.k, r.n, r.total, r.held, r.lingering,
               ${d.ageMs('r.head_run_at')} AS blockedage, ${d.ageMs('r.oldest_slot')} AS heldage,
               CASE WHEN r.head_run_at IS NULL THEN 0
                    WHEN (
                        SELECT 1 FROM ${p}jobs b${d.blockedIndex}
                         WHERE b.status = 'blocked' AND b.blocked_on = r.k
                         ORDER BY ${d.headOrder} LIMIT 1 OFFSET ${BLOCKED_CAP}
                    ) IS NOT NULL THEN ${BLOCKED_CAP + 1}
                    ELSE (SELECT COUNT(*) FROM ${p}jobs b${d.blockedIndex} WHERE b.status = 'blocked' AND b.blocked_on = r.k)
               END AS blocked,
               ${ofHead(d.jsonText('b.limit_keys'))} AS headkeys,
               ${ofHead(d.jsonText('b.limit_maxes'))} AS headmaxes,
               ${ofHead(d.jsonText('b.rate_limits'))} AS headrates,
               ${ofHolder('limit_keys')} AS holderkeys,
               ${ofHolder('limit_maxes')} AS holdermaxes,
               CASE WHEN ${d.firstChar} = '@' THEN ${d.debtUs} END AS debtus
          FROM ranked r
         WHERE r.n <= ${d.limitParam}
         ORDER BY r.n
    `;
}

/**
 * @param {unknown} value A count or a time of a driver: number, string or BigInt; null.
 * @returns {number | null}
 */
function numberOrNull(value) {
    return value === null || value === undefined ? null : Number(value);
}

/**
 * @param {unknown} age
 * @returns {number | null} At least 0: a row committed after the time of the statement would be younger than it.
 */
function ageOf(age) {
    const ms = numberOrNull(age);

    return ms === null ? null : Math.max(ms, 0);
}

/**
 * @param {unknown} json
 * @returns {any[]}
 */
function parsed(json) {
    return json === null || json === undefined ? [] : JSON.parse(String(json));
}

/**
 * @param {unknown} keysJson The `limit_keys` of a job, as JSON text.
 * @param {unknown} maxesJson Its `limit_maxes`.
 * @param {string} key
 * @returns {number | null} The max of the key in the job; null when the job does not carry it.
 */
function maxIn(keysJson, maxesJson, key) {
    // At most 10 keys a job: a linear search, as text (no JSON_SEARCH, whose % and _ are wildcards)
    const at = parsed(keysJson).indexOf(key);

    return at === -1 ? null : Number(parsed(maxesJson)[at]);
}

/**
 * A row of the statement as `KeyStats`.
 * @param {Record<string, unknown>} row
 * @returns {KeyStats}
 */
export function toKeyStats(row) {
    const key = String(row.k);
    const read = Number(row.blocked);
    const blocked = Math.min(read, BLOCKED_CAP);
    const blockedTruncated = read > BLOCKED_CAP;

    if (key.startsWith('@')) {
        const entry = parsed(row.headrates).find(limit => limit.key === key);
        // No row of the key: no debt
        const debtUs = Number(row.debtus ?? 0);

        return {
            type: 'rate',
            ...parseRateKey(key),
            blocked,
            blockedTruncated,
            oldestBlockedAgeMs: /** @type {number} */ (ageOf(row.blockedage)),
            nextStartInMs: entry ? waitMsOf(waitUs(debtUs, entry)) : 0,
        };
    }

    const max = row.headkeys === null || row.headkeys === undefined
        ? maxIn(row.holderkeys, row.holdermaxes, key)
        : maxIn(row.headkeys, row.headmaxes, key);

    return {
        type: 'concurrency',
        key,
        max,
        held: Number(row.held),
        lingering: Number(row.lingering),
        blocked,
        blockedTruncated,
        oldestBlockedAgeMs: ageOf(row.blockedage),
        oldestHeldAgeMs: ageOf(row.heldage),
    };
}

/**
 * The keys of a page, worst first.
 * @param {Executor} executor The queue's pool.
 * @param {'mysql' | 'postgres'} family
 * @param {string} p
 * @param {KeyStatsParams} params
 * @returns {Promise<import('../types.js').KeyStatsPage>}
 */
export async function keyStats(executor, family, p, params) {
    const dialect = family === 'postgres' ? postgresDialect(p) : mysqlDialect(p);
    const rows = await executor.query(keyStatsSql(dialect, p, params), [params.limit]);

    return {
        keys: rows.map(toKeyStats),
        truncated: rows.length > 0 && Number(rows[0].total) > params.limit,
    };
}
