/**
 * The delay before the next attempt.
 * @param {import('./types.js').Backoff} backoff Checked.
 * @param {number} attempt The attempt that failed: 1 for the first.
 * @param {() => number} [random] For tests. Default: `Math.random`.
 * @returns {number} Milliseconds.
 */
export declare function getBackoffMs(backoff: import('./types.js').Backoff, attempt: number, random?: () => number): number;
