// The check of the server: the database that the adapter's `dialect` names, at a supported version, and on MySQL and
// MariaDB a `sql_mode` that sqlane supports. One statement on PostgreSQL, two on MySQL and MariaDB, at the first
// `start()` or `migrate()` of an instance (create_sqlane.js); a process that only enqueues never runs it.
import { ConfigError } from './errors.js';

/**
 * One SQL text for every database: `version()` of PostgreSQL, `VERSION()` of MySQL and MariaDB. On the wrong database
 * it still runs, so a wrong `dialect` is a `ConfigError`, not a SQL error.
 */
export const SERVER_VERSION_SQL = 'SELECT VERSION() AS version';

/** MySQL and MariaDB: the `sql_mode` of the session, after `SERVER_VERSION_SQL` */
export const SQL_MODE_SQL = 'SELECT @@SESSION.sql_mode AS sql_mode';

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
 * The flags of `sql_mode` that sqlane needs, besides strict mode (`STRICT_TRANS_TABLES` or `STRICT_ALL_TABLES`): the
 * correctness flags of each database's default mode. Without them, the database stores a bad value with a warning,
 * instead of an error: a truncated string, a zero date, NULL for a division by zero.
 * @type {Record<'mysql' | 'mariadb', string[]>}
 */
const REQUIRED_SQL_MODE = {
    mysql: ['NO_ZERO_DATE', 'NO_ZERO_IN_DATE', 'ERROR_FOR_DIVISION_BY_ZERO'],
    mariadb: ['ERROR_FOR_DIVISION_BY_ZERO'],
};

/**
 * The flags of `sql_mode` that sqlane refuses: invalid dates; `NO_BACKSLASH_ESCAPES` breaks the escaping of the
 * drivers, which no option allows.
 */
const FORBIDDEN_SQL_MODE = ['ALLOW_INVALID_DATES', 'NO_BACKSLASH_ESCAPES'];

/**
 * A warning to log once the check passes.
 * @typedef {object} Warning
 * @property {Record<string, unknown>} data
 * @property {string} message
 */

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
 * The `sql_mode` of MySQL and MariaDB, against the flags that sqlane needs.
 * @typedef {object} SqlModeCheck
 * @property {string[]} missing The required flags that the mode lacks. Strict mode: `STRICT_TRANS_TABLES or
 *     STRICT_ALL_TABLES`.
 * @property {string[]} forbidden The forbidden flags that the mode has.
 */

/**
 * @param {'mysql' | 'mariadb'} dialect
 * @param {string} sqlMode The result of `@@SESSION.sql_mode`: `STRICT_TRANS_TABLES,NO_ZERO_DATE,…`.
 * @returns {SqlModeCheck}
 */
export function checkSqlMode(dialect, sqlMode) {
    const flags = new Set(sqlMode.toUpperCase().split(',').map(flag => flag.trim()));
    const missing = [];

    if (!flags.has('STRICT_TRANS_TABLES') && !flags.has('STRICT_ALL_TABLES')) {
        missing.push('STRICT_TRANS_TABLES or STRICT_ALL_TABLES');
    }

    missing.push(...REQUIRED_SQL_MODE[dialect].filter(flag => !flags.has(flag)));

    return { missing, forbidden: FORBIDDEN_SQL_MODE.filter(flag => flags.has(flag)) };
}

/**
 * @param {readonly string[]} values
 * @returns {string} `A, B and C`.
 */
function listOf(values) {
    return values.length > 1 ? `${values.slice(0, -1).join(', ')} and ${values.at(-1)}` : values.join('');
}

/**
 * Checks the `sql_mode` of the session, on MySQL and MariaDB. Lacking a flag, or with `ALLOW_INVALID_DATES`, with
 * `allowUnsupportedDbConfiguration`: the warning to log.
 * @param {import('./types.js').Adapter<any>} adapter Its dialect: `'mysql'` or `'mariadb'`, checked.
 * @param {string} where The caller, for the errors.
 * @returns {Promise<Warning | null>} Rejects with a `ConfigError` on a mode that sqlane does not support.
 */
async function checkServerSqlMode(adapter, where) {
    const dialect = /** @type {'mysql' | 'mariadb'} */ (adapter.dialect);
    const [row] = await adapter.queue.query(SQL_MODE_SQL, []);
    const sqlMode = String(row?.sql_mode ?? '');
    const { missing, forbidden } = checkSqlMode(dialect, sqlMode);

    if (missing.length === 0 && forbidden.length === 0) {
        return null;
    }

    const problems = [
        ...missing.length > 0 ? [`lacks ${listOf(missing)}`] : [],
        ...forbidden.length > 0 ? [`has ${listOf(forbidden)}`] : [],
    ].join(' and ');
    const message = `the sql_mode of ${SUPPORTED[dialect].name} ${problems}`;
    const rds = missing.length > 0 ? ' (the default group of RDS MySQL lacks them)' : '';
    const fix = `set sql_mode in the server config, or on RDS and Aurora in the DB parameter group${rds}`;

    if (forbidden.includes('NO_BACKSLASH_ESCAPES')) {
        throw new ConfigError(`${where}: ${message}: ${fix}. NO_BACKSLASH_ESCAPES breaks the escaping of the driver: a `
            + 'quote in a value is a SQL error, and a crafted value can inject SQL. allowUnsupportedDbConfiguration does '
            + 'not allow it');
    }

    if (!adapter.allowUnsupportedDbConfiguration) {
        throw new ConfigError(`${where}: ${message}: ${fix}; or pass allowUnsupportedDbConfiguration: true to the `
            + 'adapter');
    }

    return { data: { dialect, sqlMode, missing, forbidden }, message: `sqlane: ${message}` };
}

/**
 * Checks the server of the adapter: the database of its `dialect`, at a supported version; on MySQL and MariaDB, the
 * `sql_mode` of the session. Below the minimum with `allowUnsupportedDbVersion`, an unsupported `sql_mode` with
 * `allowUnsupportedDbConfiguration`: a warning, once the whole check passes.
 * @param {import('./types.js').Adapter<any>} adapter
 * @param {string} where The caller, for the errors: `start()`, `migrate()`.
 * @param {import('./types.js').Logger} [logger]
 * @returns {Promise<void>} Rejects with a `ConfigError` on another database, below the minimum, or on an unsupported
 *     `sql_mode`.
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

    /** @type {Warning[]} */
    const warnings = [];

    if (isBelow(server.parts, minimum)) {
        const message = `${name} ${server.version} is below the supported minimum ${label}`;

        if (!adapter.allowUnsupportedDbVersion) {
            throw new ConfigError(`${where}: ${message}: upgrade it, or pass allowUnsupportedDbVersion: true to the `
                + 'adapter');
        }

        warnings.push({ data: { dialect, version: server.version, minimum: label }, message: `sqlane: ${message}` });
    }

    if (dialect !== 'postgres') {
        const warning = await checkServerSqlMode(adapter, where);

        if (warning) {
            warnings.push(warning);
        }
    }

    for (const { data, message } of warnings) {
        logger?.warn(data, message);
    }
}
