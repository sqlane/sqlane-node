import { ConfigError } from './errors.js';
import { checkLocalSettings, isLaneDefinition } from './local_settings.js';
import { checkObject } from './validate.js';

const HANDLER_OPTION_NAMES = ['localConcurrencyLimits', 'localRateLimits', 'fairShareWeight'];

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
export function defineHandler(lane, fn, options = {}) {
    const name = isLaneDefinition(lane) ? lane.name : '';
    const where = `defineHandler(${JSON.stringify(name)})`;

    if (!isLaneDefinition(lane)) {
        throw new ConfigError(`${where}: the lane must be a lane definition, from defineLane()`);
    }

    if (typeof fn !== 'function') {
        throw new ConfigError(`${where}: the handler must be a function`);
    }

    const given = checkObject(options, HANDLER_OPTION_NAMES, 'options', { where, ErrorClass: ConfigError });

    return /** @type {any} */ (Object.freeze({ lane, handler: fn, ...checkLocalSettings(given, where) }));
}

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').LaneHandler} A handler as `defineHandler()` makes it: frozen, with a lane
 *     definition and a function.
 */
export function isLaneHandler(value) {
    return typeof value === 'object' && value !== null && Object.isFrozen(value)
        && 'handler' in value && typeof value.handler === 'function'
        && 'lane' in value && isLaneDefinition(value.lane);
}
