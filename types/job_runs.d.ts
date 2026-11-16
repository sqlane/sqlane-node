export type ClaimedJob = import('./store/store.js').ClaimedJob;
export type HandlerEntry = import('./registry.js').HandlerEntry;
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
export type JobRuns = {
    /**
     * Runs the
     * handler, then writes the result, retried while the lease is renewed. Nothing for a job released or with its lease
     * lost. Counts the result in `counts`, and emits its event.
     */
    runJob: (job: RunningJob, payload: {
        found: boolean;
        payload: unknown;
    }) => Promise<void>;
};
/**
 * @typedef {object} RunningJob
 * @property {string} key
 * @property {ClaimedJob} claimed
 * @property {HandlerEntry} entry
 * @property {AbortController} controller
 * @property {Promise<void>} done Resolves when the result is written (or given up).
 * @property {boolean} settled The handler settled.
 * @property {boolean} released Released or abandoned on close: the result is not written.
 * @property {boolean} timedOut
 * @property {boolean} leaseLost
 * @property {boolean} completionConfirmed The completion batch changed every owned row.
 * @property {number} leaseEndsAt
 * @property {number} startedAt
 */
/**
 * @typedef {object} JobRuns
 * @property {(job: RunningJob, payload: { found: boolean, payload: unknown }) => Promise<void>} runJob Runs the
 *     handler, then writes the result, retried while the lease is renewed. Nothing for a job released or with its lease
 *     lost. Counts the result in `counts`, and emits its event.
 */
/**
 * Waits for the promise, at most `ms`. The timer ends with the wait: it keeps no process alive after it.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @param {{ ref?: boolean }} [options] `ref: false`: the timer alone does not keep the process alive.
 * @returns {Promise<void>}
 */
export declare function waitAtMost(promise: Promise<unknown>, ms: number, { ref }?: {
    ref?: boolean;
}): Promise<void>;
/**
 * @param {object} params
 * @param {import('./store/store.js').Store} params.store
 * @param {import('./defaults.js').ResolvedDefaults} params.defaults
 * @param {import('./types.js').Logger | undefined} params.logger
 * @param {(event: import('./types.js').SqlaneEvent) => void} params.emit
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @param {{ completed: number, retried: number, failed: number }} params.counts The results, counted for drain().
 * @param {{ leaseMs: number, maxFinalizingMs: number, missingPayloadGraceMs: number }} params.timings
 * @param {() => import('./runner.js').RunnerState} params.state
 * @param {import('./failure_jobs.js').FailureJobs} params.failureJobs
 * @param {(key: string, delayMs: number) => void} params.armRateWake The timer of a rate key with a job blocked on it.
 * @param {(entry: HandlerEntry) => void} params.wakeAfterRates Its local rate limits that admit no start now: a wake of
 *     their names when one may start.
 * @param {import('./hint_channel.js').HintChannel} params.hintChannel
 * @returns {JobRuns}
 */
export declare function createJobRuns({ store, defaults, logger, emit, reportError, counts, timings: t, state, failureJobs, armRateWake, wakeAfterRates, hintChannel, }: {
    store: import('./store/store.js').Store;
    defaults: import('./defaults.js').ResolvedDefaults;
    logger: import('./types.js').Logger | undefined;
    emit: (event: import('./types.js').SqlaneEvent) => void;
    reportError: (operation: string, error: unknown) => void;
    counts: {
        completed: number;
        retried: number;
        failed: number;
    };
    timings: {
        leaseMs: number;
        maxFinalizingMs: number;
        missingPayloadGraceMs: number;
    };
    state: () => import('./runner.js').RunnerState;
    failureJobs: import('./failure_jobs.js').FailureJobs;
    armRateWake: (key: string, delayMs: number) => void;
    wakeAfterRates: (entry: HandlerEntry) => void;
    hintChannel: import('./hint_channel.js').HintChannel;
}): JobRuns;
