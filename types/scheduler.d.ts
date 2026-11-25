export type ScheduleEntry = import('./schedule.js').ScheduleEntry;
export type SlotCandidate = import('./store/fire_slots.js').SlotCandidate;
export type FireResult = import('./store/fire_slots.js').FireResult;
export type ClockSample = import('./store/fire_slots.js').ClockSample;
export type ScheduleRead = import('./store/store.js').ScheduleRead;
export type SchedulerTimings = {
    /**
     * A slot is on time while the database time minus the slot is at most this.
     */
    graceMs: number;
    /**
     * A slot more than this ahead of the database time is deferred.
     */
    futureMs: number;
    /**
     * A late slot runs if the cursor is at most one period plus this older.
     */
    catchUpReachMs: number;
    /**
     * When a busy row is read again; doubles while it stays busy.
     */
    recheckMs: number;
    maxRecheckMs: number;
    /**
     * The longest sleep of the timer: wall-clock jumps, the limit of setTimeout.
     */
    maxSleepMs: number;
    /**
     * The backoff after a failed fire; doubles.
     */
    retryMs: number;
    maxRetryMs: number;
    /**
     * Only samples of the database clock with a round trip up to this count.
     */
    skewSampleRttMs: number;
    /**
     * The samples of this window count: the one with the smallest round trip wins.
     */
    skewWindowMs: number;
    /**
     * Above this, a warning, at most once per skew window.
     */
    skewWarnMs: number;
    /**
     * The most candidates in one fire transaction.
     */
    batch: number;
    /**
     * The clock of the process.
     */
    now: () => number;
    /**
     * A clock that never jumps: tells a step of `now()` from the time that passed.
     */
    monotonic: () => number;
    /**
     * Undocumented, for the benchmarks: called at each wake of the timer.
     */
    onWake: (() => void) | null;
};
/** @typedef {import('./schedule.js').ScheduleEntry} ScheduleEntry */
/** @typedef {import('./store/fire_slots.js').SlotCandidate} SlotCandidate */
/** @typedef {import('./store/fire_slots.js').FireResult} FireResult */
/** @typedef {import('./store/fire_slots.js').ClockSample} ClockSample */
/** @typedef {import('./store/store.js').ScheduleRead} ScheduleRead */
/**
 * @typedef {object} SchedulerTimings
 * @property {number} graceMs A slot is on time while the database time minus the slot is at most this.
 * @property {number} futureMs A slot more than this ahead of the database time is deferred.
 * @property {number} catchUpReachMs A late slot runs if the cursor is at most one period plus this older.
 * @property {number} recheckMs When a busy row is read again; doubles while it stays busy.
 * @property {number} maxRecheckMs
 * @property {number} maxSleepMs The longest sleep of the timer: wall-clock jumps, the limit of setTimeout.
 * @property {number} retryMs The backoff after a failed fire; doubles.
 * @property {number} maxRetryMs
 * @property {number} skewSampleRttMs Only samples of the database clock with a round trip up to this count.
 * @property {number} skewWindowMs The samples of this window count: the one with the smallest round trip wins.
 * @property {number} skewWarnMs Above this, a warning, at most once per skew window.
 * @property {number} batch The most candidates in one fire transaction.
 * @property {() => number} now The clock of the process.
 * @property {() => number} monotonic A clock that never jumps: tells a step of `now()` from the time that passed.
 * @property {(() => void) | null} onWake Undocumented, for the benchmarks: called at each wake of the timer.
 */
