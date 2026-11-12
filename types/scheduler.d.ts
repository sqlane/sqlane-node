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
    findDefinition: (name: string) => import('./types.js').JobDefinition | null;
    unknownJobs: 'allow' | 'reject';
    notifyChannel: string | null;
    /**
     * After the commit of a fire: once per name that got a job.
     */
    onCreated: (name: string) => void;
    emit: (event: import('./types.js').SqlaneEvent) => void;
    logger: import('./types.js').Logger | undefined;
    /**
     * For tests.
     */
    timings?: Partial<SchedulerTimings>;
};
export type Scheduler = {
    /**
     * Throws a ConfigError for a second schedule with the same id.
     */
    add: (entry: ScheduleEntry) => void;
    /**
     * At start(): resolves the definitions, and builds a test job of each schedule.
     */
    prepare: () => void;
    /**
     * Inserts the missing rows, reads them all.
     */
    register: () => Promise<ScheduleRead>;
    /**
     * Arms the timer. Null: the registration failed; it retries.
     */
    start: (read: ScheduleRead | null) => void;
    /**
     * Clears the timer, waits for the fire in flight.
     */
    stop: () => Promise<void>;
    list: () => Promise<import('./types.js').ScheduleInfo[]>;
    /**
     * The registration of start() failed: logged as the fires are.
     */
    reportFailure: (error: unknown) => void;
    size: () => number;
};
export type Recheck = {
    candidate: SlotCandidate;
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
 * @property {(name: string) => import('./types.js').JobDefinition | null} findDefinition
 * @property {'allow' | 'reject'} unknownJobs
 * @property {string | null} notifyChannel
 * @property {(name: string) => void} onCreated After the commit of a fire: once per name that got a job.
 * @property {(event: import('./types.js').SqlaneEvent) => void} emit
 * @property {import('./types.js').Logger | undefined} logger
 * @property {Partial<SchedulerTimings>} [timings] For tests.
 */
/**
 * @typedef {object} Scheduler
 * @property {(entry: ScheduleEntry) => void} add Throws a ConfigError for a second schedule with the same id.
 * @property {() => void} prepare At start(): resolves the definitions, and builds a test job of each schedule.
 * @property {() => Promise<ScheduleRead>} register Inserts the missing rows, reads them all.
 * @property {(read: ScheduleRead | null) => void} start Arms the timer. Null: the registration failed; it retries.
 * @property {() => Promise<void>} stop Clears the timer, waits for the fire in flight.
 * @property {() => Promise<import('./types.js').ScheduleInfo[]>} list
 * @property {(error: unknown) => void} reportFailure The registration of start() failed: logged as the fires are.
 * @property {() => number} size
 */
/**
 * A slot that another transaction held: read again later.
 * @typedef {object} Recheck
 * @property {SlotCandidate} candidate
 * @property {number} at Local time.
 * @property {number} delayMs
 * @property {number} since Local time of the first busy result.
 * @property {boolean} warned
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
export declare function createScheduler({ store, defaults, maxPayloadBytes, findDefinition, unknownJobs, notifyChannel, onCreated, emit, logger, timings, }: SchedulerParams): Scheduler;
