export type EnqueuerOptions<C> = {
    adapter: import('./types.js').Adapter<C>;
    /**
     * Checked.
     */
    tablePrefix: string;
    /**
     * The known definition of
     * a lane.
     */
    findDefinition: (lane: string) => import('./types.js').LaneDefinition | null;
    unknownLanes: 'allow' | 'reject';
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
 * @template C
 * @typedef {object} EnqueuerOptions
 * @property {import('./types.js').Adapter<C>} adapter
 * @property {string} tablePrefix Checked.
 * @property {(lane: string) => import('./types.js').LaneDefinition | null} findDefinition The known definition of
 *     a lane.
 * @property {'allow' | 'reject'} unknownLanes
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {number} maxPayloadBytes
 * @property {string | null} notifyChannel PostgreSQL NOTIFY: `pg_notify` in the enqueue transaction, delivered on
 *     commit. Null: no NOTIFY.
 */
/**
 * @template C
 * @typedef {object} Enqueuer
 * @property {import('./types.js').Sqlane<C>['enqueue']} enqueue
 * @property {import('./types.js').Sqlane<C>['enqueueMany']} enqueueMany
 * @property {(connection: C | undefined, newJob: import('./new_job.js').NewJob)
 *     => Promise<import('./types.js').EnqueueResult>} insertOne A built job. No connection: on the queue's pool, in
 *     a transaction of its own.
 */
/**
 * The enqueue side of an instance.
 * @template C
 * @param {EnqueuerOptions<C>} options
 * @returns {Enqueuer<C>}
 */
export declare function createEnqueuer<C>({ adapter, tablePrefix, findDefinition, unknownLanes, defaults, maxPayloadBytes, notifyChannel, }: EnqueuerOptions<C>): Enqueuer<C>;
