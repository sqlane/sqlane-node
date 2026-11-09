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
export type MariadbConnection = {
    query: (options: object, values: unknown[], callback?: (error: Error | null, result: any) => void) => any;
};
/**
 * A connection of the mariadb driver (MariaDB Connector/Node.js), as far as the executor reads it: of its promise API
 * (Sequelize), or of its callback API, `mariadb/callback` (knex, MikroORM 6).
 * @typedef {object} MariadbConnection
 * @property {(options: object, values: unknown[], callback?: (error: Error | null, result: any) => void) => any} query
 */
/**
 * @param {MariadbConnection} connection
 * @param {'promise' | 'callback'} api The API of the connection.
 * @returns {import('../types.js').Executor}
 */
export declare function mariadbExecutor(connection: MariadbConnection, api: 'promise' | 'callback'): import('../types.js').Executor;
