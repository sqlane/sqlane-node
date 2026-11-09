export type Knex = import('knex').Knex;
export type KnexTransaction = import('knex').Knex.Transaction;
export type Executor = import('../types.js').Executor;
export type KnexConnection = Knex | KnexTransaction;
export type ToExecutor = (connection: any) => Executor;
/**
 * The adapter for knex (mysql2, mariadb or pg). `enqueue` then takes a knex instance (a transaction of its own) or a
 * knex transaction (the caller's: the job commits with it). After the commit of the outermost transaction, the
 * processes wake at once.
 * @param {Knex} knex The queue's own knex: claims, leases, results. A small pool of its own is best.
 * @param {import('./dialect.js').MysqlFamilyOptions} [options] mysql2: `{ dialect: 'mariadb' }` on MariaDB. The mariadb
 *     client is MariaDB without it.
 * @returns {import('../types.js').Adapter<KnexConnection>}
 */
export declare function knexAdapter(knex: Knex, options?: import('./dialect.js').MysqlFamilyOptions): import('../types.js').Adapter<KnexConnection>;
