// The settings of a lane in one process: its share of the free slots and its local limits. A handler holds them
// (defineHandler); until 10.0, a lane definition too.
import { isConcurrencyLimit } from './define_concurrency_limit.js';
import { isRateLimit } from './define_rate_limit.js';
import { ConfigError } from './errors.js';
import { isPlainObject } from './validate.js';

export const MAX_WEIGHT = 1000;

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').LaneDefinition} A lane definition as `defineLane()` makes it: frozen, with a
 *     name.
 */
export function isLaneDefinition(value) {
    return isPlainObject(value) && typeof value.name === 'string' && Object.isFrozen(value);
}

/**
 * Checks `fairShareWeight`, `localConcurrencyLimits` and `localRateLimits`.
 * @param {Record<string, unknown>} options
 * @param {string} where
 * @returns {import('./types.js').HandlerOptions} The settings that are set, with frozen copies of the limits.
 */
export function checkLocalSettings(options, where) {
    const weight = options.fairShareWeight;

    if (weight !== undefined && (!Number.isSafeInteger(weight) || Number(weight) < 1 || Number(weight) > MAX_WEIGHT)) {
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

    return {
        ...(weight !== undefined && { fairShareWeight: /** @type {number} */ (weight) }),
        ...(local && { localConcurrencyLimits: Object.freeze([...local]) }),
        ...(localRate && { localRateLimits: Object.freeze([...localRate]) }),
    };
}

/**
 * @param {Readonly<import('./types.js').HandlerOptions>} settings
 * @returns {boolean} One of the settings is set.
 */
export function hasLocalSettings(settings) {
    return settings.fairShareWeight !== undefined || settings.localConcurrencyLimits !== undefined
        || settings.localRateLimits !== undefined;
}
