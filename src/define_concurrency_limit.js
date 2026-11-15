import { ConfigError, InvalidConcurrencyLimitError } from './errors.js';
import { checkObject, JOB_NAME_REGEXP } from './validate.js';

export const MAX_LIMIT = 1000;

/**
 * Defines a concurrency limit: the most jobs that hold it at once. A job definition lists it in
 * `localConcurrencyLimits`, where each instance counts its own jobs, or returns it, or one of its keys, from
 * `globalConcurrencyLimits`, where the whole cluster counts the jobs of each key.
 * @param {import('./types.js').ConcurrencyLimitOptions} options
 * @returns {import('./types.js').ConcurrencyLimit} Frozen.
 */
export function defineConcurrencyLimit(options) {
    const name = typeof options?.name === 'string' ? options.name : '';
    const where = `defineConcurrencyLimit(${JSON.stringify(name)})`;

    checkObject(options, ['name', 'max'], 'options', { where, ErrorClass: ConfigError });

    if (!JOB_NAME_REGEXP.test(name)) {
        throw new ConfigError(`${where}: "name" must match ${JOB_NAME_REGEXP}`);
    }

    if (!isMax(options.max)) {
        throw new ConfigError(`${where}: "max" must be an integer from 1 to ${MAX_LIMIT}`);
    }

    /** @type {import('./types.js').ConcurrencyLimit} */
    const limit = Object.freeze({
        name,
        max: options.max,
        key: (/** @type {string | number} */ value) => {
            if (typeof value !== 'string' && !Number.isSafeInteger(value)) {
                throw new InvalidConcurrencyLimitError(
                    `${name}.key(): the key must be a string or an integer, got ${JSON.stringify(value)}`,
                );
            }

            return Object.freeze({ limit, key: String(value) });
        },
    });

    return limit;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isMax(value) {
    return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_LIMIT;
}

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').ConcurrencyLimit} A limit as defineConcurrencyLimit() makes it: frozen,
 *     with a valid name and max, its key(), and nothing else. No registry of limits: sqlane keeps no global state.
 */
export function isConcurrencyLimit(value) {
    if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) {
        return false;
    }

    const { name, max, key, ...rest } = /** @type {Record<string, unknown>} */ (value);

    return typeof name === 'string' && JOB_NAME_REGEXP.test(name) && isMax(max) && typeof key === 'function'
        && Object.keys(rest).length === 0;
}

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').ConcurrencyLimitKey} A key as `limit.key()` makes it.
 */
export function isConcurrencyLimitKey(value) {
    if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) {
        return false;
    }

    const { limit, key, ...rest } = /** @type {Record<string, unknown>} */ (value);

    return isConcurrencyLimit(limit) && typeof key === 'string' && Object.keys(rest).length === 0;
}
