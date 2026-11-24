export declare const MAX_WEIGHT = 1000;
/**
 * @param {unknown} value
 * @returns {value is import('./types.js').LaneDefinition} A lane definition as `defineLane()` makes it: frozen, with a
 *     name.
 */
export declare function isLaneDefinition(value: unknown): value is import('./types.js').LaneDefinition;
/**
 * Checks `fairShareWeight`, `localConcurrencyLimits` and `localRateLimits`.
 * @param {Record<string, unknown>} options
 * @param {string} where
 * @returns {import('./types.js').HandlerOptions} The settings that are set, with frozen copies of the limits.
 */
export declare function checkLocalSettings(options: Record<string, unknown>, where: string): import('./types.js').HandlerOptions;
