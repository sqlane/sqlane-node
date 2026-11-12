import { createMonotonicUlid } from './ulid.js';
import { parseDuration } from './duration.js';
import { InvalidOptionsError } from './errors.js';
import { normalizeMutexKeys } from './mutex_keys.js';
import { serializePayload } from './payload.js';
import { isSlotKey, isSlotTime, MAX_KEY_LENGTH, SLOT_PREFIX, slotJobIdOf } from './schedule.js';
import {
    checkFailureJob,
    checkJobFields,
    checkObject,
    JOB_NAME_REGEXP,
    PRINTABLE_ID_REGEXP,
} from './validate.js';

const ENQUEUE_OPTION_NAMES = [
    'jobId', 'delay', 'runAt', 'maxAttempts', 'maxStalls', 'retention', 'failureJob', 'mutexKeys', 'slot',
];
const MAX_JOB_ID_LENGTH = 120;
/** Sorted by creation order in this process, also within one millisecond */
const ulid = createMonotonicUlid();

/**
 * A job to insert, with every value frozen at enqueue.
 * @typedef {object} NewJob
 * @property {string} id `<name>:<jobId>`, or a ULID.
 * @property {boolean} hasJobId
 * @property {string} name
 * @property {string} payloadJson
 * @property {readonly string[]} mutexKeys Sorted, without duplicates.
 * @property {number} maxAttempts
 * @property {number} maxStalls
 * @property {number} completedRetentionMs
 * @property {number} failedRetentionMs
 * @property {string | null} failureJob
 * @property {number} delayMs From the DB clock at insert. 0 with `runAt`.
 * @property {Date | null} runAt
 */

/**
 * @typedef {object} NewJobParams
 * @property {string} name
 * @property {import('./types.js').JobDefinition | null} definition Null: an unknown name, the defaults only.
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {unknown} payload
 * @property {import('./types.js').EnqueueOptions | undefined} options
 * @property {number} maxPayloadBytes
 */

/**
 * @param {unknown} jobId
 * @param {string} where
 */
function checkJobId(jobId, where) {
    if (typeof jobId !== 'string' || jobId.length > MAX_JOB_ID_LENGTH || !PRINTABLE_ID_REGEXP.test(jobId)) {
        throw new InvalidOptionsError(
            `${where}: "jobId" must have 1 to ${MAX_JOB_ID_LENGTH} printable ASCII characters, without spaces at the `
            + `ends: ${JSON.stringify(jobId)}`,
        );
    }

    if (jobId.startsWith(SLOT_PREFIX)) {
        throw new InvalidOptionsError(
            `${where}: the "jobId" prefix "${SLOT_PREFIX}" is reserved for the slots of schedules: use the option "slot"`,
        );
    }
}

/**
 * @param {unknown} slot
 * @param {string} where
 * @returns {string} The `jobId` of the slot.
 */
function slotJobIdFrom(slot, where) {
    const { at, key } = checkObject(slot, ['at', 'key'], '"slot"', { where, ErrorClass: InvalidOptionsError });

    if (!(at instanceof Date) || !isSlotTime(at.getTime())) {
        throw new InvalidOptionsError(`${where}: "slot.at" must be a valid Date in the years 1970 to 9999`);
    }

    if (key !== undefined && !isSlotKey(key)) {
        throw new InvalidOptionsError(
            `${where}: "slot.key" must have 1 to ${MAX_KEY_LENGTH} printable ASCII characters, without spaces at the ends`,
        );
    }

    return slotJobIdOf(/** @type {string | undefined} */ (key), at.getTime());
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
export function buildNewJob({ name, definition, defaults, payload, options = {}, maxPayloadBytes }) {
    const where = `enqueue(${JSON.stringify(name)})`;

    if (typeof name !== 'string' || !JOB_NAME_REGEXP.test(name)) {
        throw new InvalidOptionsError(`${where}: the job name must match ${JOB_NAME_REGEXP}`);
    }

    const scope = { where, ErrorClass: InvalidOptionsError };

    checkObject(options, ENQUEUE_OPTION_NAMES, 'options', scope);
    checkJobFields(options, scope);

    let { jobId } = options;

    if (jobId !== undefined) {
        checkJobId(jobId, where);
    }

    if (options.slot !== undefined) {
        if (jobId !== undefined) {
            throw new InvalidOptionsError(`${where}: "slot" or "jobId", not both`);
        }

        jobId = slotJobIdFrom(options.slot, where);
    }

    const failureJob = options.failureJob ?? definition?.failureJob;
    const payloadJson = serializePayload(payload, maxPayloadBytes, where);
    // The keys come from the payload as the handler gets it: as JSON gives it back.
    const rawKeys = options.mutexKeys ?? definition?.mutexKeys?.(JSON.parse(payloadJson)) ?? [];
    const retention = { ...definition?.retention, ...options.retention };

    return {
        id: jobId === undefined ? ulid() : `${name}:${jobId}`,
        hasJobId: jobId !== undefined,
        name,
        payloadJson,
        mutexKeys: normalizeMutexKeys(rawKeys, where),
        maxAttempts: options.maxAttempts ?? definition?.maxAttempts ?? defaults.maxAttempts,
        maxStalls: options.maxStalls ?? definition?.maxStalls ?? defaults.maxStalls,
        completedRetentionMs: parseDuration(retention.completed) ?? defaults.retention.completedMs,
        failedRetentionMs: parseDuration(retention.failed) ?? defaults.retention.failedMs,
        failureJob: failureJob === undefined ? null : checkFailureJob(failureJob, name, scope),
        ...getSchedule(options, where),
    };
}
