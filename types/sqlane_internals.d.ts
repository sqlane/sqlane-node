export type AttachedRunner = {
    /**
     * An enqueue in this process: its commit is to come.
     */
    onEnqueued: (lanes: string[]) => void;
    /**
     * An enqueue in this process committed.
     */
    onCommitted: (lanes: string[]) => void;
    /**
     * The lane is handled here, not paused, and has a free slot: no hint.
     */
    canStartNow: (lane: string) => boolean;
    /**
     * Jobs of the lanes are due: an unblock.
     */
    wake: (lanes: string[]) => void;
    /**
     * Started, starting, draining or closing: its queries run.
     */
    isBusy: () => boolean;
    close: (options?: import('./types.js').CloseOptions) => Promise<void>;
    /**
     * Its schedules, by id.
     */
    schedules: () => ReadonlyMap<string, import('./schedule.js').ScheduleEntry>;
};
export type SqlaneInternals = {
    adapter: import('./types.js').Adapter<any>;
    tablePrefix: string;
    store: import('./store/store.js').Store;
    defaults: import('./defaults.js').ResolvedDefaults;
    maxPayloadBytes: number;
    pollIntervalMs: number;
    cleanup: boolean;
    /**
     * Undocumented options, for the tests of sqlane.
     */
    testTimings: Record<string, any>;
    logger: import('./types.js').Logger | undefined;
    onEvent: ((event: import('./types.js').SqlaneEvent) => void) | undefined;
    hintChannel: import('./hint_channel.js').HintChannel;
    notifyChannel: string | null;
    /**
     * Wakes this process, sends the hint to the others.
     */
    wakeFor: (lane: string, committed: boolean) => void;
    /**
     * An error of an optimization: a warning.
     */
    reportError: (operation: string, error: unknown) => void;
    checkServerOnce: (where: string) => Promise<void>;
    isClosed: () => boolean;
    /**
     * Throws a ConfigError when a runner is attached already.
     */
    attach: (runner: AttachedRunner) => void;
};
/**
 * @param {object} sqlane
 * @param {SqlaneInternals} internals
 */
export declare function setInternals(sqlane: object, internals: SqlaneInternals): void;
/**
 * @param {unknown} sqlane
 * @param {string} where For the error.
 * @returns {SqlaneInternals}
 */
export declare function internalsOf(sqlane: unknown, where: string): SqlaneInternals;
