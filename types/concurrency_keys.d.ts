export declare const MAX_GLOBAL_LIMITS = 10;
export declare const MAX_LIMIT_KEY_LENGTH = 255;
export type GlobalLimit = {
    key: string;
    max: number;
};
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
export declare function normalizeGlobalLimits(entries: unknown, where: string): GlobalLimit[];
