import { parseDuration } from './duration.js';
import { InvalidOptionsError } from './errors.js';
import { normalizeMutexKeys } from './mutex_keys.js';
import { serializePayload } from './payload.js';
import { ulid } from './ulid.js';
import {
    checkFailureJob,
    checkJobFields,
    checkObject,
    JOB_NAME_REGEXP,
    PRINTABLE_ID_REGEXP,
} from './validate.js';

const ENQUEUE_OPTION_NAMES = [
    'jobId', 'delay', 'runAt', 'maxAttempts', 'maxStalls', 'retention', 'failureJob', 'mutexKeys',
];
const MAX_JOB_ID_LENGTH = 120;

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

    if (options.jobId !== undefined) {
        checkJobId(options.jobId, where);
    }

    const failureJob = options.failureJob ?? definition?.failureJob;
    const payloadJson = serializePayload(payload, maxPayloadBytes, where);
    // The keys come from the payload as the handler gets it: as JSON gives it back.
    const rawKeys = options.mutexKeys ?? definition?.mutexKeys?.(JSON.parse(payloadJson)) ?? [];
    const retention = { ...definition?.retention, ...options.retention };

    return {
        id: options.jobId === undefined ? ulid() : `${name}:${options.jobId}`,
        hasJobId: options.jobId !== undefined,
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
