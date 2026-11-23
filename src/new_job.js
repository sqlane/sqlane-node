import { createMonotonicUlid } from './ulid.js';
import { parseDuration } from './duration.js';
import { InvalidOptionsError } from './errors.js';
import { normalizeGlobalLimits } from './concurrency_keys.js';
import { normalizeGlobalRateLimits } from './rate_keys.js';
import { serializePayload } from './payload.js';
import { isSlotKey, isSlotTime, MAX_KEY_LENGTH, SLOT_PREFIX, slotDedupeKeyOf } from './schedule.js';
import {
    checkFailureLane,
    checkOptionFields,
    checkObject,
    NAME_REGEXP,
    PRINTABLE_ID_REGEXP,
} from './validate.js';

const ENQUEUE_OPTION_NAMES = [
    'dedupeKey', 'delay', 'runAt', 'maxAttempts', 'maxStalls', 'retention', 'globalConcurrencyLimits', 'globalRateLimits',
    'slot',
];
const MAX_DEDUPE_KEY_LENGTH = 120;
/** Sorted by creation order in this process, also within one millisecond */
const ulid = createMonotonicUlid();

/**
 * A job to insert, with every value frozen at enqueue.
 * @typedef {object} NewJob
 * @property {string} id `<lane>:<dedupeKey>`, or a ULID.
 * @property {boolean} hasJobId
 * @property {string} lane
 * @property {string} payloadJson
 * @property {readonly import('./concurrency_keys.js').GlobalLimit[]} limits Its global limits: sorted by key, without
 *     duplicates.
 * @property {readonly import('./rate_keys.js').GlobalRateLimit[]} rateLimits Its global rate limits: sorted by key,
 *     without duplicates. At most 10 keys with `limits`.
 * @property {number} maxAttempts
 * @property {number} maxStalls
 * @property {number} completedRetentionMs
 * @property {number} failedRetentionMs
 * @property {string | null} failureLane
 * @property {number} delayMs From the DB clock at insert. 0 with `runAt`.
 * @property {Date | null} runAt
 */

/**
 * @typedef {object} NewJobParams
 * @property {string} lane
 * @property {import('./types.js').LaneDefinition | null} definition Null: an unknown name, the defaults only.
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {unknown} payload
 * @property {import('./types.js').EnqueueOptions | undefined} options
 * @property {number} maxPayloadBytes
 */

/**
 * @param {unknown} dedupeKey
 * @param {string} where
 */
function checkDedupeKey(dedupeKey, where) {
    if (typeof dedupeKey !== 'string' || dedupeKey.length > MAX_DEDUPE_KEY_LENGTH
        || !PRINTABLE_ID_REGEXP.test(dedupeKey)) {
        throw new InvalidOptionsError(
            `${where}: "dedupeKey" must have 1 to ${MAX_DEDUPE_KEY_LENGTH} printable ASCII characters, without spaces `
            + `at the ends: ${JSON.stringify(dedupeKey)}`,
        );
    }

    if (dedupeKey.startsWith(SLOT_PREFIX)) {
        throw new InvalidOptionsError(`${where}: the "dedupeKey" prefix "${SLOT_PREFIX}" is reserved for the slots `
            + 'of schedules: use the option "slot"');
    }
}

/**
 * @param {unknown} slot
 * @param {string} where
 * @returns {string} The dedupe key of the slot.
 */
function slotDedupeKeyFrom(slot, where) {
    const { at, key } = checkObject(slot, ['at', 'key'], '"slot"', { where, ErrorClass: InvalidOptionsError });

    if (!(at instanceof Date) || !isSlotTime(at.getTime())) {
        throw new InvalidOptionsError(`${where}: "slot.at" must be a valid Date in the years 1970 to 9999`);
    }

    if (key !== undefined && !isSlotKey(key)) {
        throw new InvalidOptionsError(
            `${where}: "slot.key" must have 1 to ${MAX_KEY_LENGTH} printable ASCII characters, without spaces at the ends`,
        );
    }

    return slotDedupeKeyOf(/** @type {string | undefined} */ (key), at.getTime());
}

/**
 * @param {Record<string, unknown>} options
 * @param {string} where
 * @returns {{ delayMs: number, runAt: Date | null }}
 */
function getSchedule(options, where) {
    if (options.delay !== undefined && options.runAt !== undefined) {
        throw new InvalidOptionsError(`${where}: "delay" or "runAt", not both`);
    }

    if (options.runAt !== undefined) {
        if (!(options.runAt instanceof Date) || Number.isNaN(options.runAt.getTime())) {
            throw new InvalidOptionsError(`${where}: "runAt" must be a valid Date`);
        }

        return { delayMs: 0, runAt: options.runAt };
    }

    const delayMs = options.delay === undefined ? 0 : parseDuration(options.delay);

    if (delayMs === null) {
        throw new InvalidOptionsError(`${where}: "delay" must be a duration, got ${JSON.stringify(options.delay)}`);
    }

    return { delayMs, runAt: null };
}

/**
 * Checks an enqueue and computes the job to insert: options, then the definition, then the defaults.
 * @param {NewJobParams} params
 * @returns {NewJob}
 */
export function buildNewJob({ lane, definition, defaults, payload, options = {}, maxPayloadBytes }) {
    const where = `enqueue(${JSON.stringify(lane)})`;

    if (typeof lane !== 'string' || !NAME_REGEXP.test(lane)) {
        throw new InvalidOptionsError(`${where}: the lane name must match ${NAME_REGEXP}`);
    }

    const scope = { where, ErrorClass: InvalidOptionsError };

    checkObject(options, ENQUEUE_OPTION_NAMES, 'options', scope);
    checkOptionFields(options, scope);

    let { dedupeKey } = options;

    if (dedupeKey !== undefined) {
        checkDedupeKey(dedupeKey, where);
    }

    if (options.slot !== undefined) {
        if (dedupeKey !== undefined) {
            throw new InvalidOptionsError(`${where}: "slot" or "dedupeKey", not both`);
        }

        dedupeKey = slotDedupeKeyFrom(options.slot, where);
    }

    // For display (JobRecord.failureLane): the process that fails the job decides, by its definition
    const failureLane = definition?.failureLane;
    const payloadJson = serializePayload(payload, maxPayloadBytes, where);
    // The limits come from the payload as the handler gets it: as JSON gives it back.
    const rawLimits = options.globalConcurrencyLimits
        ?? definition?.globalConcurrencyLimits?.({ payload: JSON.parse(payloadJson) }) ?? [];
    const rawRateLimits = options.globalRateLimits
        ?? definition?.globalRateLimits?.({ payload: JSON.parse(payloadJson) }) ?? [];
    const limits = normalizeGlobalLimits(rawLimits, where);
    const retention = { ...definition?.retention, ...options.retention };

    return {
        id: dedupeKey === undefined ? ulid() : `${lane}:${dedupeKey}`,
        hasJobId: dedupeKey !== undefined,
        lane,
        payloadJson,
        limits,
        rateLimits: normalizeGlobalRateLimits(rawRateLimits, where, limits.length),
        maxAttempts: options.maxAttempts ?? definition?.maxAttempts ?? defaults.maxAttempts,
        maxStalls: options.maxStalls ?? definition?.maxStalls ?? defaults.maxStalls,
        completedRetentionMs: parseDuration(retention.completed) ?? defaults.retention.completedMs,
        failedRetentionMs: parseDuration(retention.failed) ?? defaults.retention.failedMs,
        failureLane: failureLane === undefined ? null : checkFailureLane(failureLane, lane, scope),
        ...getSchedule(options, where),
    };
}
