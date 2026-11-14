// The statement statistics of a database server, per database: pg_stat_statements on PostgreSQL, performance_schema
// on MySQL and MariaDB. Each measured run gets a database of its own; the admin connection works from another one, so
// its own statements never count. The servers need the statistics on: `shared_preload_libraries=pg_stat_statements`
// on PostgreSQL, `--performance-schema=ON` on MariaDB (MySQL has it on by default).
import { createConnection } from 'mysql2/promise';
import { Client } from 'pg';

/**
 * @typedef {object} StatementStats
 * @property {number} statements The statements that the server ran, BEGIN and COMMIT included.
 * @property {number} rows PostgreSQL: the rows that the statements returned or changed. MySQL and MariaDB: the rows
 *     that they examined.
 * @property {number} blocks PostgreSQL: the shared buffer blocks that they hit or read. MySQL and MariaDB: 0.
 * @property {{ text: string, statements: number, rows: number, blocks: number }[]} byStatement The same, per
 *     normalized statement, the most frequent first: to find what changed.
 */

/**
 * @typedef {object} StatsServer
 * @property {(name: string) => Promise<string>} createDatabase Creates an empty database; resolves to its URL.
 * @property {(name: string) => Promise<void>} reset Clears the statistics of the database.
 * @property {(name: string) => Promise<StatementStats>} read The statistics of the database since its reset.
 * @property {() => Promise<void>} close
 */

/**
 * @param {{ dialect: 'postgres' | 'mysql' | 'mariadb', adminUrl: string }} options adminUrl: a superuser
 *     (PostgreSQL) or root (MySQL, MariaDB) connection to the server.
 * @returns {Promise<StatsServer>}
 */
export async function statsServer({ dialect, adminUrl }) {
    return dialect === 'postgres' ? postgresStats(adminUrl) : mysqlStats(adminUrl);
}

/**
 * @param {string} name
 * @returns {string} The name, checked: lower-case letters, digits and underscores only, as it goes into DDL.
 */
function checked(name) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        throw new Error(`database name ${name}: lower-case letters, digits and underscores only`);
    }

    return name;
}

/**
 * @param {string} adminUrl
 * @returns {Promise<StatsServer>}
 */
async function postgresStats(adminUrl) {
    const admin = new Client({ connectionString: adminUrl });

    await admin.connect();
    // The view lives in the database of the admin connection; the statistics cover the whole server
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');

    /**
     * @param {string} name
     * @returns {Promise<number>}
     */
    const oid = async (name) => {
        const { rows } = await admin.query('SELECT oid FROM pg_database WHERE datname = $1', [checked(name)]);

        return Number(rows[0].oid);
    };

    return {
        async createDatabase(name) {
            await admin.query(`DROP DATABASE IF EXISTS ${checked(name)} WITH (FORCE)`);
            await admin.query(`CREATE DATABASE ${name}`);

            const url = new URL(adminUrl);

            url.pathname = `/${name}`;

            return url.toString();
        },
        async reset(name) {
            await admin.query('SELECT pg_stat_statements_reset(0, $1, 0)', [await oid(name)]);
        },
        async read(name) {
            const { rows } = await admin.query(`
                SELECT query AS text, sum(calls)::bigint AS statements, sum(rows)::bigint AS rows,
                       sum(shared_blks_hit + shared_blks_read)::bigint AS blocks
                FROM pg_stat_statements
                WHERE dbid = $1
                GROUP BY query
                ORDER BY statements DESC, text`, [await oid(name)]);

            return summarize(rows);
        },
        async close() {
            await admin.end();
        },
    };
}

/**
 * @param {string} adminUrl
 * @returns {Promise<StatsServer>}
 */
async function mysqlStats(adminUrl) {
    const url = new URL(adminUrl);

    // No default database: the admin statements count under none of the measured ones
    url.pathname = '/';

    const admin = await createConnection({ uri: url.toString() });

    return {
        async createDatabase(name) {
            await admin.query(`DROP DATABASE IF EXISTS ${checked(name)}`);
            await admin.query(`CREATE DATABASE ${name}`);

            const target = new URL(adminUrl);

            target.pathname = `/${name}`;

            return target.toString();
        },
        async reset() {
            // The digest table holds the whole server: the runs go one after the other
            await admin.query('TRUNCATE TABLE performance_schema.events_statements_summary_by_digest');
        },
        async read(name) {
            const [rows] = await admin.query(`
                SELECT DIGEST_TEXT AS text, SUM(COUNT_STAR) AS statements, SUM(SUM_ROWS_EXAMINED) AS \`rows\`,
                       0 AS blocks
                FROM performance_schema.events_statements_summary_by_digest
                WHERE SCHEMA_NAME = ?
                GROUP BY DIGEST_TEXT
                ORDER BY statements DESC, text`, [checked(name)]);

            return summarize(/** @type {any[]} */ (rows));
        },
        async close() {
            await admin.end();
        },
    };
}

/**
 * @param {{ text: string | null, statements: unknown, rows: unknown, blocks: unknown }[]} rows
 * @returns {StatementStats}
 */
function summarize(rows) {
    const byStatement = rows.map(row => ({
        text: String(row.text ?? '?').replaceAll(/\s+/g, ' ').trim(),
        statements: Number(row.statements),
        rows: Number(row.rows),
        blocks: Number(row.blocks),
    }));

    const total = { statements: 0, rows: 0, blocks: 0 };

    for (const row of byStatement) {
        total.statements += row.statements;
        total.rows += row.rows;
        total.blocks += row.blocks;
    }

    return { ...total, byStatement };
}
