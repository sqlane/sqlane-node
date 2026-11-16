export type GlobalRateLimit = {
    key: string;
    max: number;
    per_us: number;
    burst: number;
    cost: number;
};
/**
 * A global rate limit of a job, as stored: `@<limit name>` or `@<limit name>:<key>`, the settings of its limit, `per`
 * in microseconds, and the starts that the job takes.
 * @typedef {{ key: string, max: number, per_us: number, burst: number, cost: number }} GlobalRateLimit
 */
/**
 * @param {string} key A key of a global limit, as stored.
 * @returns {boolean} A key of a rate limit (`@…`): the names of the concurrency limits start with a letter.
 */
export declare function isRateKey(key: string): boolean;
/**
 * Checks the global rate limits of a job.
 * @param {unknown} entries Limits, keys and costs of limits.
 * @param {string} where For the error message.
 * @param {number} concurrencyKeys The global concurrency keys of the job: the cap counts both.
 * @returns {GlobalRateLimit[]} Without duplicates, sorted by key (the lock order).
 */
export declare function normalizeGlobalRateLimits(entries: unknown, where: string, concurrencyKeys: number): GlobalRateLimit[];
