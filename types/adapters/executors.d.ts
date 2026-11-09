export type Mysql2Queryable = import('mysql2/promise').Pool | import('mysql2/promise').PoolConnection | import('mysql2/promise').Connection;
/**
 * @typedef {import('mysql2/promise').Pool
 *     | import('mysql2/promise').PoolConnection
 *     | import('mysql2/promise').Connection} Mysql2Queryable
 */
/**
 * @param {Mysql2Queryable} connection
 * @returns {import('../types.js').Executor}
 */
export declare function mysql2Executor(connection: Mysql2Queryable): import('../types.js').Executor;
/**
 * @param {import('pg').Pool | import('pg').PoolClient | import('pg').Client} connection
 * @returns {import('../types.js').Executor}
 */
export declare function pgExecutor(connection: import('pg').Pool | import('pg').PoolClient | import('pg').Client): import('../types.js').Executor;
