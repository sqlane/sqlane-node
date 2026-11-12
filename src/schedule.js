// The schedules of an instance: their options, and their slots. Pure: the scheduler (scheduler.js) runs them. See
// docs/design.md › Schedules.
import { latestCronTime, nextCronTime, parseCron, previousCronTime } from './cron.js';
import { parseDuration } from './duration.js';
import { ConfigError } from './errors.js';
import { isTimeZone, normalizeTimeZoneCase } from './time_zone.js';
import { checkObject, isPlainObject, JOB_NAME_REGEXP, PRINTABLE_ID_REGEXP } from './validate.js';

const SECOND_MS = 1000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A cron must fire within this time of `schedule()`: covers February 29 on a weekday, across 2100 */
const FIRES_WITHIN_MS = 50 * 366 * DAY_MS;
export const MAX_KEY_LENGTH = 64;
/** The prefix of the `jobId` of a slot: reserved */
export const SLOT_PREFIX = 'schedule:';
const OPTION_NAMES = ['cron', 'timezone', 'every', 'key', 'payload', 'missed', 'overlap', 'jitter'];
/** The job ids of slots: `<name>:schedule:[<key>:]<ISO>`. The ISO time is anchored at the end: a key may have `:`. */
const SLOT_ID_REGEXP = /^[a-z][a-z0-9_.-]*:schedule:(?:[\x20-\x7E]*:)?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/;
/** The slots that a job id can carry: `toISOString()` has 24 characters in these years */
const MIN_SLOT_MS = Date.UTC(1970, 0, 1);
const MAX_SLOT_MS = Date.UTC(10_000, 0, 1) - 1;

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
export function isSlotKey(key) {
    return typeof key === 'string' && key.length <= MAX_KEY_LENGTH && PRINTABLE_ID_REGEXP.test(key);
}

/**
 * @param {number} ms
 * @returns {boolean} A job id can carry the slot.
 */
export function isSlotTime(ms) {
    return Number.isFinite(ms) && ms >= MIN_SLOT_MS && ms <= MAX_SLOT_MS;
}

/**
 * The `jobId` of a slot (the job id without its name): the scheduler and the `slot` enqueue option build the same one.
 * @param {string | null | undefined} key
 * @param {number} slotMs
 * @returns {string}
 */
export function slotJobIdOf(key, slotMs) {
    const time = new Date(slotMs).toISOString();

    return key ? `${SLOT_PREFIX}${key}:${time}` : `${SLOT_PREFIX}${time}`;
}

/**
 * Checks the options of `schedule()`.
 * @param {unknown} job A job definition or a name.
 * @param {unknown} options
 * @returns {ScheduleEntry} Without its definition and its next slot.
 */
export function checkSchedule(job, options) {
    const name = isPlainObject(job) ? job.name : job;
    const where = `schedule(${JSON.stringify(name)})`;
    const scope = { where, ErrorClass: ConfigError };

    if (typeof name !== 'string' || !JOB_NAME_REGEXP.test(name)) {
        throw new ConfigError(`${where}: the job must be a job definition or a job name`);
    }

    const given = checkObject(options, OPTION_NAMES, 'options', scope);
    const { key = null, missed = 'once', overlap = 'allow' } = given;

    if ((given.cron === undefined) === (given.every === undefined)) {
        throw new ConfigError(`${where}: "cron" or "every", exactly one`);
    }

    if (key !== null && !isSlotKey(key)) {
        throw new ConfigError(
            `${where}: "key" must have 1 to ${MAX_KEY_LENGTH} printable ASCII characters, without spaces at the ends`,
        );
    }

    if (missed !== 'once' && missed !== 'skip') {
        throw new ConfigError(`${where}: "missed" must be 'once' or 'skip'`);
    }

    if (overlap !== 'allow' && overlap !== 'skip') {
        throw new ConfigError(`${where}: "overlap" must be 'allow' or 'skip'`);
    }

    const timing = given.cron === undefined ? checkEvery(given, where) : checkCron(given, where);
    const jitterMs = given.jitter === undefined ? 0 : parseDuration(given.jitter);

    if (jitterMs === null || (given.jitter !== undefined && jitterMs < 1) || jitterMs > DAY_MS) {
        throw new ConfigError(`${where}: "jitter" must be a positive duration of at most '1d'`);
    }

    if (timing.kind === 'every' && jitterMs >= timing.ms) {
        throw new ConfigError(`${where}: "jitter" must be less than "every"`);
    }

    return {
        id: key === null ? name : `${name}:${key}`,
        name,
        key: /** @type {string | null} */ (key),
        timing,
        spec: timing.kind === 'cron' ? `cron ${timing.cron.normalized} ${timing.timeZone}` : `every ${timing.ms}`,
        payload: given.payload === undefined ? {} : given.payload,
        missed,
        overlap,
        definition: null,
        nextAt: null,
        retryDelayMs: 0,
        jitterMs,
        dueCache: null,
    };
}

