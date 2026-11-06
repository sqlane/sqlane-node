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
 * @param {PgConnection} connection
 * @returns {connection is import('pg').Pool}
 */
function isPool(connection) {
    return typeof (/** @type {{ totalCount?: unknown }} */ (connection).totalCount) === 'number';
}

/**
 * Runs func in a transaction of its own, on a client of the pool.
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(executor: import('../types.js').Executor) => Promise<T>} func
 * @returns {Promise<T>}
 */
async function inOwnTransaction(pool, func) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        try {
            const result = await func(toExecutor(client));

            await client.query('COMMIT');

            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    } finally {
        client.release();
    }
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
        withConnection: async (func) => {
            const client = await pool.connect();

            try {
                return await func(toExecutor(client));
            } finally {
                client.release();
            }
        },
        inTransaction: (connection, func) => (isPool(connection)
            ? inOwnTransaction(connection, func)
            : func(toExecutor(connection))),
        notify: options.notify ?? false,
    };
}
