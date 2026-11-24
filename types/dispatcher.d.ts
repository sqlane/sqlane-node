export type ClaimedJob = import('./store/store.js').ClaimedJob;
export type HandlerEntry = import('./registry.js').HandlerEntry;
export type LocalLimit = import('./local_limits.js').LocalLimit;
export type StartJob = (claimed: ClaimedJob, payload: {
    found: boolean;
    payload: unknown;
}, entry: HandlerEntry) => void;
export type Dispatcher = {
    /**
     * Ends the sleep of the
     * loop. The next turn looks at the given lanes, or at all lanes.
     */
    wake: (lanes?: readonly string[], options?: {
        speculative?: boolean;
    }) => void;
    /**
     * For start() and drain(), after the check of the registry: reads the handled
     * lanes, and starts the tie pointer at a random lane.
     */
    prepare: () => void;
    /**
     * Lanes handled from now on: mounted after prepare().
     */
    added: (entries: readonly HandlerEntry[]) => void;
    /**
     * Lanes no longer handled: unmounted.
     */
    removed: (entries: readonly HandlerEntry[]) => void;
    /**
     * A lane paused or resumed in this process: no claim of
     * it while paused. For the life of the dispatcher, whether the lane is handled or not.
     */
    setPaused: (lane: string, paused: boolean) => void;
    isPaused: (lane: string) => boolean;
    /**
     * The loop: one turn after the other,
     * while the runner is started. An error of a turn is retried, or reported and backed off. `serverCheck`: the check
     * of the server that start() could not run (the database was down): no turn before it passes; a `ConfigError` of
     * it ends the loop.
     */
    run: (serverCheck?: (() => Promise<void>) | null) => Promise<void>;
    /**
     * Claims the due
     * jobs of the lanes, by share within the free slots, and starts them. For drain(). The lanes not handled here, or
     * paused, are left out.
     */
    claimAndStart: (dueLanes: string[]) => Promise<{
        candidates: number;
        claimed: number;
    }>;
    /**
     * The jobs of the lane that can start now: under its local
     * limits and the instance's cap.
     */
    freeSlots: (entry: HandlerEntry) => number;
    /**
     * A claim runs: it may have counted the free slots before a job ended.
     */
    claiming: () => boolean;
};
/**
 * @typedef {object} Dispatcher
 * @property {(lanes?: readonly string[], options?: { speculative?: boolean }) => void} wake Ends the sleep of the
 *     loop. The next turn looks at the given lanes, or at all lanes.
 * @property {() => void} prepare For start() and drain(), after the check of the registry: reads the handled
 *     lanes, and starts the tie pointer at a random lane.
 * @property {(entries: readonly HandlerEntry[]) => void} added Lanes handled from now on: mounted after prepare().
 * @property {(entries: readonly HandlerEntry[]) => void} removed Lanes no longer handled: unmounted.
 * @property {(lane: string, paused: boolean) => void} setPaused A lane paused or resumed in this process: no claim of
 *     it while paused. For the life of the dispatcher, whether the lane is handled or not.
 * @property {(lane: string) => boolean} isPaused
 * @property {(serverCheck?: (() => Promise<void>) | null) => Promise<void>} run The loop: one turn after the other,
 *     while the runner is started. An error of a turn is retried, or reported and backed off. `serverCheck`: the check
 *     of the server that start() could not run (the database was down): no turn before it passes; a `ConfigError` of
 *     it ends the loop.
 * @property {(dueLanes: string[]) => Promise<{ candidates: number, claimed: number }>} claimAndStart Claims the due
 *     jobs of the lanes, by share within the free slots, and starts them. For drain(). The lanes not handled here, or
 *     paused, are left out.
 * @property {(entry: HandlerEntry) => number} freeSlots The jobs of the lane that can start now: under its local
 *     limits and the instance's cap.
 * @property {() => boolean} claiming A claim runs: it may have counted the free slots before a job ended.
 */
/**
 * @param {object} params
 * @param {import('./store/store.js').Store} params.store
 * @param {import('./registry.js').Registry} params.registry
 * @param {number} params.localMaxConcurrency The instance's cap.
 * @param {ReadonlyMap<string, unknown>} params.running The jobs that run in this process: each takes a slot.
 * @param {{ leaseMs: number, pollIntervalMs: number }} params.timings
 * @param {() => number} params.random The random start of the tie pointer.
 * @param {() => import('./runner.js').RunnerState} params.state
 * @param {import('./types.js').Logger | undefined} params.logger
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @param {StartJob} params.startJob Takes a slot of the instance and of the local limits of its lane, and runs the job
 *     with the handler of the claim: an unmount during the claim does not change it.
 * @param {(keys: readonly string[]) => Promise<void>} params.unblockKeys The unblock of the concurrency keys: never
 *     rejects.
 * @param {(key: string, delayMs: number) => void} params.armRateWake The timer of a rate key with blocked jobs.
 * @param {(entry: HandlerEntry) => void} params.wakeAfterRates Its local rate limits that admit no start now: a wake of
 *     their lanes when one may start.
 * @returns {Dispatcher}
 */
export declare function createDispatcher({ store, registry, localMaxConcurrency, running, timings: t, random, state, logger, reportError, startJob, unblockKeys, armRateWake, wakeAfterRates, }: {
    store: import('./store/store.js').Store;
    registry: import('./registry.js').Registry;
    localMaxConcurrency: number;
    running: ReadonlyMap<string, unknown>;
    timings: {
        leaseMs: number;
        pollIntervalMs: number;
    };
    random: () => number;
    state: () => import('./runner.js').RunnerState;
    logger: import('./types.js').Logger | undefined;
    reportError: (operation: string, error: unknown) => void;
    startJob: StartJob;
    unblockKeys: (keys: readonly string[]) => Promise<void>;
    armRateWake: (key: string, delayMs: number) => void;
    wakeAfterRates: (entry: HandlerEntry) => void;
}): Dispatcher;
