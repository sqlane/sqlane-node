import { parseDuration } from './duration.js';
import { ConfigError } from './errors.js';
import { checkJobFields, checkObject } from './validate.js';

/**
 * The job defaults of an instance, merged with the built-in ones and checked.
 * @typedef {object} ResolvedDefaults
 * @property {number} maxAttempts
 * @property {number} maxStalls
 * @property {import('./types.js').Backoff} backoff
 * @property {{ completedMs: number, failedMs: number }} retention
 * @property {number | null} timeoutMs Null: no timeout.
 */

/** @type {Required<import('./types.js').JobDefaults>['backoff']} */
const DEFAULT_BACKOFF = Object.freeze({ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 });

/**
 * @param {import('./types.js').JobDefaults} [defaults]
 * @returns {ResolvedDefaults}
 */
export function resolveDefaults(defaults = {}) {
    const scope = { where: 'createSqlane: "defaults"', ErrorClass: ConfigError };

    checkObject(defaults, ['maxAttempts', 'maxStalls', 'backoff', 'retention', 'timeout'], 'defaults', scope);
    checkJobFields(defaults, scope);

    return {
        maxAttempts: defaults.maxAttempts ?? 3,
        maxStalls: defaults.maxStalls ?? 2,
        backoff: defaults.backoff ?? DEFAULT_BACKOFF,
        retention: {
            completedMs: /** @type {number} */ (parseDuration(defaults.retention?.completed ?? '1h')),
            failedMs: /** @type {number} */ (parseDuration(defaults.retention?.failed ?? '30d')),
        },
        timeoutMs: defaults.timeout === undefined ? null : parseDuration(defaults.timeout),
    };
}
