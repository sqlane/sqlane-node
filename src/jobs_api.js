// sqlane.jobs: the checks of the arguments and the cursors of the lists. The SQL is in store/job_reads.js.
import { inspect } from 'node:util';
import { InvalidOptionsError } from './errors.js';
import { checkObject, isPlainObject, JOB_NAME_REGEXP, PRINTABLE_ID_REGEXP } from './validate.js';

/** @typedef {import('./types.js').JobStatus} JobStatus */

/** @type {readonly JobStatus[]} The order in which a set of statuses is normalized */
const STATUSES = ['pending', 'blocked', 'running', 'completed', 'failed'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
/** The longest job id: ids of the database are varchar(255) */
const MAX_ID_LENGTH = 255;
/** The cursors of this major. A cursor of another version is malformed */
const CURSOR_VERSION = 1;
/**
 * The longest cursor. A valid one has at most about 790 characters: a name of 128, an id of 255 whose quotes and
 * backslashes JSON escapes, the statuses. A longer one is not decoded.
 */
const MAX_CURSOR_LENGTH = 1024;
/** base64url without padding: what `encodeCursor` writes. Buffer would decode much more, leniently */
const CURSOR_REGEXP = /^[A-Za-z0-9_-]+$/;
/** The last ms of the year 9999: a later time is not one of the database */
const MAX_TIME_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/**
 * @typedef {object} ListCursor The filter of a list and the last job of its page: the next page starts after it.
 * @property {string} jobName
 * @property {readonly JobStatus[] | null} statuses Sorted; null: every status.
 * @property {number} enqueuedAtMs
 * @property {string} id
 */

/**
 * @param {unknown} id
 * @returns {boolean} A string that can be the id of a job: printable ASCII, no space at the ends, at most 255
 *     characters. Other strings have no job, on every database.
 */
export function isPossibleJobId(id) {
    return typeof id === 'string' && id.length <= MAX_ID_LENGTH && PRINTABLE_ID_REGEXP.test(id);
}

/**
 * @param {ListCursor} cursor
 * @returns {string} Opaque: base64url of a JSON array. A later field of the filter goes at its end, only when it is
 *     not its default, so that older versions of the major read the cursors of the default filters.
 */
export function encodeCursor({ jobName, statuses, enqueuedAtMs, id }) {
    return Buffer.from(JSON.stringify([CURSOR_VERSION, jobName, statuses, enqueuedAtMs, id])).toString('base64url');
}

/**
 * @param {unknown} value
 * @returns {ListCursor}
 * @throws {InvalidOptionsError} The value is not a cursor of `list`.
 */
export function decodeCursor(value) {
    /** @type {unknown} */
    let parts = null;

    if (typeof value === 'string' && value.length <= MAX_CURSOR_LENGTH && CURSOR_REGEXP.test(value)) {
        const bytes = Buffer.from(value, 'base64url');

        // Canonical only: Buffer also decodes one more character, or unused bits set, to the same bytes
        if (bytes.toString('base64url') === value) {
            try {
                parts = JSON.parse(bytes.toString('utf8'));
            } catch {
                parts = null;
            }
        }
    }

    if (!Array.isArray(parts) || parts.length !== 5 || parts[0] !== CURSOR_VERSION
        || typeof parts[1] !== 'string' || !JOB_NAME_REGEXP.test(parts[1])
        || !(parts[2] === null || isStatusSet(parts[2]))
        || !Number.isSafeInteger(parts[3]) || parts[3] < 0 || parts[3] > MAX_TIME_MS
        || !isPossibleJobId(parts[4])) {
        throw new InvalidOptionsError('jobs.list: "cursor" must be the nextCursor of a list');
    }

    return { jobName: parts[1], statuses: parts[2], enqueuedAtMs: parts[3], id: parts[4] };
}

/**
 * @param {unknown} value
 * @returns {string} The value for an error message, whatever it is: JSON.stringify throws on a BigInt or a cycle.
 */
export function shown(value) {
    return inspect(value, { depth: 2, breakLength: Infinity });
}

/**
 * @param {unknown} value
 * @returns {value is JobStatus[]} A non-empty list of statuses, sorted as `STATUSES`, once each.
 */
function isStatusSet(value) {
    return Array.isArray(value) && value.length > 0
        && JSON.stringify(STATUSES.filter(status => value.includes(status))) === JSON.stringify(value);
}

/**
 * @param {unknown} status
 * @param {string} where The method, for the message.
 * @returns {readonly JobStatus[] | null} The set, sorted. Null: every status.
 */
export function statusesOf(status, where) {
    if (status === undefined) {
        return null;
    }

    const list = Array.isArray(status) ? status : [status];

    if (!list.length || list.some(item => !STATUSES.includes(/** @type {JobStatus} */ (item)))
        || new Set(list).size !== list.length) {
        throw new InvalidOptionsError(`${where}: "status" must be a status or a non-empty list of statuses without `
            + `duplicates, of ${STATUSES.join(', ')}; got ${shown(status)}`);
    }

    return STATUSES.filter(item => list.includes(item));
}

/**
 * @param {import('./store/store.js').Store} store
 * @param {(operation: 'retry' | 'cancel' | 'remove', selector: unknown, options: unknown)
 *     => Promise<import('./types.js').BulkResult>} bulk The bulk methods (jobs_bulk.js).
 * @returns {import('./sqlane.js').SqlaneJobs}
 */
export function createJobsApi(store, bulk) {
    const scope = { where: 'jobs.list', ErrorClass: InvalidOptionsError };

    return Object.freeze({
        get: async (/** @type {string} */ jobId) => {
            if (typeof jobId !== 'string') {
                throw new InvalidOptionsError(`jobs.get: "jobId" must be a string, got ${typeof jobId}`);
            }

            if (!isPossibleJobId(jobId)) {
                return null;
            }

            // The caller names the type of the payload: the database has JSON
            return /** @type {any} */ (await store.getJob(jobId));
        },
        list: async (
            /** @type {import('./types.js').JobFilter} */ filter,
            /** @type {import('./types.js').ListJobsOptions | undefined} */ options = {},
        ) => {
            const { jobName: job, status } = checkObject(filter, ['jobName', 'status'], 'filter', scope);
            const { limit = DEFAULT_LIMIT, cursor, includePayload = false } = checkObject(
                options,
                ['limit', 'cursor', 'includePayload'],
                'options',
                scope,
            );
            const jobName = isPlainObject(job) ? job.name : job;

            if (typeof jobName !== 'string' || !JOB_NAME_REGEXP.test(jobName)) {
                throw new InvalidOptionsError(`jobs.list: "jobName" must be a job definition or a name matching ${
                    JOB_NAME_REGEXP}`);
            }

            const statuses = statusesOf(status, 'jobs.list');

            if (!Number.isSafeInteger(limit) || /** @type {number} */ (limit) < 1
                || /** @type {number} */ (limit) > MAX_LIMIT) {
                throw new InvalidOptionsError(
                    `jobs.list: "limit" must be an integer from 1 to ${MAX_LIMIT}, got ${shown(limit)}`,
                );
            }

            if (typeof includePayload !== 'boolean') {
                throw new InvalidOptionsError('jobs.list: "includePayload" must be a boolean');
            }

            const after = cursor === undefined || cursor === null ? null : decodeCursor(cursor);

            if (after && (after.jobName !== jobName || JSON.stringify(after.statuses) !== JSON.stringify(statuses))) {
                throw new InvalidOptionsError('jobs.list: "cursor" is the cursor of a list with another filter');
            }

            const { jobs, last } = await store.listJobs({
                jobName,
                statuses,
                limit: /** @type {number} */ (limit),
                after: after && { enqueuedAtMs: after.enqueuedAtMs, id: after.id },
                includePayload,
            });

            return {
                jobs: /** @type {any[]} */ (jobs),
                nextCursor: last && encodeCursor({ jobName, statuses, ...last }),
            };
        },
        retry: (/** @type {unknown} */ selector, /** @type {unknown} */ options) => bulk('retry', selector, options),
        cancel: (/** @type {unknown} */ selector, /** @type {unknown} */ options) => bulk('cancel', selector, options),
        remove: (/** @type {unknown} */ selector, /** @type {unknown} */ options) => bulk('remove', selector, options),
    });
}
