import { parseDuration } from './duration.js';

/** A job name: no `:` (the job id is `<name>:<jobId>`), lowercase. */
export const JOB_NAME_REGEXP = /^[a-z][a-z0-9_.-]{0,127}$/;

/** Printable ASCII, no space at the ends: MySQL `ascii_bin` ignores trailing spaces in comparisons. */
export const PRINTABLE_ID_REGEXP = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;

/**
 * Where a check runs: for the error message and its class.
 * @typedef {object} Scope
 * @property {string} where E.g. `defineJob("build_report")`.
 * @property {new (message: string) => Error} ErrorClass
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Throws if the value is not an object with only the allowed keys.
 * @param {unknown} value
 * @param {readonly string[]} allowedKeys
 * @param {string} label E.g. `"options"`.
 * @param {Scope} scope
 * @returns {Record<string, unknown>}
 */
export function checkObject(value, allowedKeys, label, { where, ErrorClass }) {
    if (!isPlainObject(value)) {
        throw new ErrorClass(`${where}: ${label} must be an object`);
    }

    const unknownKeys = Object.keys(value).filter(key => !allowedKeys.includes(key));

    if (unknownKeys.length) {
        throw new ErrorClass(`${where}: unknown ${label}: ${unknownKeys.join(', ')}`);
    }

    return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {Scope} scope
 * @param {number} [min] Default: 1.
 */
export function checkInteger(value, label, { where, ErrorClass }, min = 1) {
    if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < min) {
        throw new ErrorClass(`${where}: ${label} must be an integer of at least ${min}, got ${JSON.stringify(value)}`);
    }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {Scope} scope
 * @param {boolean} [positive] Default: false: 0 is a duration.
 * @returns {number} Milliseconds.
 */
export function checkDuration(value, label, { where, ErrorClass }, positive = false) {
    const ms = parseDuration(value);

    if (ms === null || (positive && ms === 0)) {
        throw new ErrorClass(
            `${where}: ${label} must be a ${positive ? 'positive ' : ''}duration ('5s', '4m30s', or milliseconds), `
            + `got ${JSON.stringify(value)}`,
        );
    }

    return ms;
}

/**
 * @param {unknown} value
 * @param {Scope} scope
 */
export function checkBackoff(value, scope) {
    const { where, ErrorClass } = scope;
    const backoff = checkObject(value, ['type', 'delay', 'maxDelay', 'jitter'], '"backoff" options', scope);

    if (backoff.type !== 'exponential' && backoff.type !== 'fixed') {
        throw new ErrorClass(`${where}: "backoff.type" must be 'exponential' or 'fixed'`);
    }

    const delayMs = checkDuration(backoff.delay, '"backoff.delay"', scope);

    if (backoff.maxDelay !== undefined) {
        if (backoff.type === 'fixed') {
            throw new ErrorClass(`${where}: "backoff.maxDelay" is only for the exponential backoff`);
        }

        if (checkDuration(backoff.maxDelay, '"backoff.maxDelay"', scope) < delayMs) {
            throw new ErrorClass(`${where}: "backoff.maxDelay" must be at least "backoff.delay"`);
        }
    }

    const { jitter } = backoff;

    if (jitter !== undefined && (typeof jitter !== 'number' || !(jitter >= 0 && jitter <= 1))) {
        throw new ErrorClass(`${where}: "backoff.jitter" must be a number from 0 to 1`);
    }
}

/**
 * @param {unknown} value
 * @param {Scope} scope
 */
export function checkRetention(value, scope) {
    const retention = checkObject(value, ['completed', 'failed'], '"retention" options', scope);

    for (const key of ['completed', 'failed']) {
        if (retention[key] !== undefined) {
            checkDuration(retention[key], `"retention.${key}"`, scope);
        }
    }
}

/**
 * Checks the options that a definition, the instance defaults and an enqueue share.
 * @param {Record<string, unknown>} options
 * @param {Scope} scope
 */
export function checkJobFields(options, scope) {
    if (options.maxAttempts !== undefined) {
        checkInteger(options.maxAttempts, '"maxAttempts"', scope);
    }

    if (options.maxStalls !== undefined) {
        checkInteger(options.maxStalls, '"maxStalls"', scope, 0);
    }

    if (options.backoff !== undefined) {
        checkBackoff(options.backoff, scope);
    }

    if (options.retention !== undefined) {
        checkRetention(options.retention, scope);
    }

    if (options.timeout !== undefined) {
        checkDuration(options.timeout, '"timeout"', scope, true);
    }
}

/**
 * @param {unknown} value A name, or a definition.
 * @param {string} jobName The job that names it.
 * @param {Scope} scope
 * @returns {string} The name of the failure job.
 */
export function checkFailureJob(value, jobName, { where, ErrorClass }) {
    const name = isPlainObject(value) ? value.name : value;

    if (typeof name !== 'string' || !JOB_NAME_REGEXP.test(name)) {
        throw new ErrorClass(`${where}: "failureJob" must be a job name or a job definition`);
    }

    if (name === jobName) {
        throw new ErrorClass(`${where}: a job cannot be its own failure job`);
    }

    return name;
}
