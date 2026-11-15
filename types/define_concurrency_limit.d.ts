export declare const MAX_LIMIT = 1000;
/**
 * Defines a concurrency limit: the most jobs that hold it at once. A job definition lists it in
 * `localConcurrencyLimits`, where each instance counts its own jobs, or returns it, or one of its keys, from
 * `globalConcurrencyLimits`, where the whole cluster counts the jobs of each key.
 * @param {import('./types.js').ConcurrencyLimitOptions} options
 * @returns {import('./types.js').ConcurrencyLimit} Frozen.
 */
export declare function defineConcurrencyLimit(options: import('./types.js').ConcurrencyLimitOptions): import('./types.js').ConcurrencyLimit;
/**
 * @param {unknown} value
 * @returns {value is import('./types.js').ConcurrencyLimit} A limit as defineConcurrencyLimit() makes it: frozen,
 *     with a valid name and max, its key(), and nothing else. No registry of limits: sqlane keeps no global state.
 */
export declare function isConcurrencyLimit(value: unknown): value is import('./types.js').ConcurrencyLimit;
/**
 * @param {unknown} value
 * @returns {value is import('./types.js').ConcurrencyLimitKey} A key as `limit.key()` makes it.
 */
export declare function isConcurrencyLimitKey(value: unknown): value is import('./types.js').ConcurrencyLimitKey;
