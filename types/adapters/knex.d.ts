export type Knex = import('knex').Knex;
export type KnexTransaction = import('knex').Knex.Transaction;
export type Executor = import('../types.js').Executor;
export type KnexConnection = Knex | KnexTransaction;
export type KnexAdapterOptions = {
    /**
     * mysql2: `'mariadb'` on MariaDB. Default: `'mysql'`. The mariadb client is
     * MariaDB without it.
     */
    dialect?: 'mysql' | 'mariadb';
    /**
     * pg: named prepared statements, each SQL text parsed and planned once per connection.
     * Opt-in: not behind a pooler in transaction mode without prepared statement support (PgBouncer before 1.21).
     * Default: false.
     */
    prepare?: boolean;
};
export type ToExecutor = (connection: any) => Executor;
/**
 * The adapter for knex (mysql2, mariadb or pg). `enqueue` then takes a knex instance (a transaction of its own) or a
 * knex transaction (the caller's: the job commits with it). After the commit of the outermost transaction, the
 * processes wake at once.
 * @param {Knex} knex The queue's own knex: claims, leases, results. A small pool of its own is best.
 * @param {KnexAdapterOptions} [options] mysql2: `{ dialect: 'mariadb' }` on MariaDB. pg: `{ prepare: true }`, named
 *     prepared statements.
 * @returns {import('../types.js').Adapter<KnexConnection>}
 */
export declare function knexAdapter(knex: Knex, options?: KnexAdapterOptions): import('../types.js').Adapter<KnexConnection>;
