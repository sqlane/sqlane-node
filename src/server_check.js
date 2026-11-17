// The check of the server: the database that the adapter's `dialect` names, at a supported version. One statement,
// at the first `start()` or `migrate()` of an instance (create_sqlane.js); a process that only enqueues never runs it.
import { ConfigError } from './errors.js';

/**
 * One SQL text for every database: `version()` of PostgreSQL, `VERSION()` of MySQL and MariaDB. On the wrong database
 * it still runs, so a wrong `dialect` is a `ConfigError`, not a SQL error.
 */
export const SERVER_VERSION_SQL = 'SELECT VERSION() AS version';

/**
 * The oldest supported version of each database: its parts, and its label.
 * @type {Record<import('./types.js').Dialect, { name: string, minimum: number[], label: string }>}
 */
const SUPPORTED = {
    mysql: { name: 'MySQL', minimum: [8, 4, 0], label: '8.4' },
    mariadb: { name: 'MariaDB', minimum: [10, 11, 0], label: '10.11' },
    // server_version_num ≥ 150000
    postgres: { name: 'PostgreSQL', minimum: [15], label: '15' },
};

/**
 * The server, from its version string.
 * @typedef {object} ServerVersion
 * @property {import('./types.js').Dialect | null} dialect Null: neither PostgreSQL, nor MySQL or MariaDB.
 * @property {string} version `8.4.13`, `11.8.9`, `18.6`, `18beta1`; else the string.
 * @property {number[]} parts The numbers of the version: major, minor (and patch on MySQL and MariaDB).
 */

/**
 * @param {string} text The result of `VERSION()`: `8.4.13`, `11.8.9-MariaDB-ubu2404`, `PostgreSQL 18.6 on …`.
 * @returns {ServerVersion}
 */
export function parseServerVersion(text) {
    const postgres = /^PostgreSQL (\d+)(?:\.(\d+))?\S*/u.exec(text);

    if (postgres) {
        return {
            dialect: 'postgres',
            version: postgres[0].slice('PostgreSQL '.length),
            parts: [Number(postgres[1]), Number(postgres[2] ?? 0)],
        };
    }

    // `5.5.5-`: the prefix that old MariaDB servers send to old MySQL clients
    const mysql = /^(?:5\.5\.5-)?(\d+)\.(\d+)\.(\d+)/u.exec(text);

    if (mysql) {
        return {
            dialect: text.includes('MariaDB') ? 'mariadb' : 'mysql',
            version: mysql.slice(1, 4).join('.'),
            parts: mysql.slice(1, 4).map(Number),
        };
    }

    return { dialect: null, version: text, parts: [] };
}

/**
 * @param {readonly number[]} parts
 * @param {readonly number[]} minimum
 * @returns {boolean} The version is below the minimum.
 */
function isBelow(parts, minimum) {
    for (const [index, part] of minimum.entries()) {
        const given = parts[index] ?? 0;

        if (given !== part) {
            return given < part;
        }
    }

    return false;
}

/**
 * @param {ServerVersion} server
 * @returns {string} `MariaDB 11.8.9`, or the version string of an unknown server.
 */
function describe(server) {
    return server.dialect
        ? `${SUPPORTED[server.dialect].name} ${server.version}`
        : JSON.stringify(server.version.slice(0, 80));
}

/**
 * Checks the server of the adapter: the database of its `dialect`, at a supported version. Below the minimum, with
 * `allowUnsupportedVersion`: a warning.
 * @param {import('./types.js').Adapter<any>} adapter
 * @param {string} where The caller, for the errors: `start()`, `migrate()`.
 * @param {import('./types.js').Logger} [logger]
 * @returns {Promise<void>} Rejects with a `ConfigError` on another database, or below the minimum.
 */
export async function checkServer(adapter, where, logger) {
    const [row] = await adapter.queue.query(SERVER_VERSION_SQL, []);
    const server = parseServerVersion(String(row?.version ?? ''));
    const { dialect } = adapter;
    const { name, minimum, label } = SUPPORTED[dialect];

    if (server.dialect !== dialect) {
        const fix = server.dialect ? `: pass dialect: '${server.dialect}' to the adapter` : '';

        throw new ConfigError(`${where}: "dialect" is "${dialect}", but the database is ${describe(server)}${fix}`);
    }

    if (!isBelow(server.parts, minimum)) {
        return;
    }

    const message = `${name} ${server.version} is below the supported minimum ${label}`;

    if (!adapter.allowUnsupportedVersion) {
        throw new ConfigError(`${where}: ${message}: upgrade it, or pass allowUnsupportedVersion: true to the adapter`);
    }

    logger?.warn({ dialect, version: server.version, minimum: label }, `sqlane: ${message}`);
}
