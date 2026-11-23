export declare const MAX_WEIGHT = 1000;
/**
 * Defines a lane and its options. Producers and workers import the definition. `defineLane<{ reportId: string }>(…)`
 * declares the payload: `enqueue`, `lanes.add`, `globalConcurrencyLimits` and `globalRateLimits` then check it.
 * @template [P=any]
 * @param {import('./types.js').LaneOptions<P>} options
 * @returns {import('./types.js').LaneDefinition<P>} Frozen.
 */
export declare function defineLane<P = any>(options: import('./types.js').LaneOptions<P>): import('./types.js').LaneDefinition<P>;
