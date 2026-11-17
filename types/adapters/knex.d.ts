export type Knex = import('knex').Knex;
export type KnexTransaction = import('knex').Knex.Transaction;
export type Executor = import('../types.js').Executor;
export type KnexConnection = Knex | KnexTransaction;
export type KnexAdapterOptions = {
    /**
     * The database: `'mysql'` or `'mariadb'` with the mysql2 client,
     * `'mariadb'` with the mariadb client, `'postgres'` with the pg client.
     */
    dialect: import('../types.js').Dialect;
    /**
     * Runs on a server below the supported minimum, with a warning. Default:
     * false.
     */
    allowUnsupportedVersion?: boolean;
    /**
     * pg: named prepared statements, each SQL text parsed and planned once per connection.
     * Opt-in: not behind a pooler in transaction mode without prepared statement support (PgBouncer before 1.21).
     * Default: false.
     */
    prepare?: boolean;
};
export type ToExecutor = (connection: any) => Executor;
/**
 * The driver of a knex instance, and the dialects that it can run.
 * @param {Knex} knex
 * @param {string} where The adapter, for the error.
 * @returns {{ driverName: 'mysql2' | 'mariadb' | 'pg', dialects: import('../types.js').Dialect[] }}
 */
export declare function knexDriverOf(knex: Knex, where: string): {
    driverName: 'mysql2' | 'mariadb' | 'pg';
    dialects: import('../types.js').Dialect[];
};
/**
 * The adapter for knex (mysql2, mariadb or pg). `enqueue` then takes a knex instance (a transaction of its own) or a
 * knex transaction (the caller's: the job commits with it). After the commit of the outermost transaction, the
 * processes wake at once.
 * @param {Knex} knex The queue's own knex: claims, leases, results. A small pool of its own is best.
 * @param {KnexAdapterOptions} options `{ dialect }`. pg: `{ prepare: true }`, named prepared statements.
 * @returns {import('../types.js').Adapter<KnexConnection>}
 */
export declare function knexAdapter(knex: Knex, options: KnexAdapterOptions): import('../types.js').Adapter<KnexConnection>;
