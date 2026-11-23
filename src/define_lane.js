import { isConcurrencyLimit } from './define_concurrency_limit.js';
import { isRateLimit } from './define_rate_limit.js';
import { ConfigError } from './errors.js';
import { checkFailureLane, checkOptionFields, checkObject, NAME_REGEXP } from './validate.js';

const LANE_OPTION_NAMES = [
    'name', 'maxAttempts', 'maxStalls', 'backoff', 'retention', 'timeout', 'failureLane', 'fairShareWeight',
    'localConcurrencyLimits', 'globalConcurrencyLimits', 'localRateLimits', 'globalRateLimits',
];
export const MAX_WEIGHT = 1000;

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

    const weight = options.fairShareWeight;

    if (weight !== undefined && (!Number.isSafeInteger(weight) || weight < 1 || weight > MAX_WEIGHT)) {
        throw new ConfigError(`${where}: "fairShareWeight" must be an integer from 1 to ${MAX_WEIGHT}`);
    }

    const local = options.localConcurrencyLimits;

    if (local !== undefined && (!Array.isArray(local) || !local.every(isConcurrencyLimit))) {
        throw new ConfigError(`${where}: "localConcurrencyLimits" must be an array of limits from defineConcurrencyLimit()`);
    }

    if (local && new Set(local.map(limit => limit.name)).size !== local.length) {
        throw new ConfigError(`${where}: "localConcurrencyLimits" names a limit twice`);
    }

    const localRate = options.localRateLimits;

    // Keyless: each instance counts its starts in memory, with no key to tell apart
    if (localRate !== undefined && (!Array.isArray(localRate) || !localRate.every(isRateLimit))) {
        throw new ConfigError(
            `${where}: "localRateLimits" must be an array of limits from defineRateLimit(), without key() or cost()`,
        );
    }

    if (localRate && new Set(localRate.map(limit => limit.name)).size !== localRate.length) {
        throw new ConfigError(`${where}: "localRateLimits" names a limit twice`);
    }

    return Object.freeze({
        ...options,
        ...(local && { localConcurrencyLimits: Object.freeze([...local]) }),
        ...(localRate && { localRateLimits: Object.freeze([...localRate]) }),
        ...(options.backoff && { backoff: Object.freeze({ ...options.backoff }) }),
        ...(options.retention && { retention: Object.freeze({ ...options.retention }) }),
    });
}