/** @type {SchedulerTimings} */
export declare const DEFAULT_SCHEDULER_TIMINGS: SchedulerTimings;
export type SchedulerParams = {
    store: import('./store/store.js').Store;
    defaults: import('./defaults.js').ResolvedDefaults;
    maxPayloadBytes: number;
    notifyChannel: string | null;
    /**
     * After the commit of a fire: once per lane that got a job.
     */
    onCreated: (lane: string) => void;
    emit: (event: import('./types.js').SqlaneEvent) => void;
    logger: import('./types.js').Logger | undefined;
    /**
     * For tests.
     */
    timings?: Partial<SchedulerTimings>;
    /**
     * The schema has `0011_fair_groups`. Without, the slots get no fair group.
     * Default: it has.
     */
    fairGroupsReady?: () => boolean;
};
export type Scheduler = {
    /**
     * Throws a ConfigError for a second schedule with the same id. Once
     * started, the entry registers at once (or with the registration that retries), then fires.
     */
    add: (entry: ScheduleEntry) => void;
    /**
     * Fires the entry no more, if it is still the one of its id. A fire
     * in flight completes with it.
     */
    remove: (entry: ScheduleEntry) => void;
    has: (id: string) => boolean;
    /**
     * By id.
     */
    entries: () => ReadonlyMap<string, ScheduleEntry>;
    /**
     * Builds a test job of the entry: a ConfigError for a
     * payload or limits that its fires would refuse.
     */
    check: (entry: ScheduleEntry, where: string) => void;
    /**
     * Inserts the missing rows, reads them all.
     */
    register: () => Promise<ScheduleRead>;
    /**
     * Arms the timer. Null: no registration, as no schedule was
     * there, or a failed one (`reportFailure()`), which retries with a backoff. The entries that the registration did
     * not include register at once.
     */
    start: (read: ScheduleRead | null) => void;
    /**
     * Registers now, then arms the timer: start() did not register (the check of
     * the server did not run).
     */
    startRegistering: () => void;
    /**
     * Clears the timer, waits for the steps in flight.
     */
    stop: () => Promise<void>;
    /**
     * The registration of start() failed: logged as the fires are.
     */
    reportFailure: (error: unknown) => void;
    size: () => number;
};
export type Recheck = {
    candidate: SlotCandidate;
    /**
     * The entry of the busy fire: its recheck is for it only.
     */
    entry: ScheduleEntry;
    /**
     * Local time.
     */
    at: number;
    delayMs: number;
    /**
     * Local time of the first busy result.
     */
    since: number;
    warned: boolean;
    /**
     * Its fire runs: a busy result of it backs off. Busy fires of later slots keep its time.
     */
    fired?: boolean;
};
export type FireOutcome = {
    decided: import('./store/fire_slots.js').DecidedSlot[];
    busy: string[];
    deferred: string[];
    failed: SlotCandidate[];
    /**
     * Of the last fire that read it.
     */
    dbNowMs: number | null;
};
/**
 * @typedef {object} SchedulerParams
 * @property {import('./store/store.js').Store} store
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {number} maxPayloadBytes
 * @property {string | null} notifyChannel
 * @property {(lane: string) => void} onCreated After the commit of a fire: once per lane that got a job.
 * @property {(event: import('./types.js').SqlaneEvent) => void} emit
 * @property {import('./types.js').Logger | undefined} logger
 * @property {Partial<SchedulerTimings>} [timings] For tests.
 * @property {() => boolean} [fairGroupsReady] The schema has `0011_fair_groups`. Without, the slots get no fair group.
 *     Default: it has.
 */
/**
 * @typedef {object} Scheduler
 * @property {(entry: ScheduleEntry) => void} add Throws a ConfigError for a second schedule with the same id. Once
 *     started, the entry registers at once (or with the registration that retries), then fires.
 * @property {(entry: ScheduleEntry) => void} remove Fires the entry no more, if it is still the one of its id. A fire
 *     in flight completes with it.
 * @property {(id: string) => boolean} has
 * @property {() => ReadonlyMap<string, ScheduleEntry>} entries By id.
 * @property {(entry: ScheduleEntry, where: string) => void} check Builds a test job of the entry: a ConfigError for a
 *     payload or limits that its fires would refuse.
 * @property {() => Promise<ScheduleRead>} register Inserts the missing rows, reads them all.
 * @property {(read: ScheduleRead | null) => void} start Arms the timer. Null: no registration, as no schedule was
 *     there, or a failed one (`reportFailure()`), which retries with a backoff. The entries that the registration did
 *     not include register at once.
 * @property {() => void} startRegistering Registers now, then arms the timer: start() did not register (the check of
 *     the server did not run).
 * @property {() => Promise<void>} stop Clears the timer, waits for the steps in flight.
 * @property {(error: unknown) => void} reportFailure The registration of start() failed: logged as the fires are.
 * @property {() => number} size
 */
/**
 * A slot that another transaction held: read again later.
 * @typedef {object} Recheck
 * @property {SlotCandidate} candidate
 * @property {ScheduleEntry} entry The entry of the busy fire: its recheck is for it only.
 * @property {number} at Local time.
 * @property {number} delayMs
 * @property {number} since Local time of the first busy result.
 * @property {boolean} warned
 * @property {boolean} [fired] Its fire runs: a busy result of it backs off. Busy fires of later slots keep its time.
 */
/**
 * @typedef {object} FireOutcome
 * @property {import('./store/fire_slots.js').DecidedSlot[]} decided
 * @property {string[]} busy
 * @property {string[]} deferred
 * @property {SlotCandidate[]} failed
 * @property {number | null} dbNowMs Of the last fire that read it.
 */
/**
 * @param {SchedulerParams} params
 * @returns {Scheduler}
 */
export declare function createScheduler({ store, defaults, maxPayloadBytes, notifyChannel, onCreated, emit, logger, timings, fairGroupsReady, }: SchedulerParams): Scheduler;
