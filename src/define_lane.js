import { ConfigError } from './errors.js';
import { checkLocalSettings } from './local_settings.js';
import { checkFailureLane, checkOptionFields, checkObject, NAME_REGEXP } from './validate.js';

const LANE_OPTION_NAMES = [
    'name', 'maxAttempts', 'maxStalls', 'backoff', 'retention', 'timeout', 'failureLane', 'fairShareWeight',
    'localConcurrencyLimits', 'globalConcurrencyLimits', 'localRateLimits', 'globalRateLimits',
];
export { MAX_WEIGHT } from './local_settings.js';

/**
 * Defines a lane and its options. Producers and workers import the definition. `defineLane<{ reportId: string }>(…)`
 * declares the payload: `enqueue`, `lanes.add`, `globalConcurrencyLimits` and `globalRateLimits` then check it.
 * @template [P=any]
 * @param {import('./types.js').LaneOptions<P>} options
 * @returns {import('./types.js').LaneDefinition<P>} Frozen.
 */
export function defineLane(options) {
    const name = typeof options?.name === 'string' ? options.name : '';
    const where = `defineLane(${JSON.stringify(name)})`;

    const scope = { where, ErrorClass: ConfigError };

    checkObject(options, LANE_OPTION_NAMES, 'options', scope);

    if (!NAME_REGEXP.test(name)) {
        throw new ConfigError(`${where}: "name" must match ${NAME_REGEXP}`);
    }

    checkOptionFields(options, scope);

    if (options.globalConcurrencyLimits !== undefined && typeof options.globalConcurrencyLimits !== 'function') {
        throw new ConfigError(`${where}: "globalConcurrencyLimits" must be a function of the context, ({ payload })`);
    }

    if (options.globalRateLimits !== undefined && typeof options.globalRateLimits !== 'function') {
        throw new ConfigError(`${where}: "globalRateLimits" must be a function of the context, ({ payload })`);
    }

    if (options.failureLane !== undefined) {
        checkFailureLane(options.failureLane, name, scope);
    }

    const settings = checkLocalSettings(options, where);

    return Object.freeze({
        ...options,
        ...settings,
        ...(options.backoff && { backoff: Object.freeze({ ...options.backoff }) }),
        ...(options.retention && { retention: Object.freeze({ ...options.retention }) }),
    });
}
