export type Kysely = import('kysely').Kysely<any>;
export type KyselyTransaction = import('kysely').Transaction<any>;
export type Executor = import('../types.js').Executor;
export type KyselyConnection = Kysely | KyselyTransaction;
export type KyselyAdapterOptions = {
    /**
     * The database of the Kysely instance: Kysely does not tell it.
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
};
/**
 * The adapter for Kysely (its MySQL or PostgreSQL dialect). `enqueue` then takes a Kysely instance (a transaction of
 * its own) or a Kysely transaction, also a controlled one (the caller's: the job commits with it).
 * @param {Kysely} db The queue's own Kysely: claims, leases, results. A small pool of its own is best.
 * @param {KyselyAdapterOptions} options
 * @returns {import('../types.js').Adapter<KyselyConnection>}
 */
export declare function kyselyAdapter(db: Kysely, options: KyselyAdapterOptions): import('../types.js').Adapter<KyselyConnection>;
