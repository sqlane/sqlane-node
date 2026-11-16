import { parseDuration } from './duration.js';
import { ConfigError, InvalidRateLimitError } from './errors.js';
import { isPerMs, isRateMax, isUpTo, MAX_RATE } from './rate_limit_shape.js';
import { checkObject, JOB_NAME_REGEXP } from './validate.js';

export { isRateLimit, isRateLimitKey } from './rate_limit_shape.js';

/**
 * Defines a rate limit: the most job starts in a period, `max` per `per`, with bursts of up to `burst`. A job
 * definition lists it in `localRateLimits`, where each instance counts its own starts, or returns it, one of its keys
 * or a cost of it, from `globalRateLimits`, where the whole cluster counts the starts of each key.
 * @param {import('./types.js').RateLimitOptions} options
 * @returns {import('./types.js').RateLimit} Frozen; `per` in milliseconds.
 */
export function defineRateLimit(options) {
    const name = typeof options?.name === 'string' ? options.name : '';
    const where = `defineRateLimit(${JSON.stringify(name)})`;

    checkObject(options, ['name', 'max', 'per', 'burst'], 'options', { where, ErrorClass: ConfigError });

    if (!JOB_NAME_REGEXP.test(name)) {
        throw new ConfigError(`${where}: "name" must match ${JOB_NAME_REGEXP}`);
    }

    const { max } = options;

    if (!isRateMax(max)) {
        throw new ConfigError(`${where}: "max" must be an integer from 1 to ${MAX_RATE}`);
    }

    const per = parseDuration(options.per);

    if (!isPerMs(per)) {
        throw new ConfigError(`${where}: "per" must be a duration from 1 ms to 7 d ('1s', '1h', or milliseconds), got `
            + `${JSON.stringify(options.per)}`);
    }

    if (max > per * 1000) {
        throw new ConfigError(`${where}: "max" must be at most the microseconds of "per", ${per * 1000}: at most one `
            + 'start per microsecond');
    }

    const burst = options.burst ?? 1;

    if (!isUpTo(burst, max)) {
        throw new ConfigError(`${where}: "burst" must be an integer from 1 to "max", ${max}`);
    }

    /**
     * @param {unknown} cost
     * @param {string} label
     * @returns {number}
     */
    function checkCost(cost, label) {
        if (!isUpTo(cost, burst)) {
            throw new InvalidRateLimitError(
                `${label}: "cost" must be an integer from 1 to the burst of the limit, ${burst}, got ${JSON.stringify(cost)}`,
            );
        }

        return cost;
    }

    /** @type {import('./types.js').RateLimit} */
    const limit = Object.freeze({
        name,
        max,
        per,
        burst,
        key: (/** @type {string | number} */ value, /** @type {{ cost?: number } | undefined} */ keyOptions) => {
            const label = `${name}.key()`;

            if (typeof value !== 'string' && !Number.isSafeInteger(value)) {
                throw new InvalidRateLimitError(
                    `${label}: the key must be a string or an integer, got ${JSON.stringify(value)}`,
                );
            }

            const { cost = 1 } = keyOptions === undefined
                ? {}
                : checkObject(keyOptions, ['cost'], 'options', { where: label, ErrorClass: InvalidRateLimitError });

            return Object.freeze({ limit, key: String(value), cost: checkCost(cost, label) });
        },
        cost: (/** @type {number} */ cost) => Object.freeze({ limit, key: null, cost: checkCost(cost, `${name}.cost()`) }),
    });

    return limit;
}
