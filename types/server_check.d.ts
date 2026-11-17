/**
 * One SQL text for every database: `version()` of PostgreSQL, `VERSION()` of MySQL and MariaDB. On the wrong database
 * it still runs, so a wrong `dialect` is a `ConfigError`, not a SQL error.
 */
export declare const SERVER_VERSION_SQL = "SELECT VERSION() AS version";
/** MySQL and MariaDB: the `sql_mode` of the session, after `SERVER_VERSION_SQL` */
export declare const SQL_MODE_SQL = "SELECT @@SESSION.sql_mode AS sql_mode";
export type Warning = {
    data: Record<string, unknown>;
    message: string;
};
export type ServerVersion = {
    /**
     * Null: neither PostgreSQL, nor MySQL or MariaDB.
     */
    dialect: import('./types.js').Dialect | null;
    /**
     * `8.4.13`, `11.8.9`, `18.6`, `18beta1`; else the string.
     */
    version: string;
    /**
     * The numbers of the version: major, minor (and patch on MySQL and MariaDB).
     */
    parts: number[];
};
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
export declare function parseServerVersion(text: string): ServerVersion;
export type SqlModeCheck = {
    /**
     * The required flags that the mode lacks. Strict mode: `STRICT_TRANS_TABLES or
     * STRICT_ALL_TABLES`.
     */
    missing: string[];
    /**
     * The forbidden flags that the mode has.
     */
    forbidden: string[];
};
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
export declare function checkSqlMode(dialect: 'mysql' | 'mariadb', sqlMode: string): SqlModeCheck;
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
export declare function checkServer(adapter: import('./types.js').Adapter<any>, where: string, logger?: import('./types.js').Logger): Promise<void>;
