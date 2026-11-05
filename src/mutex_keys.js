import { InvalidMutexKeyError } from './errors.js';
import { PRINTABLE_ID_REGEXP } from './validate.js';

export const MAX_MUTEX_KEYS = 10;
export const MAX_MUTEX_KEY_LENGTH = 255;

/**
 * Checks the mutex keys of a job.
 * @param {unknown} keys
 * @param {string} where For the error message.
 * @returns {string[]} The keys without duplicates, sorted (the lock order).
 */
export function normalizeMutexKeys(keys, where) {
    if (!Array.isArray(keys)) {
        throw new InvalidMutexKeyError(`${where}: the mutex keys must be an array`);
    }

    for (const key of keys) {
        if (typeof key !== 'string' || key.length > MAX_MUTEX_KEY_LENGTH || !PRINTABLE_ID_REGEXP.test(key)) {
            throw new InvalidMutexKeyError(
                `${where}: a mutex key has 1 to ${MAX_MUTEX_KEY_LENGTH} printable ASCII characters, without spaces at `
                + `the ends: ${JSON.stringify(key)}`,
            );
        }
    }

    const unique = [...new Set(/** @type {string[]} */ (keys))].toSorted();

    if (unique.length > MAX_MUTEX_KEYS) {
        throw new InvalidMutexKeyError(`${where}: at most ${MAX_MUTEX_KEYS} mutex keys, got ${unique.length}`);
    }

    return unique;
}
