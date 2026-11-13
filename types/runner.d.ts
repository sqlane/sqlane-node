export type ClaimedJob = import('./store/store.js').ClaimedJob;
export type HandlerEntry = import('./registry.js').HandlerEntry;
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
export type RunningJob = {
    key: string;
    claimed: ClaimedJob;
    entry: HandlerEntry;
    controller: AbortController;
    /**
     * Resolves when the result is written (or given up).
     */
    done: Promise<void>;
    /**
     * The handler settled.
     */
    settled: boolean;
    /**
     * Released or abandoned on close: the result is not written.
     */
    released: boolean;
    timedOut: boolean;
    leaseLost: boolean;
    /**
     * The completion batch changed every owned row.
     */
    completionConfirmed: boolean;
    leaseEndsAt: number;
    startedAt: number;
};
export type RunnerParams = {
    store: import('./store/store.js').Store;
    registry: import('./registry.js').Registry;
    /**
     * The instance's cap.
     */
    maxConcurrency: number;
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
    start: () => Promise<void>;
    drain: (options?: import('./types.js').DrainOptions) => Promise<import('./types.js').DrainResult>;
    close: (options?: import('./types.js').CloseOptions) => Promise<void>;
    wake: () => void;
    /**
     * An enqueue: its commit is to come.
     */
    onEnqueued: (names: string[]) => void;
    /**
     * An enqueue committed: wakes at once, then re-probes.
     */
    onCommitted: (names: string[]) => void;
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
     * This process handles the name and has a free slot for it.
     */
    canStartNow: (name: string) => boolean;
};
/**
 * @param {RunnerParams} params
 * @returns {Runner}
 */
export declare function createRunner({ store, registry, maxConcurrency, defaults, cleanup, logger, onEvent, hintChannel, hintsAfterCommit, timings, random, }: RunnerParams): Runner;
