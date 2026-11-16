// The local rate limits of an instance: GCRA in memory (gcra.js), on the monotonic clock of the process. Each start
// costs 1. The names of a limit share its state, as they share a local concurrency limit.
import { allowanceUs, incrementUs, toleranceUs, waitMsOf, waitUs } from './gcra.js';

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
export function createRateState(limit) {
    return {
        limit,
        settings: { key: `@${limit.name}`, max: limit.max, per_us: limit.per * 1000, burst: limit.burst, cost: 1 },
        tatUs: 0,
        names: [],
    };
}

/** @returns {number} The process clock in µs: monotonic. */
export function nowUs() {
    return Math.round(performance.now() * 1000);
}

/**
 * @param {RateState} state
 * @param {number} now In µs.
 * @returns {number} The starts that the limit admits now, one after the other.
 */
export function rateRoom(state, now) {
    const debt = Math.max(state.tatUs - now, 0);
    // The debt that a start may find
    const spare = allowanceUs(state.settings) - incrementUs(state.settings) - debt;

    return spare < 0 ? 0 : Math.floor(spare / incrementUs(state.settings)) + 1;
}

/**
 * @param {RateState} state
 * @param {number} now In µs.
 * @returns {number} The milliseconds until the limit admits a start, rounded up: 0, now.
 */
export function rateWaitMs(state, now) {
    return waitMsOf(waitUs(Math.max(state.tatUs - now, 0), state.settings));
}

/**
 * A start: its quota is taken.
 * @param {RateState} state
 * @param {number} now In µs.
 */
export function takeRate(state, now) {
    state.tatUs = Math.max(state.tatUs, now) + incrementUs(state.settings);
}

/**
 * The other side limits the rate: the next start at `now + retryAfter` at the earliest, then one per per / max. Only
 * extends.
 * @param {RateState} state
 * @param {number} now In µs.
 * @param {number} retryAfterUs
 */
export function pauseRate(state, now, retryAfterUs) {
    state.tatUs = Math.max(state.tatUs, now + retryAfterUs + toleranceUs(state.settings));
}
