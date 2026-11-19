export type DrizzleDatabase = {
    transaction: (func: (tx: any) => Promise<any>) => Promise<any>;
};
export type DrizzleConnection = DrizzleDatabase;
export type DrizzleAdapterOptions = {
    /**
     * The database: `'mysql'` or `'mariadb'` with mysql2, `'postgres'`
     * with node-postgres or postgres.js.
     */
    dialect: import('../types.js').Dialect;
    /**
     * Runs on a server below the supported minimum, with a warning.
     * Default: false.
     */
    allowUnsupportedDbVersion?: boolean;
    /**
     * MySQL and MariaDB: runs with a `sql_mode` that lacks a required
     * flag, or has `ALLOW_INVALID_DATES`, with a warning. Never with `NO_BACKSLASH_ESCAPES`. Default: false.
     */
    allowUnsupportedDbConfiguration?: boolean;
    /**
     * PostgreSQL: hints by LISTEN/NOTIFY, as `pgAdapter(pool, { dialect: 'postgres', notify:
     * true })`.
     */
    notify?: boolean;
};
/**
 * The adapter for Drizzle (mysql2, node-postgres or postgres.js). `enqueue` then takes a Drizzle database (a
 * transaction of its own) or a Drizzle transaction, also nested (the caller's: the job commits with it).
 * @param {DrizzleDatabase} db The queue's own Drizzle database, over a pool: claims, leases, results. A small pool of
 *     its own is best.
 * @param {DrizzleAdapterOptions} options
 * @returns {import('../types.js').Adapter<DrizzleConnection>}
 */
export declare function drizzleAdapter(db: DrizzleDatabase, options: DrizzleAdapterOptions): import('../types.js').Adapter<DrizzleConnection>;
