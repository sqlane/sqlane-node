// The shape of a rate limit and of its keys: the ranges and the checks. Apart from define_rate_limit.js, which throws
// the errors: errors.js checks the limit of a RateLimitedError with these, without an import cycle.
import { JOB_NAME_REGEXP } from './validate.js';

export const MAX_RATE = 1_000_000;
/** 7 d */
export const MAX_PER_MS = 604_800_000;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isRateMax(value) {
    return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_RATE;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isPerMs(value) {
    return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_PER_MS;
}

/**
 * @param {unknown} value A burst, or a cost.
 * @param {number} max The max of the limit, or its burst.
 * @returns {value is number}
 */
export function isUpTo(value, max) {
    return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max;
}

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').RateLimit} A limit as defineRateLimit() makes it: frozen, with a valid name,
 *     max, per and burst, its key() and cost(), and nothing else.
 */
export function isRateLimit(value) {
    if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) {
        return false;
    }

    const { name, max, per, burst, key, cost, ...rest } = /** @type {Record<string, unknown>} */ (value);

    return typeof name === 'string' && JOB_NAME_REGEXP.test(name) && isRateMax(max) && isPerMs(per)
        && max <= per * 1000 && isUpTo(burst, max) && typeof key === 'function' && typeof cost === 'function'
        && Object.keys(rest).length === 0;
}

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').RateLimitKey} A key as `limit.key()` or `limit.cost()` makes it.
 */
export function isRateLimitKey(value) {
    if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) {
        return false;
    }

    const { limit, key, cost, ...rest } = /** @type {Record<string, unknown>} */ (value);

    return isRateLimit(limit) && (typeof key === 'string' || key === null) && isUpTo(cost, limit.burst)
        && Object.keys(rest).length === 0;
}

/**
 * The stored key of a rate limit or of its key: `@<name>`, or `@<name>:<key>`. The `@` keeps it apart from the keys of
 * the concurrency limits, whose names start with a letter.
 * @param {import('./types.js').RateLimit | import('./types.js').RateLimitKey} entry Checked.
 * @returns {string}
 */
export function rateKeyOf(entry) {
    if ('limit' in entry) {
        return entry.key === null ? `@${entry.limit.name}` : `@${entry.limit.name}:${entry.key}`;
    }

    return `@${entry.name}`;
}

/**
 * A stored rate key, split: the name of its limit, and its key (null: the limit has none). Limit names have no `:`.
 * @param {string} stored `@<name>` or `@<name>:<key>`.
 * @returns {{ limit: string, key: string | null }}
 */
export function parseRateKey(stored) {
    const colon = stored.indexOf(':');

    return colon === -1
        ? { limit: stored.slice(1), key: null }
        : { limit: stored.slice(1, colon), key: stored.slice(colon + 1) };
}
