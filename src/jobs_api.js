// sqlane.jobs: the checks of the arguments and the cursors of the lists. The SQL is in store/job_reads.js.
import { inspect } from 'node:util';
import { InvalidOptionsError } from './errors.js';
import { checkedLaneName } from './lane_names.js';
import { checkObject, NAME_REGEXP, PRINTABLE_ID_REGEXP } from './validate.js';

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
 * @property {string} lane
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
export function encodeCursor({ lane, statuses, enqueuedAtMs, id }) {
    return Buffer.from(JSON.stringify([CURSOR_VERSION, lane, statuses, enqueuedAtMs, id])).toString('base64url');
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
        || typeof parts[1] !== 'string' || !NAME_REGEXP.test(parts[1])
        || !(parts[2] === null || isStatusSet(parts[2]))
        || !Number.isSafeInteger(parts[3]) || parts[3] < 0 || parts[3] > MAX_TIME_MS
        || !isPossibleJobId(parts[4])) {
        throw new InvalidOptionsError('jobs.list: "cursor" must be the nextCursor of a list');
    }

    return { lane: parts[1], statuses: parts[2], enqueuedAtMs: parts[3], id: parts[4] };
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
            const { lane: given, status } = checkObject(filter, ['lane', 'status'], 'filter', scope);
            const { limit = DEFAULT_LIMIT, cursor, includePayload = false } = checkObject(
                options,
                ['limit', 'cursor', 'includePayload'],
                'options',
                scope,
            );
            const lane = checkedLaneName(given, 'jobs.list', '"lane"');

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

            if (after && (after.lane !== lane || JSON.stringify(after.statuses) !== JSON.stringify(statuses))) {
                throw new InvalidOptionsError('jobs.list: "cursor" is the cursor of a list with another filter');
            }

            const { jobs, last } = await store.listJobs({
                lane,
                statuses,
                limit: /** @type {number} */ (limit),
                after: after && { enqueuedAtMs: after.enqueuedAtMs, id: after.id },
                includePayload,
            });

            return {
                jobs: /** @type {any[]} */ (jobs),
                nextCursor: last && encodeCursor({ lane, statuses, ...last }),
            };
        },
        keyStats: async (/** @type {import('./types.js').KeyStatsOptions | undefined} */ options = {}) => {
            const where = 'jobs.keyStats';
            const { limit = DEFAULT_LIMIT, type, orderBy = 'blocked' } = checkObject(
                options,
                ['limit', 'type', 'orderBy'],
                'options',
                { where, ErrorClass: InvalidOptionsError },
            );

            if (!Number.isSafeInteger(limit) || /** @type {number} */ (limit) < 1
                || /** @type {number} */ (limit) > MAX_LIMIT) {
                throw new InvalidOptionsError(`${where}: "limit" must be an integer from 1 to ${MAX_LIMIT}, got ${
                    shown(limit)}`);
            }

            if (type !== undefined && type !== 'concurrency' && type !== 'rate') {
                throw new InvalidOptionsError(`${where}: "type" must be 'concurrency' or 'rate', got ${shown(type)}`);
            }

            if (orderBy !== 'blocked' && orderBy !== 'held') {
                throw new InvalidOptionsError(`${where}: "orderBy" must be 'blocked' or 'held', got ${shown(orderBy)}`);
            }

            if (type === 'rate' && orderBy === 'held') {
                throw new InvalidOptionsError(`${where}: rate keys hold no slot: "orderBy: 'held'" needs another type`);
            }

            return store.keyStats({ limit: /** @type {number} */ (limit), type: type ?? null, orderBy });
        },
        retry: (/** @type {unknown} */ selector, /** @type {unknown} */ options) => bulk('retry', selector, options),
        cancel: (/** @type {unknown} */ selector, /** @type {unknown} */ options) => bulk('cancel', selector, options),
        remove: (/** @type {unknown} */ selector, /** @type {unknown} */ options) => bulk('remove', selector, options),
    });
}
