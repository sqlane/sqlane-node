import mysql from 'mysql2/promise';
import { Pool } from 'pg';
import { inject } from 'vitest';
import { mysql2Adapter } from '../../../src/adapters/mysql2.js';
import { pgAdapter } from '../../../src/adapters/pg.js';

/**
 * A connection of the test pool, as the app has it: the raw driver object, and its transaction.
 * @typedef {object} TestConnection
 * @property {any} raw The mysql2 `PoolConnection` or the pg `PoolClient`.
 * @property {(sql: string) => Promise<void>} execute
 * @property {() => Promise<void>} begin
 * @property {() => Promise<void>} commit
 * @property {() => Promise<void>} rollback
 * @property {() => void} release
 */

/**
 * @typedef {object} TestAdapter
 * @property {import('../../../src/types.js').Adapter<any>} adapter Over a pool of its own.
 * @property {any} pool The raw pool.
 * @property {() => Promise<TestConnection>} connect
 * @property {() => Promise<void>} close Ends the pool.
 */

/**
 * @param {string} url
 * @returns {TestAdapter}
 */
function createMysqlTestAdapter(url) {
    const pool = mysql.createPool({ uri: url, connectionLimit: 6 });
    const dialect = inject('databaseDialect') === 'mariadb' ? 'mariadb' : 'mysql';

    return {
        adapter: mysql2Adapter(pool, { dialect }),
        pool,
        connect: async () => {
            const raw = await pool.getConnection();

            return {
                raw,
                execute: async (sql) => {
                    await raw.query(sql);
                },
                begin: () => raw.beginTransaction(),
                commit: () => raw.commit(),
                rollback: () => raw.rollback(),
                release: () => raw.release(),
            };
        },
        close: () => pool.end(),
    };
}

/**
 * @param {string} url
 * @returns {TestAdapter}
 */
function createPostgresTestAdapter(url) {
    const pool = new Pool({ connectionString: url, max: 6 });

    return {
        adapter: pgAdapter(pool),
        pool,
        connect: async () => {
            const raw = await pool.connect();
            /** @param {string} sql */
            const execute = async (sql) => {
                await raw.query(sql);
            };

            return {
                raw,
                execute,
                begin: () => execute('BEGIN'),
                commit: () => execute('COMMIT'),
                rollback: () => execute('ROLLBACK'),
                release: () => raw.release(),
            };
        },
        close: () => pool.end(),
    };
}

/**
 * An adapter of the dialect of the current integration project.
 * @returns {TestAdapter}
 */
export function createTestAdapter() {
    const url = inject('databaseUrl');

    return inject('databaseDialect') === 'postgres' ? createPostgresTestAdapter(url) : createMysqlTestAdapter(url);
}

/**
 * The options of an adapter over mysql2 (knex, Drizzle, Sequelize) on the database of the current project.
 * @returns {{ dialect: 'mariadb' } | undefined} `{ dialect: 'mariadb' }` on MariaDB; the default elsewhere.
 */
export function mysqlFamilyOptions() {
    return inject('databaseDialect') === 'mariadb' ? { dialect: 'mariadb' } : undefined;
}
