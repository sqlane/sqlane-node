export type Knex = import('knex').Knex;
export type KnexTransaction = import('knex').Knex.Transaction;
export type Executor = import('@sqlane/core').Executor;
export type KnexConnection = Knex | KnexTransaction;
export type ToExecutor = (connection: any) => Executor;
/**
 * The adapter for knex (mysql2 or pg). `enqueue` then takes a knex instance (a transaction of its own) or a knex
 * transaction (the caller's: the job commits with it). After the commit of the outermost transaction, the processes
 * wake at once.
 * @param {Knex} knex The queue's own knex: claims, leases, results. A small pool of its own is best.
 * @returns {import('@sqlane/core').Adapter<KnexConnection>}
 */
export declare function knexAdapter(knex: Knex): import('@sqlane/core').Adapter<KnexConnection>;
