export type EnqueuerOptions<C> = {
    adapter: import('./types.js').Adapter<C>;
    /**
     * Checked.
     */
    tablePrefix: string;
    /**
     * The known definition of
     * a name.
     */
    findDefinition: (name: string) => import('./types.js').JobDefinition | null;
    unknownJobs: 'allow' | 'reject';
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
};
/**
 * @template C
 * @typedef {object} EnqueuerOptions
 * @property {import('./types.js').Adapter<C>} adapter
 * @property {string} tablePrefix Checked.
 * @property {(name: string) => import('./types.js').JobDefinition | null} findDefinition The known definition of
 *     a name.
 * @property {'allow' | 'reject'} unknownJobs
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
 */
/**
 * The enqueue side of an instance.
 * @template C
 * @param {EnqueuerOptions<C>} options
 * @returns {Enqueuer<C>}
 */
export declare function createEnqueuer<C>({ adapter, tablePrefix, findDefinition, unknownJobs, defaults, maxPayloadBytes, notifyChannel, }: EnqueuerOptions<C>): Enqueuer<C>;
