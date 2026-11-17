/**
 * One SQL text for every database: `version()` of PostgreSQL, `VERSION()` of MySQL and MariaDB. On the wrong database
 * it still runs, so a wrong `dialect` is a `ConfigError`, not a SQL error.
 */
export declare const SERVER_VERSION_SQL = "SELECT VERSION() AS version";
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
/**
 * Checks the server of the adapter: the database of its `dialect`, at a supported version. Below the minimum, with
 * `allowUnsupportedVersion`: a warning.
 * @param {import('./types.js').Adapter<any>} adapter
 * @param {string} where The caller, for the errors: `start()`, `migrate()`.
 * @param {import('./types.js').Logger} [logger]
 * @returns {Promise<void>} Rejects with a `ConfigError` on another database, or below the minimum.
 */
export declare function checkServer(adapter: import('./types.js').Adapter<any>, where: string, logger?: import('./types.js').Logger): Promise<void>;
