export type PostgresJsSql = {
    /**
     * Resolves
     * to the rows, with `count`.
     */
    unsafe: (query: string, parameters?: unknown[], options?: {
        prepare?: boolean;
    }) => Promise<any>;
    begin?: (options: string, func: (sql: any) => Promise<any>) => Promise<any>;
    /**
     * The pool.
     */
    reserve?: () => Promise<PostgresJsSql & {
        release: () => void;
    }>;
    /**
     * A reserved connection.
     */
    release?: () => void;
    /**
     * The pool.
     */
    listen?: (channel: string, onNotify: (payload: string) => void) => Promise<{
        unlisten: () => Promise<void>;
    }>;
    /**
     * The pool.
     */
    options?: {
        transform?: any;
    };
};
export type PostgresJsConnection = PostgresJsSql;
export type PostgresJsAdapterOptions = {
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
};
/**
 * The adapter for postgres.js. `enqueue` then takes the `sql` of postgres.js (a transaction of its own) or the `sql` of
 * a transaction (the caller's: the job commits with it).
 * @param {PostgresJsSql} sql The queue's own `postgres(…)`: claims, leases, results. A small pool of its own is best,
 *     without a `transform` of results (sqlane reads its own columns).
 * @param {PostgresJsAdapterOptions} options
 * @returns {import('../types.js').Adapter<PostgresJsConnection>}
 */
export declare function postgresJsAdapter(sql: PostgresJsSql, options: PostgresJsAdapterOptions): import('../types.js').Adapter<PostgresJsConnection>;
