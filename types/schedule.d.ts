export declare const MAX_KEY_LENGTH = 64;
/** The prefix of the `jobId` of a slot: reserved */
export declare const SLOT_PREFIX = "schedule:";
export type Timing = {
    kind: 'cron';
    cron: import('./cron.js').CronSpec;
    timeZone: string;
} | {
    kind: 'every';
    ms: number;
};
export type ScheduleEntry = {
    /**
     * The job name, or `<job name>:<key>`.
     */
    id: string;
    name: string;
    key: string | null;
    timing: Timing;
    /**
     * Normalized: stored in its row.
     */
    spec: string;
    payload: unknown;
    missed: 'once' | 'skip';
    overlap: 'allow' | 'skip';
    /**
     * Set by the scheduler at start().
     */
    definition: import('./types.js').JobDefinition | null;
    /**
     * In memory. Null: no slot within the runtime horizon.
     */
    nextAt: number | null;
    /**
     * 0, or the backoff after a failed fire.
     */
    retryDelayMs: number;
    /**
     * 0: no jitter.
     */
    jitterMs: number;
    /**
     * The due time of the last slot asked for.
     */
    dueCache: {
        slot: number;
        due: number;
    } | null;
};
/**
 * @typedef {{ kind: 'cron', cron: import('./cron.js').CronSpec, timeZone: string } | { kind: 'every', ms: number }}
 *     Timing
 */
/**
 * A schedule of this process.
 * @typedef {object} ScheduleEntry
 * @property {string} id The job name, or `<job name>:<key>`.
 * @property {string} name
 * @property {string | null} key
 * @property {Timing} timing
 * @property {string} spec Normalized: stored in its row.
 * @property {unknown} payload
 * @property {'once' | 'skip'} missed
 * @property {'allow' | 'skip'} overlap
 * @property {import('./types.js').JobDefinition | null} definition Set by the scheduler at start().
 * @property {number | null} nextAt In memory. Null: no slot within the runtime horizon.
 * @property {number} retryDelayMs 0, or the backoff after a failed fire.
 * @property {number} jitterMs 0: no jitter.
 * @property {{ slot: number, due: number } | null} dueCache The due time of the last slot asked for.
 */
/**
 * @param {unknown} key
 * @returns {boolean}
 */
export declare function isSlotKey(key: unknown): boolean;
/**
 * @param {number} ms
 * @returns {boolean} A job id can carry the slot.
 */
export declare function isSlotTime(ms: number): boolean;
/**
 * The `jobId` of a slot (the job id without its name): the scheduler and the `slot` enqueue option build the same one.
 * @param {string | null | undefined} key
 * @param {number} slotMs
 * @returns {string}
 */
export declare function slotJobIdOf(key: string | null | undefined, slotMs: number): string;
/**
 * Checks the options of `schedule()`.
 * @param {unknown} job A job definition or a name.
 * @param {unknown} options
 * @returns {ScheduleEntry} Without its definition and its next slot.
 */
export declare function checkSchedule(job: unknown, options: unknown): ScheduleEntry;
/**
 * @param {ScheduleEntry} entry
 * @param {number} afterMs
 * @returns {number | null} The first slot after the instant. Null: none within the runtime horizon.
 */
export declare function nextSlot(entry: ScheduleEntry, afterMs: number): number | null;
/**
 * @param {ScheduleEntry} entry
 * @param {number} atMs
 * @returns {number | null} The last slot at or before the instant.
 */
export declare function latestSlot(entry: ScheduleEntry, atMs: number): number | null;
/**
 * @param {ScheduleEntry} entry
 * @param {number} slotMs
 * @returns {number | null} The slot before a slot: the catch-up reach counts from it.
 */
export declare function previousSlot(entry: ScheduleEntry, slotMs: number): number | null;
/**
 * @param {ScheduleEntry} entry
 * @param {number} slotMs
 * @returns {string} The `jobId` of the slot: `schedule:[<key>:]<ISO>`.
 */
export declare function slotJobId(entry: ScheduleEntry, slotMs: number): string;
/**
 * The slot of a job, from its id. Only the scheduler and the `slot` enqueue option make such ids.
 * @param {string} jobId The id of a job: `<name>:<jobId>`, or a ULID.
 * @returns {Date | null} Null: not the job of a slot.
 */
export declare function scheduledAtOf(jobId: string): Date | null;
/**
 * cyrb53: a public-domain 53-bit string hash, stable across Node.js versions (`Math.imul`).
 * @param {string} text
 * @returns {number} An integer in [0, 2^53).
 */
export declare function cyrb53(text: string): number;
/**
 * The jitter of a slot: below the jitter and below the gap to the next slot, so the due times keep the order of the
 * slots. Whole seconds when that limit is at least 1 s: the slots of one second share a fire. Every process computes
 * the same offset: the hash of `<schedule id>|<slot ms>` (an integer string). A change of this input changes every
 * offset.
 * @param {ScheduleEntry} entry
 * @param {number} slotMs
 * @param {number | null} nextSlotMs Null: no next slot within the horizon.
 * @returns {number}
 */
export declare function jitterOffset(entry: ScheduleEntry, slotMs: number, nextSlotMs: number | null): number;
/**
 * @param {ScheduleEntry} entry
 * @param {number} slotMs
 * @returns {number} When the job of the slot is due: the slot plus its jitter. The slot itself without jitter.
 */
export declare function dueOf(entry: ScheduleEntry, slotMs: number): number;
/**
 * With jitter, at start(): the latest slot whose due time has come, and the next slot to track: the first one whose
 * due time is ahead. It may be a slot before `atMs`.
 * @param {ScheduleEntry} entry
 * @param {number} atMs
 * @returns {{ latest: number | null, nextAt: number | null }}
 */
export declare function pendingSlots(entry: ScheduleEntry, atMs: number): {
    latest: number | null;
    nextAt: number | null;
};
