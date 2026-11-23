export type ClaimedJob = import('./store/store.js').ClaimedJob;
export type HandlerEntry = import('./registry.js').HandlerEntry;
export type LocalLimit = import('./local_limits.js').LocalLimit;
export type Dispatcher = {
    /**
     * Ends the sleep of the
     * loop. The next turn looks at the given lanes, or at all lanes.
     */
    wake: (lanes?: readonly string[], options?: {
        speculative?: boolean;
    }) => void;
    /**
     * For start() and drain(), after the check of the registry: reads the added lanes,
     * and starts the tie pointer at a random lane.
     */
    prepare: () => void;
    /**
     * The loop: one turn after the other,
     * while the runner is started. An error of a turn is retried, or reported and backed off. `serverCheck`: the check
     * of the server that start() could not run (the database was down): no turn before it passes; a `ConfigError` of
     * it ends the loop.
     */
    run: (serverCheck?: (() => Promise<void>) | null) => Promise<void>;
    /**
     * Claims the due
     * jobs of the lanes, by share within the free slots, and starts them. For drain().
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
 * @property {() => void} prepare For start() and drain(), after the check of the registry: reads the added lanes,
 *     and starts the tie pointer at a random lane.
 * @property {(serverCheck?: (() => Promise<void>) | null) => Promise<void>} run The loop: one turn after the other,
 *     while the runner is started. An error of a turn is retried, or reported and backed off. `serverCheck`: the check
 *     of the server that start() could not run (the database was down): no turn before it passes; a `ConfigError` of
 *     it ends the loop.
 * @property {(dueLanes: string[]) => Promise<{ candidates: number, claimed: number }>} claimAndStart Claims the due
 *     jobs of the lanes, by share within the free slots, and starts them. For drain().
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
 * @param {(claimed: ClaimedJob, payload: { found: boolean, payload: unknown }) => void} params.startJob Takes a slot
 *     of the instance and of the local limits of its lane, and runs the job.
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
    startJob: (claimed: ClaimedJob, payload: {
        found: boolean;
        payload: unknown;
    }) => void;
    unblockKeys: (keys: readonly string[]) => Promise<void>;
    armRateWake: (key: string, delayMs: number) => void;
    wakeAfterRates: (entry: HandlerEntry) => void;
}): Dispatcher;
