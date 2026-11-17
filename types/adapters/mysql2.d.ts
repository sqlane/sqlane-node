export type Mysql2Connection = import('mysql2/promise').Pool | import('mysql2/promise').PoolConnection | import('mysql2/promise').Connection;
export type Mysql2AdapterOptions = {
    /**
     * The database: MySQL 8.4 or later, or MariaDB 10.11 or later. mysql2 speaks
     * to both, so the app tells which.
     */
    dialect: 'mysql' | 'mariadb';
    /**
     * Runs on a server below the supported minimum, with a warning. Default:
     * false.
     */
    allowUnsupportedVersion?: boolean;
};
/**
 * The adapter for mysql2 (its promise API). `enqueue` then takes a `Connection`, a `PoolConnection` (in a
 * transaction) or a `Pool`.
 * @param {import('mysql2/promise').Pool} pool The queue's own pool: claims, leases, results.
 * @param {Mysql2AdapterOptions} options `{ dialect: 'mysql' }` or `{ dialect: 'mariadb' }`.
 * @returns {import('../types.js').Adapter<Mysql2Connection>}
 */
export declare function mysql2Adapter(pool: import('mysql2/promise').Pool, options: Mysql2AdapterOptions): import('../types.js').Adapter<Mysql2Connection>;
