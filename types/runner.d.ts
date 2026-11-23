export type ClaimedJob = import('./store/store.js').ClaimedJob;
export type HandlerEntry = import('./registry.js').HandlerEntry;
export type RunningJob = import('./job_runs.js').RunningJob;
export type Timings = {
    leaseMs: number;
    renewIntervalMs: number;
    recoveryIntervalMs: number;
    cleanupIntervalMs: number;
    pollIntervalMs: number;
    /**
     * How long a failed write of a result is retried.
     */
    maxFinalizingMs: number;
    /**
     * A job without its payload waits this long for it.
     */
    missingPayloadGraceMs: number;
};
/** @typedef {import('./store/store.js').ClaimedJob} ClaimedJob */
/** @typedef {import('./registry.js').HandlerEntry} HandlerEntry */
/** @typedef {import('./job_runs.js').RunningJob} RunningJob */
/**
 * @typedef {object} Timings
 * @property {number} leaseMs
 * @property {number} renewIntervalMs
 * @property {number} recoveryIntervalMs
 * @property {number} cleanupIntervalMs
 * @property {number} pollIntervalMs
 * @property {number} maxFinalizingMs How long a failed write of a result is retried.
 * @property {number} missingPayloadGraceMs A job without its payload waits this long for it.
 */
/** @type {Timings} */
export declare const DEFAULT_TIMINGS: Timings;
export type RunnerState = 'idle' | 'started' | 'draining' | 'closing' | 'closed';
export type RunnerParams = {
    store: import('./store/store.js').Store;
    registry: import('./registry.js').Registry;
    /**
     * The instance's cap.
     */
    localMaxConcurrency: number;
    defaults: import('./defaults.js').ResolvedDefaults;
    cleanup: boolean;
    logger: import('./types.js').Logger | undefined;
    onEvent: ((event: import('./types.js').SqlaneEvent) => void) | undefined;
    hintChannel: import('./hint_channel.js').HintChannel;
    /**
     * The hints come after the commit of their enqueue (PostgreSQL NOTIFY): they wake
     * at once, with no re-probes.
     */
    hintsAfterCommit: boolean;
    /**
     * For tests.
     */
    timings?: Partial<Timings>;
    /**
     * For tests: the random start of the tie pointer.
     */
    random?: () => number;
};
export type Runner = {
    /**
     * `serverCheck`: the
     * check of the server that did not run (the database was down): the dispatcher runs it before its first turn,
     * and the recovery and the cleanup start once it passes.
     */
    start: (options?: {
        serverCheck?: (() => Promise<void>) | null;
    }) => Promise<void>;
    drain: (options?: import('./types.js').DrainOptions) => Promise<import('./types.js').DrainResult>;
    close: (options?: import('./types.js').CloseOptions) => Promise<void>;
    wake: () => void;
    /**
     * An enqueue: its commit is to come.
     */
    onEnqueued: (lanes: string[]) => void;
    /**
     * An enqueue committed: wakes at once, then re-probes.
     */
    onCommitted: (lanes: string[]) => void;
    isClosed: () => boolean;
    isStarted: () => boolean;
    /**
     * Neither started, draining nor closed.
     */
    isIdle: () => boolean;
    /**
     * Calls `onEvent`; logs what it throws.
     */
    emit: (event: import('./types.js').SqlaneEvent) => void;
    /**
     * Makes due the jobs blocked on keys with room, wakes and
     * hints them. Never rejects: a failure is an `error` event (operation `unblock`).
     */
    unblockKeys: (keys: string[]) => Promise<void>;
    /**
     * The lane is added in this process and has a free slot.
     */
    canStartNow: (lane: string) => boolean;
};
/** @typedef {'idle' | 'started' | 'draining' | 'closing' | 'closed'} RunnerState */
/**
 * @typedef {object} RunnerParams
 * @property {import('./store/store.js').Store} store
 * @property {import('./registry.js').Registry} registry
 * @property {number} localMaxConcurrency The instance's cap.
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {boolean} cleanup
 * @property {import('./types.js').Logger | undefined} logger
 * @property {((event: import('./types.js').SqlaneEvent) => void) | undefined} onEvent
 * @property {import('./hint_channel.js').HintChannel} hintChannel
 * @property {boolean} hintsAfterCommit The hints come after the commit of their enqueue (PostgreSQL NOTIFY): they wake
 *     at once, with no re-probes.
 * @property {Partial<Timings>} [timings] For tests.
 * @property {() => number} [random] For tests: the random start of the tie pointer.
 */
/**
 * @typedef {object} Runner
 * @property {(options?: { serverCheck?: (() => Promise<void>) | null }) => Promise<void>} start `serverCheck`: the
 *     check of the server that did not run (the database was down): the dispatcher runs it before its first turn,
 *     and the recovery and the cleanup start once it passes.
 * @property {(options?: import('./types.js').DrainOptions) => Promise<import('./types.js').DrainResult>} drain
 * @property {(options?: import('./types.js').CloseOptions) => Promise<void>} close
 * @property {() => void} wake
 * @property {(lanes: string[]) => void} onEnqueued An enqueue: its commit is to come.
 * @property {(lanes: string[]) => void} onCommitted An enqueue committed: wakes at once, then re-probes.
 * @property {() => boolean} isClosed
 * @property {() => boolean} isStarted
 * @property {() => boolean} isIdle Neither started, draining nor closed.
 * @property {(event: import('./types.js').SqlaneEvent) => void} emit Calls `onEvent`; logs what it throws.
 * @property {(keys: string[]) => Promise<void>} unblockKeys Makes due the jobs blocked on keys with room, wakes and
 *     hints them. Never rejects: a failure is an `error` event (operation `unblock`).
 * @property {(lane: string) => boolean} canStartNow The lane is added in this process and has a free slot.
 */
/**
 * @param {RunnerParams} params
 * @returns {Runner}
 */
export declare function createRunner({ store, registry, localMaxConcurrency, defaults, cleanup, logger, onEvent, hintChannel, hintsAfterCommit, timings, random, }: RunnerParams): Runner;
