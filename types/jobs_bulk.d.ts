export type JobStatus = import('./types.js').JobStatus;
export type BulkIgnoredJob = import('./types.js').BulkIgnoredJob;
export type BulkResult = import('./types.js').BulkResult;
export type Executor = import('./types.js').Executor;
export type Operation = 'retry' | 'cancel' | 'remove';
/** @typedef {import('./types.js').JobStatus} JobStatus */
/** @typedef {import('./types.js').BulkIgnoredJob} BulkIgnoredJob */
/** @typedef {import('./types.js').BulkResult} BulkResult */
/** @typedef {import('./types.js').Executor} Executor */
/** @typedef {'retry' | 'cancel' | 'remove'} Operation */
/** @type {Record<Operation, readonly JobStatus[]>} The statuses that each operation changes, and its default */
export declare const ACCEPTED: Record<Operation, readonly JobStatus[]>;
export type BulkCall = {
    /**
     * The distinct ids, in the order of their first appearance. Null: a filter.
     */
    ids: string[] | null;
    filter: {
        jobName: string;
        statuses: readonly JobStatus[];
    } | null;
    mode: 'atomic' | 'batches';
    strict: boolean;
    includeAffectedJobIds: boolean;
    budget: 'reset' | 'one_more';
    connection: unknown;
};
/**
 * The arguments of a call, checked.
 * @typedef {object} BulkCall
 * @property {string[] | null} ids The distinct ids, in the order of their first appearance. Null: a filter.
 * @property {{ jobName: string, statuses: readonly JobStatus[] } | null} filter
 * @property {'atomic' | 'batches'} mode
 * @property {boolean} strict
 * @property {boolean} includeAffectedJobIds
 * @property {'reset' | 'one_more'} budget
 * @property {unknown} connection
 */
/**
 * @param {Operation} operation
 * @param {unknown} selector
 * @param {unknown} options
 * @returns {BulkCall}
 * @throws {InvalidOptionsError}
 */
export declare function checkBulk(operation: Operation, selector: unknown, options: unknown): BulkCall;
export type Outcome = {
    count: number;
    /**
     * The changed ids (on MySQL outside a transaction: the locked ones).
     */
    ids: string[];
    ignored: BulkIgnoredJob[];
    cancelled: {
        id: string;
        name: string;
        attempts: number;
    }[];
    /**
     * The names of the retried jobs.
     */
    names: string[];
    /**
     * The concurrency keys of the pending jobs cancelled or removed.
     */
    keys: string[];
};
export type BulkDeps = {
    store: import('./store/store.js').Store;
    adapter: import('./types.js').Adapter<any>;
    tablePrefix: string;
    wakeFor: (name: string, committed: boolean) => void;
    /**
     * Never rejects.
     */
    unblockKeys: (keys: string[]) => Promise<void>;
    emit: (event: import('./types.js').SqlaneEvent) => void;
    reportError: (operation: string, error: unknown) => void;
    notifyChannel: string | null;
};
/**
 * What a transaction changed, for the result and for the work after its commit.
 * @typedef {object} Outcome
 * @property {number} count
 * @property {string[]} ids The changed ids (on MySQL outside a transaction: the locked ones).
 * @property {BulkIgnoredJob[]} ignored
 * @property {{ id: string, name: string, attempts: number }[]} cancelled
 * @property {string[]} names The names of the retried jobs.
 * @property {string[]} keys The concurrency keys of the pending jobs cancelled or removed.
 */
/**
 * @typedef {object} BulkDeps
 * @property {import('./store/store.js').Store} store
 * @property {import('./types.js').Adapter<any>} adapter
 * @property {string} tablePrefix
 * @property {(name: string, committed: boolean) => void} wakeFor
 * @property {(keys: string[]) => Promise<void>} unblockKeys Never rejects.
 * @property {(event: import('./types.js').SqlaneEvent) => void} emit
 * @property {(operation: string, error: unknown) => void} reportError
 * @property {string | null} notifyChannel
 */
/**
 * @param {BulkDeps} deps
 * @returns {(operation: Operation, selector: unknown, options: unknown) => Promise<BulkResult>}
 */
export declare function createBulk({ adapter, tablePrefix: p, wakeFor, unblockKeys, emit, reportError, notifyChannel }: BulkDeps): (operation: Operation, selector: unknown, options: unknown) => Promise<BulkResult>;