/**
 * @param {Record<string, unknown>} given
 * @param {string} where
 * @returns {Timing}
 */
function checkCron(given, where) {
    const timeZone = given.timezone ?? 'UTC';

    if (typeof given.cron !== 'string') {
        throw new ConfigError(`${where}: "cron" must be a string`);
    }

    if (!isTimeZone(timeZone)) {
        throw new ConfigError(`${where}: "timezone" must be an IANA time zone, such as 'Europe/Berlin'`);
    }

    let cron;

    try {
        cron = parseCron(given.cron);
    } catch (error) {
        throw new ConfigError(`${where}: ${/** @type {Error} */ (error).message}`, { cause: error });
    }

    const timing = /** @type {const} */ ({ kind: 'cron', cron, timeZone: normalizeTimeZoneCase(/** @type {string} */ (timeZone)) });

    if (nextCronTime(cron, timing.timeZone, Date.now(), FIRES_WITHIN_MS) === null) {
        throw new ConfigError(`${where}: the cron ${JSON.stringify(given.cron)} never fires`);
    }

    return timing;
}

/**
 * @param {Record<string, unknown>} given
 * @param {string} where
 * @returns {Timing}
 */
function checkEvery(given, where) {
    if (given.timezone !== undefined) {
        throw new ConfigError(`${where}: "timezone" is only for "cron": "every" counts in UTC`);
    }

    const ms = parseDuration(given.every);

    if (ms === null || ms < SECOND_MS) {
        throw new ConfigError(`${where}: "every" must be a duration of at least '1s', got ${JSON.stringify(given.every)}`);
    }

    if (ms > DAY_MS) {
        throw new ConfigError(`${where}: "every" must be at most '1d': use cron, for example '0 0 * * 1' for weekly`);
    }

    if (ms > HOUR_MS && DAY_MS % ms !== 0) {
        throw new ConfigError(
            `${where}: "every" over 1 hour must divide 1 day ('2h', '3h', '4h', '6h', '8h', '12h', '1d'): use cron`,
        );
    }

    return { kind: 'every', ms };
}

/**
 * @param {ScheduleEntry} entry
 * @param {number} afterMs
 * @returns {number | null} The first slot after the instant. Null: none within the runtime horizon.
 */
export function nextSlot(entry, afterMs) {
    const { timing } = entry;

    if (timing.kind === 'every') {
        return (Math.floor(afterMs / timing.ms) + 1) * timing.ms;
    }

    return nextCronTime(timing.cron, timing.timeZone, afterMs);
}

/**
 * @param {ScheduleEntry} entry
 * @param {number} atMs
 * @returns {number | null} The last slot at or before the instant.
 */
export function latestSlot(entry, atMs) {
    const { timing } = entry;

    if (timing.kind === 'every') {
        return Math.floor(atMs / timing.ms) * timing.ms;
    }

    return latestCronTime(timing.cron, timing.timeZone, atMs);
}

