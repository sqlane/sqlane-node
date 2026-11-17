export type PgConnection = import('pg').Pool | import('pg').PoolClient | import('pg').Client;
export type PgAdapterOptions = {
    /**
     * The database: PostgreSQL 15 or later.
     */
    dialect: 'postgres';
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
     * Hints by LISTEN/NOTIFY: `pg_notify` in the enqueue transaction, delivered on commit.
     * Default: false.
     */
    notify?: boolean;
    /**
     * Named prepared statements: each SQL text is parsed and planned once per connection.
     * Set false behind a pooler in transaction mode without prepared statement support (PgBouncer before 1.21).
     * Default: true.
     */
    prepare?: boolean;
};
/**
 * The adapter for pg. `enqueue` then takes a `Client`, a `PoolClient` (in a transaction) or a `Pool`.
 * @param {import('pg').Pool} pool The queue's own pool: claims, leases, results.
 * @param {PgAdapterOptions} options
 * @returns {import('../types.js').Adapter<PgConnection>}
 */
export declare function pgAdapter(pool: import('pg').Pool, options: PgAdapterOptions): import('../types.js').Adapter<PgConnection>;
