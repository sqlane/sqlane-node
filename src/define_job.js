import { ConfigError } from './errors.js';
import { checkFailureJob, checkJobFields, checkObject, JOB_NAME_REGEXP } from './validate.js';

const JOB_OPTION_NAMES = [
    'name', 'maxAttempts', 'maxStalls', 'backoff', 'retention', 'timeout', 'mutexKeys', 'failureJob',
];

/**
 * Defines a job name and its options. Producers and workers import the definition. `defineJob<{ reportId: string }>(…)`
 * declares the payload: `enqueue`, `handle` and `mutexKeys` then check it.
 * @template [P=any]
 * @param {import('./types.js').JobOptions<P>} options
 * @returns {import('./types.js').JobDefinition<P>} Frozen.
 */
export function defineJob(options) {
    const name = typeof options?.name === 'string' ? options.name : '';
    const where = `defineJob(${JSON.stringify(name)})`;

    const scope = { where, ErrorClass: ConfigError };

    checkObject(options, JOB_OPTION_NAMES, 'options', scope);

    if (!JOB_NAME_REGEXP.test(name)) {
        throw new ConfigError(`${where}: "name" must match ${JOB_NAME_REGEXP}`);
    }

    checkJobFields(options, scope);

    if (options.mutexKeys !== undefined && typeof options.mutexKeys !== 'function') {
        throw new ConfigError(`${where}: "mutexKeys" must be a function of the payload`);
    }

    if (options.failureJob !== undefined) {
        checkFailureJob(options.failureJob, name, scope);
    }

    return Object.freeze({
        ...options,
        ...(options.backoff && { backoff: Object.freeze({ ...options.backoff }) }),
        ...(options.retention && { retention: Object.freeze({ ...options.retention }) }),
    });
}
