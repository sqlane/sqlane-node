// The executors of the drivers: sqlane's SQL on a mysql2 (promise API) or pg connection, client or pool. Shared by the
// adapters that reach a driver connection under an ORM.

/**
 * @typedef {import('mysql2/promise').Pool
 *     | import('mysql2/promise').PoolConnection
 *     | import('mysql2/promise').Connection} Mysql2Queryable
 */

/**
 * @param {Mysql2Queryable} connection
 * @returns {import('../types.js').Executor}
 */
export function mysql2Executor(connection) {
    return {
        query: async (sql, params) => {
            // The three types have the same query(); TS cannot call a method of a union of overloads.
            const queryable = /** @type {import('mysql2/promise').Connection} */ (connection);
            const [rows] = await queryable.query(sql, [...params]);

            return Array.isArray(rows) ? /** @type {Record<string, unknown>[]} */ (rows) : [];
        },
        run: async (sql, params) => {
            const queryable = /** @type {import('mysql2/promise').Connection} */ (connection);
            const [result] = await queryable.query(sql, [...params]);

            return /** @type {import('mysql2/promise').ResultSetHeader} */ (result).affectedRows;
        },
    };
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient | import('pg').Client} connection
 * @returns {import('../types.js').Executor}
 */
export function pgExecutor(connection) {
    return {
        query: async (sql, params) => {
            const result = await connection.query(sql, [...params]);

            return result.rows;
        },
        run: async (sql, params) => {
            const result = await connection.query(sql, [...params]);

            return result.rowCount ?? 0;
        },
    };
}
