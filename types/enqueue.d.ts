export type EnqueuerOptions<C> = {
    adapter: import('./types.js').Adapter<C>;
    /**
     * Checked.
     */
    tablePrefix: string;
    defaults: import('./defaults.js').ResolvedDefaults;
    maxPayloadBytes: number;
    /**
     * PostgreSQL NOTIFY: `pg_notify` in the enqueue transaction, delivered on
     * commit. Null: no NOTIFY.
     */
    notifyChannel: string | null;
};
export type Enqueuer<C> = {
    enqueue: import('./types.js').Sqlane<C>['enqueue'];
    enqueueMany: import('./types.js').Sqlane<C>['enqueueMany'];
    /**
     * A built job. No connection: on the queue's pool, in
     * a transaction of its own.
     */
    insertOne: (connection: C | undefined, newJob: import('./new_job.js').NewJob) => Promise<import('./types.js').EnqueueResult>;
};
/**
 * The enqueue side of an instance.
 * @template C
 * @param {EnqueuerOptions<C>} options
 * @returns {Enqueuer<C>}
 */
export declare function createEnqueuer<C>({ adapter, tablePrefix, defaults, maxPayloadBytes, notifyChannel, }: EnqueuerOptions<C>): Enqueuer<C>;
