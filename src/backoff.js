import { parseDuration } from './duration.js';

/**
 * The delay before the next attempt.
 * @param {import('./types.js').Backoff} backoff Checked.
 * @param {number} attempt The attempt that failed: 1 for the first.
 * @param {() => number} [random] For tests. Default: `Math.random`.
 * @returns {number} Milliseconds.
 */
export function getBackoffMs(backoff, attempt, random = Math.random) {
    const delayMs = /** @type {number} */ (parseDuration(backoff.delay));
    const jitter = backoff.jitter ?? 0.2;
    let baseMs = delayMs;

    if (backoff.type === 'exponential') {
        const maxDelayMs = backoff.maxDelay === undefined
            ? Infinity
            : /** @type {number} */ (parseDuration(backoff.maxDelay));

        baseMs = Math.min(delayMs * 2 ** (attempt - 1), maxDelayMs);
    }

    return Math.round(baseMs * (1 - jitter * random()));
}
