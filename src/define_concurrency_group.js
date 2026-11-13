import { ConfigError } from './errors.js';
import { checkObject, JOB_NAME_REGEXP } from './validate.js';

/**
 * Defines a concurrency group: a cap on the handlers of several job names that run at once in one instance. Pass it to
 * `handle()` as `concurrencyGroup`. Each instance counts its own handlers in the group.
 * @param {import('./types.js').ConcurrencyGroupOptions} options
 * @returns {import('./types.js').ConcurrencyGroup} Frozen.
 */
export function defineConcurrencyGroup(options) {
    const name = typeof options?.name === 'string' ? options.name : '';
    const where = `defineConcurrencyGroup(${JSON.stringify(name)})`;

    checkObject(options, ['name', 'maxConcurrency'], 'options', { where, ErrorClass: ConfigError });

    if (!JOB_NAME_REGEXP.test(name)) {
        throw new ConfigError(`${where}: "name" must match ${JOB_NAME_REGEXP}`);
    }

    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
        throw new ConfigError(`${where}: "maxConcurrency" must be an integer, at least 1`);
    }

    return Object.freeze({ name, maxConcurrency: options.maxConcurrency });
}

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').ConcurrencyGroup} A group as defineConcurrencyGroup() makes it: frozen, with
 *     a valid name and maxConcurrency, and nothing else. No registry of groups: sqlane keeps no global state.
 */
export function isConcurrencyGroup(value) {
    if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) {
        return false;
    }

    const { name, maxConcurrency, ...rest } = /** @type {Record<string, unknown>} */ (value);

    return typeof name === 'string' && JOB_NAME_REGEXP.test(name) && Number.isSafeInteger(maxConcurrency)
        && Number(maxConcurrency) >= 1 && Object.keys(rest).length === 0;
}
