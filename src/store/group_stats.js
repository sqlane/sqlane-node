// sqlane.lanes.groupStats(): the fair groups of a lane with unfinished jobs, worst first. One statement on the queue's
// pool, with one database time; `limit + 1` rows tell a truncated page.

/** @typedef {import('../types.js').Executor} Executor */

/**
 * @typedef {object} GroupStatsParams
 * @property {string} lane
 * @property {number} limit
 * @property {'oldestDue' | 'pending'} orderBy
 */

/**
 * @param {Executor} executor
 * @param {'mysql' | 'postgres'} family
 * @param {string} p
 * @param {GroupStatsParams} params
 * @returns {Promise<import('../types.js').GroupStatsPage>}
 */
export async function readGroupStats(executor, family, p, { lane, limit, orderBy }) {
    const sql = family === 'postgres' ? postgresSql(p, orderBy) : mysqlSql(p, orderBy);
    const rows = await executor.query(sql, [lane, limit + 1]);

    return {
        groups: rows.slice(0, limit).map(row => ({
            fairGroup: (row.fair_group ?? null) === null ? null : String(row.fair_group),
            pending: Number(row.pending),
            due: Number(row.due),
            blocked: Number(row.blocked),
            running: Number(row.running),
            oldestDueAgeMs: (row.oldest_due_age_ms ?? null) === null ? null : Number(row.oldest_due_age_ms),
        })),
        truncated: rows.length > limit,
    };
}

/**
 * @param {string} p
 * @param {'oldestDue' | 'pending'} orderBy
 * @returns {string} Ties by the group in byte order ("C"), the null group last.
 */
function postgresSql(p, orderBy) {
    const now = 'statement_timestamp()';
    const order = orderBy === 'pending' ? 'pending DESC' : 'oldest_due_age_ms DESC NULLS LAST';

    return `
        SELECT fair_group,
               count(*) FILTER (WHERE status = 'pending') AS pending,
               count(*) FILTER (WHERE status = 'pending' AND run_at <= ${now}) AS due,
               count(*) FILTER (WHERE status = 'blocked') AS blocked,
               count(*) FILTER (WHERE status = 'running') AS running,
               (EXTRACT(EPOCH FROM ${now} - min(run_at) FILTER (WHERE status = 'pending' AND run_at <= ${now}))
                   * 1000)::bigint AS oldest_due_age_ms
          FROM ${p}jobs
         WHERE lane = $1 AND status IN ('pending', 'blocked', 'running')
         GROUP BY fair_group
         ORDER BY ${order}, fair_group COLLATE "C" ASC NULLS LAST
         LIMIT $2
    `;
}

/**
 * @param {string} p
 * @param {'oldestDue' | 'pending'} orderBy
 * @returns {string} MySQL and MariaDB. Ties by the group in byte order (`ascii_bin`), the null group last.
 */
function mysqlSql(p, orderBy) {
    const now = 'UTC_TIMESTAMP(3)';
    const order = orderBy === 'pending'
        ? 'pending DESC'
        : 'oldest_due_age_ms IS NULL, oldest_due_age_ms DESC';

    // A derived table: MariaDB orders by an expression of an alias of an aggregate only outside its query
    return `
        SELECT * FROM (
        SELECT fair_group,
               SUM(status = 'pending') AS pending,
               SUM(status = 'pending' AND run_at <= ${now}) AS due,
               SUM(status = 'blocked') AS blocked,
               SUM(status = 'running') AS running,
               TIMESTAMPDIFF(MICROSECOND, MIN(IF(status = 'pending' AND run_at <= ${now}, run_at, NULL)), ${now})
                   DIV 1000 AS oldest_due_age_ms
          FROM ${p}jobs
         WHERE lane = ? AND status IN ('pending', 'blocked', 'running')
         GROUP BY fair_group
        ) AS g
         ORDER BY ${order}, fair_group IS NULL, fair_group
         LIMIT ?
    `;
}
