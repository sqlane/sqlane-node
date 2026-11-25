import { createMonotonicUlid } from './ulid.js';
import { parseDuration } from './duration.js';
import { InvalidOptionsError } from './errors.js';
import { MAX_LIMIT_KEY_LENGTH, normalizeGlobalLimits } from './concurrency_keys.js';
import { normalizeGlobalRateLimits } from './rate_keys.js';
import { serializePayload } from './payload.js';
import { SLOT_PREFIX, slotDedupeKeyOf } from './schedule.js';
import {
    checkOptionFields,
    checkObject,
    NAME_REGEXP,
    PRINTABLE_ID_REGEXP,
} from './validate.js';

const ENQUEUE_OPTION_NAMES = [
    'dedupeKey', 'delay', 'runAt', 'maxAttempts', 'maxStalls', 'retention', 'globalConcurrencyLimits', 'globalRateLimits',
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
 * @property {number} delayMs From the DB clock at insert. 0 with `runAt`.
 * @property {Date | null} runAt
 * @property {string | null} fairGroup Its fair group, from the definition's `fairGroup`; null: none.
 */

/**
 * @typedef {object} NewJobParams
 * @property {string} lane
 * @property {import('./types.js').LaneDefinition} definition Its options: over the defaults.
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {unknown} payload
 * @property {import('./types.js').EnqueueOptions | undefined} options
 * @property {number} maxPayloadBytes
 * @property {{ at: number, key: string }} [slot] The slot of a schedule: the job gets its dedupe key, which an
 *     enqueue cannot give (its prefix is reserved). For the scheduler and `schedules.runSlot()`.
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
            + 'of schedules: run a slot by hand with schedules.runSlot()');
    }
}

/**
 * The fair group of a job, from the definition's function: the rule of a limit key.
 * @param {import('./types.js').LaneDefinition} definition
 * @param {() => { payload: unknown }} contextOf The context of the definition's functions.
 * @param {Record<string, unknown>} options
 * @param {string} where
 * @returns {string | null} Null: no group.
 */
function fairGroupOf(definition, contextOf, options, where) {
    if (!definition.fairGroup) {
        return null;
    }

    for (const name of /** @type {const} */ (['globalConcurrencyLimits', 'globalRateLimits'])) {
        const limits = options[name];

        if (limits !== undefined && !(Array.isArray(limits) && limits.length === 0)) {
            throw new InvalidOptionsError(`${where}: "${name}" does not combine with the "fairGroup" of the lane: `
                + 'only [] is allowed');
        }
    }

    // From the payload as the handler gets it: as JSON gives it back. A throw propagates
    const group = definition.fairGroup(contextOf());

    if (group === null || group === undefined) {
        return null;
    }

    if (typeof group !== 'string' || group.length > MAX_LIMIT_KEY_LENGTH || !PRINTABLE_ID_REGEXP.test(group)) {
        throw new InvalidOptionsError(`${where}: a fair group has 1 to ${MAX_LIMIT_KEY_LENGTH} printable ASCII `
            + `characters, without spaces at the ends: ${JSON.stringify(group)}`);
    }

    return group;
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
export function buildNewJob({ lane, definition, defaults, payload, options = {}, maxPayloadBytes, slot }) {
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

    if (slot) {
        dedupeKey = slotDedupeKeyOf(slot.key, slot.at);
    }

    const payloadJson = serializePayload(payload, maxPayloadBytes, where);
    /** @type {{ payload: unknown } | null} The payload as the handler gets it, as JSON gives it back: parsed once */
    let context = null;
    const contextOf = () => (context ??= { payload: JSON.parse(payloadJson) });
    const fairGroup = fairGroupOf(definition, contextOf, options, where);
    const rawLimits = options.globalConcurrencyLimits ?? definition.globalConcurrencyLimits?.(contextOf()) ?? [];
    const rawRateLimits = options.globalRateLimits ?? definition.globalRateLimits?.(contextOf()) ?? [];
    const limits = normalizeGlobalLimits(rawLimits, where);
    const retention = { ...definition.retention, ...options.retention };

    return {
        id: dedupeKey === undefined ? ulid() : `${lane}:${dedupeKey}`,
        hasJobId: dedupeKey !== undefined,
        lane,
        payloadJson,
        limits,
        rateLimits: normalizeGlobalRateLimits(rawRateLimits, where, limits.length),
        maxAttempts: options.maxAttempts ?? definition.maxAttempts ?? defaults.maxAttempts,
        maxStalls: options.maxStalls ?? definition.maxStalls ?? defaults.maxStalls,
        completedRetentionMs: parseDuration(retention.completed) ?? defaults.retention.completedMs,
        failedRetentionMs: parseDuration(retention.failed) ?? defaults.retention.failedMs,
        ...getSchedule(options, where),
        fairGroup,
    };
}

/**
 * A job that a runner adds itself (a failure job, the slot of a schedule), on a schema without `0011_fair_groups`: no
 * group, so its insert does not write the missing column.
 * @param {boolean} ready The schema has `0011_fair_groups`.
 * @param {NewJob} job
 * @returns {NewJob}
 */
export function withoutGroupUnless(ready, job) {
    return ready || job.fairGroup === null ? job : { ...job, fairGroup: null };
}
