export declare const MAX_MUTEX_KEYS = 10;
export declare const MAX_MUTEX_KEY_LENGTH = 255;
/**
 * Checks the mutex keys of a job.
 * @param {unknown} keys
 * @param {string} where For the error message.
 * @returns {string[]} The keys without duplicates, sorted (the lock order).
 */
export declare function normalizeMutexKeys(keys: unknown, where: string): string[];
