import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Client } from 'pg';
import { inject } from 'vitest';

/**
 * @typedef {(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>} Query Runs one statement.
 *   Placeholders: `?` (MySQL), `$1` (PostgreSQL).
 */

/**
 * @typedef {object} TestDatabaseConnection
 * @property {string} name The test database, e.g. `mysql-8.4`.
 * @property {'mysql' | 'postgres'} dialect
 * @property {string} tablePrefix A prefix unique to this connection: the tables of a test file do not collide with the
 *   tables of the files that run in parallel.
 * @property {Query} query
 * @property {() => Promise<void>} close Drops the tables of the prefix, then closes the connection.
 */

/**
 * @typedef {object} DialectConnection
 * @property {Query} query
 * @property {(prefix: string) => Promise<string[]>} listTables The tables whose name starts with the prefix.
 * @property {(tables: string[]) => Promise<void>} dropTables In one statement.
 * @property {() => Promise<void>} end
 */

/**
 * Connects to the database of the current integration project.
 * @returns {Promise<TestDatabaseConnection>}
 */
export async function connectTestDatabase() {
    const dialect = inject('databaseDialect');
    const url = inject('databaseUrl');
    const tablePrefix = `t_${randomBytes(4).toString('hex')}_`;
    const connection = dialect === 'mysql' ? await connectMysql(url) : await connectPostgres(url);

    return {
        name: inject('databaseName'),
        dialect,
        tablePrefix,
        query: connection.query,
        close: () => dropTablesAndClose(connection, tablePrefix),
    };
}

/**
 * @param {string} url
 * @returns {Promise<DialectConnection>}
 */
async function connectMysql(url) {
    const connection = await mysql.createConnection(url);

    /** @type {Query} */
    async function query(sql, params = []) {
        const [rows] = await connection.query(sql, params);

        return Array.isArray(rows) ? /** @type {Record<string, unknown>[]} */ (rows) : [];
    }

    return {
        query,
        listTables: async prefix => (await query(`
            SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = DATABASE() AND LEFT(table_name, CHAR_LENGTH(?)) = ?
        `, [prefix, prefix])).map(({ name }) => String(name)),
        dropTables: async (tables) => {
            await query(`DROP TABLE IF EXISTS ${tables.map(table => `\`${table}\``).join(', ')}`);
        },
        end: () => connection.end(),
    };
}

/**
 * @param {string} url
 * @returns {Promise<DialectConnection>}
 */
async function connectPostgres(url) {
    const client = new Client({ connectionString: url });

    await client.connect();

    /** @type {Query} */
    async function query(sql, params = []) {
        return (await client.query(sql, params)).rows;
    }

    return {
        query,
        listTables: async prefix => (await query(`
            SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = current_schema() AND starts_with(table_name, $1)
        `, [prefix])).map(({ name }) => String(name)),
        dropTables: async (tables) => {
            await query(`DROP TABLE IF EXISTS ${tables.map(table => `"${table}"`).join(', ')} CASCADE`);
        },
        end: () => client.end(),
    };
}

/**
 * @param {DialectConnection} connection
 * @param {string} tablePrefix
 * @returns {Promise<void>}
 */
async function dropTablesAndClose(connection, tablePrefix) {
    try {
        const tables = await connection.listTables(tablePrefix);

        // One statement: a pg client runs one query at a time (pg 9 drops the queue of concurrent queries)
        if (tables.length) {
            await connection.dropTables(tables);
        }
    } finally {
        await connection.end();
    }
}
