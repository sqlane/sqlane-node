/**
 * Defines how a process runs the jobs of a lane: its function, and the settings of the lane in that process. A runner
 * mounts it (`runner.mount([handler])`). The handler code and its dependencies stay out of the producers, which
 * import the lane only.
 * @template {import('./types.js').LaneDefinition} J
 * @param {J} lane The lane definition, from `defineLane()`.
 * @param {import('./types.js').Handler<import('./types.js').HandlerPayload<J>>} fn Gets `{ payload, job, signal }`,
 *     the payload typed by the lane.
 * @param {import('./types.js').HandlerOptions} [options] `localConcurrencyLimits`, `localRateLimits`,
 *     `fairShareWeight`: per process.
 * @returns {import('./types.js').LaneHandler<import('./types.js').HandlerPayload<J>>} Frozen.
 */
export declare function defineHandler<J extends import('./types.js').LaneDefinition>(lane: J, fn: import('./types.js').Handler<import('./types.js').HandlerPayload<J>>, options?: import('./types.js').HandlerOptions): import('./types.js').LaneHandler<import('./types.js').HandlerPayload<J>>;
/**
 * @param {unknown} value
 * @returns {value is import('./types.js').LaneHandler} A handler as `defineHandler()` makes it: frozen, with a lane
 *     definition and a function.
 */
export declare function isLaneHandler(value: unknown): value is import('./types.js').LaneHandler;
