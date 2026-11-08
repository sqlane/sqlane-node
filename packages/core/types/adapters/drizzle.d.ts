export type DrizzleDatabase = {
    session: {
        client: any;
    };
    transaction: (func: (tx: any) => Promise<any>) => Promise<any>;
};
export type DrizzleConnection = DrizzleDatabase;
export type DrizzleAdapterOptions = {
    /**
     * PostgreSQL: hints by LISTEN/NOTIFY, as `pgAdapter(pool, { notify: true })`.
     */
    notify?: boolean;
};
/**
 * The adapter for Drizzle (mysql2 or node-postgres). `enqueue` then takes a Drizzle database (a transaction of its
 * own) or a Drizzle transaction, also nested (the caller's: the job commits with it).
 * @param {DrizzleDatabase} db The queue's own Drizzle database, over a pool: claims, leases, results. A small pool of
 *     its own is best.
 * @param {DrizzleAdapterOptions} [options]
 * @returns {import('../types.js').Adapter<DrizzleConnection>}
 */
export declare function drizzleAdapter(db: DrizzleDatabase, options?: DrizzleAdapterOptions): import('../types.js').Adapter<DrizzleConnection>;
