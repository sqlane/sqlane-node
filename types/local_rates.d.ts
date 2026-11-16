export type RateState = {
    limit: import('./types.js').RateLimit;
    /**
     * Its settings as gcra.js reads them: a start costs 1.
     */
    settings: import('./rate_keys.js').GlobalRateLimit;
    /**
     * Its theoretical arrival time, in µs of the process clock.
     */
    tatUs: number;
    /**
     * Its handled names.
     */
    names: string[];
};
/**
 * A local rate limit in this instance.
 * @typedef {object} RateState
 * @property {import('./types.js').RateLimit} limit
 * @property {import('./rate_keys.js').GlobalRateLimit} settings Its settings as gcra.js reads them: a start costs 1.
 * @property {number} tatUs Its theoretical arrival time, in µs of the process clock.
 * @property {string[]} names Its handled names.
 */
/**
 * @param {import('./types.js').RateLimit} limit
 * @returns {RateState} No start yet: the whole burst.
 */
export declare function createRateState(limit: import('./types.js').RateLimit): RateState;
/** @returns {number} The process clock in µs: monotonic. */
export declare function nowUs(): number;
/**
 * @param {RateState} state
 * @param {number} now In µs.
 * @returns {number} The starts that the limit admits now, one after the other.
 */
export declare function rateRoom(state: RateState, now: number): number;
/**
 * @param {RateState} state
 * @param {number} now In µs.
 * @returns {number} The milliseconds until the limit admits a start, rounded up: 0, now.
 */
export declare function rateWaitMs(state: RateState, now: number): number;
/**
 * A start: its quota is taken.
 * @param {RateState} state
 * @param {number} now In µs.
 */
export declare function takeRate(state: RateState, now: number): void;
/**
 * The other side limits the rate: the next start at `now + retryAfter` at the earliest, then one per per / max. Only
 * extends.
 * @param {RateState} state
 * @param {number} now In µs.
 * @param {number} retryAfterUs
 */
export declare function pauseRate(state: RateState, now: number, retryAfterUs: number): void;
