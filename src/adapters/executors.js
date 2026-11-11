// The executors of the drivers: sqlane's SQL on a mysql2 (promise API), mariadb or pg connection, client or pool.
// Shared by the adapters that reach a driver connection under an ORM.
import { createHash } from 'node:crypto';

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

/** The names of the prepared statements, by their SQL */
const statementNames = new Map();
/** Above it, a new SQL text runs unnamed: sqlane's statements are far fewer */
const MAX_STATEMENT_NAMES = 1000;

/**
 * @param {string} sql
 * @returns {string | undefined} The name of its prepared statement, from a hash of the SQL: one per text, on each
 *     connection.
 */
function statementName(sql) {
    let name = statementNames.get(sql);

    if (name === undefined && statementNames.size < MAX_STATEMENT_NAMES) {
        name = `sqlane_${createHash('sha256').update(sql).digest('base64url').slice(0, 22)}`;
        statementNames.set(sql, name);
    }

    return name;
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient | import('pg').Client} connection
 * @param {{ prepare?: boolean }} [options] prepare: named prepared statements, parsed and planned once per connection.
 *     Default: false.
 * @returns {import('../types.js').Executor}
 */
export function pgExecutor(connection, { prepare = false } = {}) {
    /**
     * @param {string} sql
     * @param {readonly unknown[]} params
     * @returns {Promise<import('pg').QueryResult>}
     */
    const send = (sql, params) => {
        const name = prepare ? statementName(sql) : undefined;

        return name === undefined
            ? connection.query(sql, [...params])
            : connection.query({ name, text: sql, values: [...params] });
    };

    return {
        query: async (sql, params) => (await send(sql, params)).rows,
        run: async (sql, params) => (await send(sql, params)).rowCount ?? 0,
    };
}

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
export function mariadbExecutor(connection, api) {
    /**
     * @param {string} sql
     * @param {readonly unknown[]} params
     * @returns {Promise<any>} The rows (an array), or the result of a write.
     */
    function send(sql, params) {
        // BIGINT (counts, retentions) as a number, as mysql2 reads it
        const options = { sql, bigIntAsNumber: true };

        if (api === 'promise') {
            return connection.query(options, [...params]);
        }

        return new Promise((resolve, reject) => {
            connection.query(options, [...params], (error, result) => (error ? reject(error) : resolve(result)));
        });
    }

    return {
        query: async (sql, params) => {
            const result = await send(sql, params);

            return Array.isArray(result) ? /** @type {Record<string, unknown>[]} */ (result) : [];
        },
        run: async (sql, params) => Number((await send(sql, params))?.affectedRows ?? 0),
    };
}
