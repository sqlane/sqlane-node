export type RunningJob = import('./job_runs.js').RunningJob;
export type Leases = {
    /**
     * Renews the leases while handlers run: also while close() waits for them and
     * during drain(), not only when started. The timer stops when no handler runs; the next claimed job starts it
     * again.
     */
    keepRenewing: () => void;
};
/** @typedef {import('./job_runs.js').RunningJob} RunningJob */
/**
 * @typedef {object} Leases
 * @property {() => void} keepRenewing Renews the leases while handlers run: also while close() waits for them and
 *     during drain(), not only when started. The timer stops when no handler runs; the next claimed job starts it
 *     again.
 */
/**
 * @param {object} params
 * @param {import('./store/store.js').Store} params.store
 * @param {ReadonlyMap<string, RunningJob>} params.running The jobs that run in this process.
 * @param {{ leaseMs: number, renewIntervalMs: number }} params.timings
 * @param {() => import('./runner.js').RunnerState} params.state
 * @param {(func: () => void, delayMs: number) => NodeJS.Timeout} params.setTimer An unref'd timer.
 * @param {(event: import('./types.js').SqlaneEvent) => void} params.emit
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @returns {Leases}
 */
export declare function createLeases({ store, running, timings: t, state, setTimer, emit, reportError }: {
    store: import('./store/store.js').Store;
    running: ReadonlyMap<string, RunningJob>;
    timings: {
        leaseMs: number;
        renewIntervalMs: number;
    };
    state: () => import('./runner.js').RunnerState;
    setTimer: (func: () => void, delayMs: number) => NodeJS.Timeout;
    emit: (event: import('./types.js').SqlaneEvent) => void;
    reportError: (operation: string, error: unknown) => void;
}): Leases;
