export { isRateLimit, isRateLimitKey } from './rate_limit_shape.js';
/**
 * Defines a rate limit: the most job starts in a period, `max` per `per`, with bursts of up to `burst`. A job
 * definition lists it in `localRateLimits`, where each instance counts its own starts, or returns it, one of its keys
 * or a cost of it, from `globalRateLimits`, where the whole cluster counts the starts of each key.
 * @param {import('./types.js').RateLimitOptions} options
 * @returns {import('./types.js').RateLimit} Frozen; `per` in milliseconds.
 */
export declare function defineRateLimit(options: import('./types.js').RateLimitOptions): import('./types.js').RateLimit;
