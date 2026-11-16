// The global rate limits of a job: frozen at enqueue, as `{ key, max, per_us, burst, cost }` sorted by key.
import { MAX_GLOBAL_LIMITS, MAX_LIMIT_KEY_LENGTH } from './concurrency_keys.js';
import { InvalidRateLimitError } from './errors.js';
import { isRateLimit, isRateLimitKey, rateKeyOf } from './rate_limit_shape.js';
import { PRINTABLE_ID_REGEXP } from './validate.js';

/**
 * A global rate limit of a job, as stored: `@<limit name>` or `@<limit name>:<key>`, the settings of its limit, `per`
 * in microseconds, and the starts that the job takes.
 * @typedef {{ key: string, max: number, per_us: number, burst: number, cost: number }} GlobalRateLimit
 */

/**
 * @param {string} key A key of a global limit, as stored.
 * @returns {boolean} A key of a rate limit (`@…`): the names of the concurrency limits start with a letter.
 */
export function isRateKey(key) {
    return key.startsWith('@');
}

/**
 * Checks the global rate limits of a job.
 * @param {unknown} entries Limits, keys and costs of limits.
 * @param {string} where For the error message.
 * @param {number} concurrencyKeys The global concurrency keys of the job: the cap counts both.
 * @returns {GlobalRateLimit[]} Without duplicates, sorted by key (the lock order).
 */
export function normalizeGlobalRateLimits(entries, where, concurrencyKeys) {
    if (!Array.isArray(entries)) {
        throw new InvalidRateLimitError(
            `${where}: the global rate limits must be an array of limits, keys and costs from defineRateLimit()`,
        );
    }

    /** @type {Map<string, GlobalRateLimit>} */
    const byKey = new Map();

    for (const entry of entries) {
        if (!isRateLimit(entry) && !isRateLimitKey(entry)) {
            throw new InvalidRateLimitError(
                `${where}: a global rate limit must be a limit from defineRateLimit(), its key() or its cost()`,
            );
        }

        const key = rateKeyOf(entry);
        const { limit, cost } = 'limit' in entry ? entry : { limit: entry, cost: 1 };

        if ('limit' in entry && entry.key !== null
            && (key.length > MAX_LIMIT_KEY_LENGTH || !PRINTABLE_ID_REGEXP.test(entry.key))) {
            throw new InvalidRateLimitError(
                `${where}: a key of a limit has printable ASCII characters, without spaces at the ends, and with `
                + `"@" and the limit name at most ${MAX_LIMIT_KEY_LENGTH}: ${JSON.stringify(key)}`,
            );
        }

        /** @type {GlobalRateLimit} */
        const rateLimit = { key, max: limit.max, per_us: limit.per * 1000, burst: limit.burst, cost };
        const known = byKey.get(key);

        if (known && (known.max !== rateLimit.max || known.per_us !== rateLimit.per_us
            || known.burst !== rateLimit.burst || known.cost !== rateLimit.cost)) {
            throw new InvalidRateLimitError(
                `${where}: the key ${JSON.stringify(key)} has two settings: ${describe(known)} and ${describe(rateLimit)}`,
            );
        }

        byKey.set(key, rateLimit);
    }

    if (concurrencyKeys + byKey.size > MAX_GLOBAL_LIMITS) {
        throw new InvalidRateLimitError(`${where}: at most ${MAX_GLOBAL_LIMITS} global keys, concurrency and rate `
            + `limits together, got ${concurrencyKeys + byKey.size}`);
    }

    return [...byKey.values()].toSorted((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * @param {GlobalRateLimit} rateLimit
 * @returns {string}
 */
function describe({ max, per_us: perUs, burst, cost }) {
    return `max ${max} per ${perUs / 1000} ms, burst ${burst}, cost ${cost}`;
}
