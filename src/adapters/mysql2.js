import { mysqlFamilyDialect } from './dialect.js';
import { mysql2Executor as toExecutor } from './executors.js';

/**
 * @typedef {import('mysql2/promise').Pool
 *     | import('mysql2/promise').PoolConnection
 *     | import('mysql2/promise').Connection} Mysql2Connection
 */

/**
 * @param {Mysql2Connection} connection
 * @returns {connection is import('mysql2/promise').Pool}
 */
function isPool(connection) {
    return typeof (/** @type {{ getConnection?: unknown }} */ (connection).getConnection) === 'function';
}

/**
 * Runs func in a transaction of its own, on a connection of the pool.
 * @template T
 * @param {import('mysql2/promise').Pool} pool
 * @param {(executor: import('../types.js').Executor) => Promise<T>} func
 * @param {boolean} [readCommitted] Default: false: the isolation level of the session.
 * @returns {Promise<T>}
 */
async function inOwnTransaction(pool, func, readCommitted = false) {
    const connection = await pool.getConnection();

    try {
        if (readCommitted) {
            // For the next transaction only
            await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        }

        await connection.beginTransaction();

        try {
            const result = await func(toExecutor(connection));

            await connection.commit();

            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        }
    } finally {
        connection.release();
    }
}

/**
 * The adapter for mysql2 (its promise API). `enqueue` then takes a `Connection`, a `PoolConnection` (in a
 * transaction) or a `Pool`.
 * @param {import('mysql2/promise').Pool} pool The queue's own pool: claims, leases, results.
 * @param {import('./dialect.js').MysqlFamilyOptions} [options] `{ dialect: 'mariadb' }` on MariaDB.
 * @returns {import('../types.js').Adapter<Mysql2Connection>}
 */
export function mysql2Adapter(pool, options) {
    const dialect = mysqlFamilyDialect(options, 'mysql2Adapter');

    return {
        dialect,
        wrap: toExecutor,
        queue: toExecutor(pool),
        withConnection: async (func) => {
            const connection = await pool.getConnection();

            try {
                return await func(toExecutor(connection));
            } finally {
                connection.release();
            }
        },
        queueTransaction: func => inOwnTransaction(pool, func, true),
        inTransaction: (connection, func) => (isPool(connection)
            ? inOwnTransaction(connection, func)
            : func(toExecutor(connection))),
        // A pool: the enqueue ran in a transaction of its own, committed when it returned
        afterCommit: (connection, onCommit) => {
            if (!isPool(connection)) {
                return false;
            }

            onCommit();

            return true;
        },
    };
}
