import { ConfigError } from './errors.js';
import { isLaneDefinition } from './local_settings.js';
import { checkOptionFields, checkObject, NAME_REGEXP } from './validate.js';

const LANE_OPTION_NAMES = [
    'name', 'maxAttempts', 'maxStalls', 'backoff', 'retention', 'timeout', 'failureLane', 'globalConcurrencyLimits',
    'globalRateLimits',
];

/**
 * Defines a lane and its options: what a job is. Producers and workers import the definition.
 * `defineLane<{ reportId: string }>(…)` declares the payload: `enqueue`, `defineHandler`, `defineSchedule`,
 * `globalConcurrencyLimits` and `globalRateLimits` then check it.
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

    const { failureLane } = options;

    if (failureLane !== undefined) {
        if (!isLaneDefinition(failureLane)) {
            throw new ConfigError(`${where}: "failureLane" must be a lane definition, from defineLane()`);
        }

        if (failureLane.name === name) {
            throw new ConfigError(`${where}: a lane cannot be its own failure lane`);
        }

        // No chains: a failure job never has a failure job of its own
        if (failureLane.failureLane !== undefined) {
            throw new ConfigError(`${where}: the failure lane "${failureLane.name}" has a failure lane of its own`);
        }
    }

    return Object.freeze({
        ...options,
        ...(options.backoff && { backoff: Object.freeze({ ...options.backoff }) }),
        ...(options.retention && { retention: Object.freeze({ ...options.retention }) }),
    });
}
