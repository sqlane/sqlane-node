export type Maintenance = {
    /**
     * Arms the timers of the stall recovery and of the cleanup (with `cleanup`). Each runs
     * again after it settles, while the runner is started, at a random time of its first interval.
     */
    start: () => void;
};
/**
 * @typedef {object} Maintenance
 * @property {() => void} start Arms the timers of the stall recovery and of the cleanup (with `cleanup`). Each runs
 *     again after it settles, while the runner is started, at a random time of its first interval.
 */
/**
 * @param {object} params
 * @param {import('./store/store.js').Store} params.store
 * @param {ReadonlyMap<string, import('./job_runs.js').RunningJob>} params.running The jobs that run in this process:
 *     never recovered here.
 * @param {{ leaseMs: number, recoveryIntervalMs: number, cleanupIntervalMs: number }} params.timings
 * @param {boolean} params.cleanup
 * @param {() => import('./runner.js').RunnerState} params.state
 * @param {(func: () => void, delayMs: number) => NodeJS.Timeout} params.setTimer An unref'd timer.
 * @param {(event: import('./types.js').SqlaneEvent) => void} params.emit
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @param {(key: string, delayMs: number) => void} params.armRateWake The timer of a rate key with blocked jobs.
 * @param {() => void} params.wake A wake of all lanes of this process.
 * @param {() => boolean} params.fairGroupsReady The schema has `0011_fair_groups`: the stale jobs have their group.
 * @param {import('./hint_channel.js').HintChannel} params.hintChannel
 * @returns {Maintenance}
 */
export declare function createMaintenance({ store, running, timings: t, cleanup, state, setTimer, emit, reportError, armRateWake, wake, hintChannel, fairGroupsReady, }: {
    store: import('./store/store.js').Store;
    running: ReadonlyMap<string, import('./job_runs.js').RunningJob>;
    timings: {
        leaseMs: number;
        recoveryIntervalMs: number;
        cleanupIntervalMs: number;
    };
    cleanup: boolean;
    state: () => import('./runner.js').RunnerState;
    setTimer: (func: () => void, delayMs: number) => NodeJS.Timeout;
    emit: (event: import('./types.js').SqlaneEvent) => void;
    reportError: (operation: string, error: unknown) => void;
    armRateWake: (key: string, delayMs: number) => void;
    wake: () => void;
    fairGroupsReady: () => boolean;
    hintChannel: import('./hint_channel.js').HintChannel;
}): Maintenance;
