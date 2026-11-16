export declare const MAX_RATE = 1000000;
/** 7 d */
export declare const MAX_PER_MS = 604800000;
/**
 * @param {unknown} value
 * @returns {value is number}
 */
export declare function isRateMax(value: unknown): value is number;
/**
 * @param {unknown} value
 * @returns {value is number}
 */
export declare function isPerMs(value: unknown): value is number;
/**
 * @param {unknown} value A burst, or a cost.
 * @param {number} max The max of the limit, or its burst.
 * @returns {value is number}
 */
export declare function isUpTo(value: unknown, max: number): value is number;
/**
 * @param {unknown} value
 * @returns {value is import('./types.js').RateLimit} A limit as defineRateLimit() makes it: frozen, with a valid name,
 *     max, per and burst, its key() and cost(), and nothing else.
 */
export declare function isRateLimit(value: unknown): value is import('./types.js').RateLimit;
/**
 * @param {unknown} value
 * @returns {value is import('./types.js').RateLimitKey} A key as `limit.key()` or `limit.cost()` makes it.
 */
export declare function isRateLimitKey(value: unknown): value is import('./types.js').RateLimitKey;
/**
 * The stored key of a rate limit or of its key: `@<name>`, or `@<name>:<key>`. The `@` keeps it apart from the keys of
 * the concurrency limits, whose names start with a letter.
 * @param {import('./types.js').RateLimit | import('./types.js').RateLimitKey} entry Checked.
 * @returns {string}
 */
export declare function rateKeyOf(entry: import('./types.js').RateLimit | import('./types.js').RateLimitKey): string;
/**
 * A stored rate key, split: the name of its limit, and its key (null: the limit has none). Limit names have no `:`.
 * @param {string} stored `@<name>` or `@<name>:<key>`.
 * @returns {{ limit: string, key: string | null }}
 */
export declare function parseRateKey(stored: string): {
    limit: string;
    key: string | null;
};