/**
 * @param {ScheduleEntry} entry
 * @param {number} slotMs
 * @returns {number | null} The slot before a slot: the catch-up reach counts from it.
 */
export function previousSlot(entry, slotMs) {
    const { timing } = entry;

    if (timing.kind === 'every') {
        return slotMs - timing.ms;
    }

    return previousCronTime(timing.cron, timing.timeZone, slotMs);
}

/**
 * @param {ScheduleEntry} entry
 * @param {number} slotMs
 * @returns {string} The `jobId` of the slot: `schedule:[<key>:]<ISO>`.
 */
export function slotJobId(entry, slotMs) {
    return slotJobIdOf(entry.key, slotMs);
}

/**
 * The slot of a job, from its id. Only the scheduler and the `slot` enqueue option make such ids.
 * @param {string} jobId The id of a job: `<name>:<jobId>`, or a ULID.
 * @returns {Date | null} Null: not the job of a slot.
 */
export function scheduledAtOf(jobId) {
    // A guard before the regex: the other jobs pay one `includes`
    if (!jobId.includes(':schedule:')) {
        return null;
    }

    const match = SLOT_ID_REGEXP.exec(jobId);

    return match ? new Date(match[1]) : null;
}

/**
 * cyrb53: a public-domain 53-bit string hash, stable across Node.js versions (`Math.imul`).
 * @param {string} text
 * @returns {number} An integer in [0, 2^53).
 */
export function cyrb53(text) {
    let h1 = 0xDE_AD_BE_EF;
    let h2 = 0x41_C6_CE_57;

    for (let index = 0; index < text.length; index++) {
        const code = /** @type {number} */ (text.codePointAt(index));

        h1 = Math.imul(h1 ^ code, 2_654_435_761);
        h2 = Math.imul(h2 ^ code, 1_597_334_677);
    }

    h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);

    return (4_294_967_296 * (2_097_151 & h2)) + (h1 >>> 0);
}

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
export function jitterOffset(entry, slotMs, nextSlotMs) {
    const limit = nextSlotMs === null ? entry.jitterMs : Math.min(entry.jitterMs, nextSlotMs - slotMs);
    const unit = cyrb53(`${entry.id}|${slotMs}`) / (2 ** 53);

    if (limit >= SECOND_MS) {
        return Math.floor(unit * Math.floor(limit / SECOND_MS)) * SECOND_MS;
    }

    return Math.floor(unit * limit);
}

/**
 * @param {ScheduleEntry} entry
 * @param {number} slotMs
 * @returns {number} When the job of the slot is due: the slot plus its jitter. The slot itself without jitter.
 */
export function dueOf(entry, slotMs) {
    if (!entry.jitterMs) {
        return slotMs;
    }

    if (entry.dueCache?.slot !== slotMs) {
        const next = entry.timing.kind === 'every' ? slotMs + entry.timing.ms : nextSlot(entry, slotMs);

        entry.dueCache = { slot: slotMs, due: slotMs + jitterOffset(entry, slotMs, next) };
    }

    return entry.dueCache.due;
}

/**
 * With jitter, at start(): the latest slot whose due time has come, and the next slot to track: the first one whose
 * due time is ahead. It may be a slot before `atMs`.
 * @param {ScheduleEntry} entry
 * @param {number} atMs
 * @returns {{ latest: number | null, nextAt: number | null }}
 */
export function pendingSlots(entry, atMs) {
    const slot = latestSlot(entry, atMs);

    if (slot === null) {
        return { latest: null, nextAt: nextSlot(entry, atMs) };
    }

    if (dueOf(entry, slot) <= atMs) {
        return { latest: slot, nextAt: nextSlot(entry, slot) };
    }

    // Its slot has come, its due time has not: the slot before is due (due < next slot)
    return { latest: previousSlot(entry, slot), nextAt: slot };
}
