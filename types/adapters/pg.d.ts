/** @typedef {import('pg').Pool | import('pg').PoolClient | import('pg').Client} PgConnection */
export type PgConnection = import('pg').Pool | import('pg').PoolClient | import('pg').Client;
export type PgAdapterOptions = {
    /**
     * Hints by LISTEN/NOTIFY: `pg_notify` in the enqueue transaction, delivered on commit.
     * Default: false.
     */
    notify?: boolean;
};
/**
 * The adapter for pg. `enqueue` then takes a `Client`, a `PoolClient` (in a transaction) or a `Pool`.
 * @param {import('pg').Pool} pool The queue's own pool: claims, leases, results.
 * @param {PgAdapterOptions} [options]
 * @returns {import('../types.js').Adapter<PgConnection>}
 */
export declare function pgAdapter(pool: import('pg').Pool, options?: PgAdapterOptions): import('../types.js').Adapter<PgConnection>;
