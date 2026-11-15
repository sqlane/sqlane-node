// The global concurrency limits of a job: frozen at enqueue, as `{ key, max }` sorted by key.
import { isConcurrencyLimit, isConcurrencyLimitKey } from './define_concurrency_limit.js';
import { InvalidConcurrencyLimitError } from './errors.js';
import { PRINTABLE_ID_REGEXP } from './validate.js';

export const MAX_GLOBAL_LIMITS = 10;
export const MAX_LIMIT_KEY_LENGTH = 255;

/**
 * A global limit of a job: `<limit name>`, or `<limit name>:<key>`, and the max of its limit.
 * @typedef {{ key: string, max: number }} GlobalLimit
 */

/**
 * Checks the global limits of a job.
 * @param {unknown} entries Limits and keys of limits.
 * @param {string} where For the error message.
 * @returns {GlobalLimit[]} Without duplicates, sorted by key (the lock order).
 */
export function normalizeGlobalLimits(entries, where) {
    if (!Array.isArray(entries)) {
        throw new InvalidConcurrencyLimitError(
            `${where}: the global concurrency limits must be an array of limits and keys from defineConcurrencyLimit()`,
        );
    }

    /** @type {Map<string, number>} */
    const maxByKey = new Map();

    for (const entry of entries) {
        let key;
        let max;

        if (isConcurrencyLimit(entry)) {
            key = entry.name;
            max = entry.max;
        } else if (isConcurrencyLimitKey(entry)) {
            key = `${entry.limit.name}:${entry.key}`;
            max = entry.limit.max;

            if (key.length > MAX_LIMIT_KEY_LENGTH || !PRINTABLE_ID_REGEXP.test(entry.key)) {
                throw new InvalidConcurrencyLimitError(
                    `${where}: a key of a limit has printable ASCII characters, without spaces at the ends, and with `
                    + `the limit name at most ${MAX_LIMIT_KEY_LENGTH}: ${JSON.stringify(key)}`,
                );
            }
        } else {
            throw new InvalidConcurrencyLimitError(
                `${where}: a global concurrency limit must be a limit from defineConcurrencyLimit() or its key()`,
            );
        }

        const known = maxByKey.get(key);

        if (known !== undefined && known !== max) {
            throw new InvalidConcurrencyLimitError(
                `${where}: the key ${JSON.stringify(key)} has two maxes: ${known} and ${max}`,
            );
        }

        maxByKey.set(key, max);
    }

    if (maxByKey.size > MAX_GLOBAL_LIMITS) {
        throw new InvalidConcurrencyLimitError(
            `${where}: at most ${MAX_GLOBAL_LIMITS} global concurrency limits, got ${maxByKey.size}`,
        );
    }

    return [...maxByKey].toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([key, max]) => ({ key, max }));
}
