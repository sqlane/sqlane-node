// A pool of the benchmarked database, with the raw driver objects that an app has.
import mysql from 'mysql2/promise';
import { Pool } from 'pg';
import { mysql2Adapter } from '../src/adapters/mysql2.js';
import { pgAdapter } from '../src/adapters/pg.js';

/** @typedef {import('../src/types.js').Adapter<any>} Adapter */

/**
 * @typedef {object} BenchPool
 * @property {import('../src/types.js').Dialect} dialect
 * @property {any} raw The mysql2 or pg pool.
 * @property {(options?: { notify?: boolean }) => Adapter} adapter `notify`: pg only.
 * @property {(func: (connection: any) => Promise<void>) => Promise<void>} transaction Runs func in a transaction on
 *     a raw connection of the pool, as an app does.
 * @property {(sql: string) => Promise<void>} execute
 * @property {() => Promise<void>} end
 */

/**
 * @param {import('../src/types.js').Dialect} dialect
 * @param {string} url
 * @param {number} size The connections of the pool.
 * @returns {BenchPool}
 */
export function createBenchPool(dialect, url, size) {
    return dialect === 'postgres' ? createPostgresPool(url, size) : createMysqlPool(dialect, url, size);
}

/**
 * MySQL or MariaDB, through mysql2.
 * @param {'mysql' | 'mariadb'} dialect
 * @param {string} url
 * @param {number} size
 * @returns {BenchPool}
 */
function createMysqlPool(dialect, url, size) {
    const pool = mysql.createPool({ uri: url, connectionLimit: size });

    return {
        dialect,
        raw: pool,
        adapter: () => mysql2Adapter(pool, { dialect }),
        transaction: async (func) => {
            const connection = await pool.getConnection();

            try {
                await connection.beginTransaction();
                await func(connection);
                await connection.commit();
            } finally {
                connection.release();
            }
        },
        execute: async (sql) => {
            await pool.query(sql);
        },
        end: () => pool.end(),
    };
}

/**
 * @param {string} url
 * @param {number} size
 * @returns {BenchPool}
 */
function createPostgresPool(url, size) {
    const pool = new Pool({ connectionString: url, max: size });

    return {
        dialect: 'postgres',
        raw: pool,
        adapter: ({ notify = false } = {}) => pgAdapter(pool, { notify }),
        transaction: async (func) => {
            const client = await pool.connect();

            try {
                await client.query('BEGIN');
                await func(client);
                await client.query('COMMIT');
            } finally {
                client.release();
            }
        },
        execute: async (sql) => {
            await pool.query(sql);
        },
        end: () => pool.end(),
    };
}
