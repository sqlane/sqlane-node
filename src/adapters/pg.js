/** @typedef {import('pg').Pool | import('pg').PoolClient | import('pg').Client} PgConnection */

/**
 * @typedef {object} PgAdapterOptions
 * @property {boolean} [notify] Hints by LISTEN/NOTIFY: `pg_notify` in the enqueue transaction, delivered on commit.
 *     Default: false.
 */

/**
 * @param {PgConnection} connection
 * @returns {import('../types.js').Executor}
 */
function toExecutor(connection) {
    return {
        query: async (sql, params) => {
            const result = await connection.query(sql, [...params]);

            return result.rows;
        },
    };
}

/**
 * The adapter for pg. `enqueue` then takes a `Client`, a `PoolClient` (in a transaction) or a `Pool`.
 * @param {import('pg').Pool} pool The queue's own pool: claims, leases, results.
 * @param {PgAdapterOptions} [options]
 * @returns {import('../types.js').Adapter<PgConnection> & { notify: boolean }}
 */
export function pgAdapter(pool, options = {}) {
    return {
        dialect: 'postgres',
        wrap: toExecutor,
        queue: toExecutor(pool),
        notify: options.notify ?? false,
    };
}
