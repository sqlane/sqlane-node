// The local limits of the added lanes in this instance, of concurrency and of rate: the jobs that each admits now,
// and the wake of the lanes whose local rate limits admit no start now. The lanes of a limit share its state.
import { nowUs, rateRoom, rateWaitMs } from './local_rates.js';
import { createRateWakes } from './rate_wakes.js';

/** @typedef {import('./registry.js').HandlerEntry} HandlerEntry */
/** @typedef {import('./registry.js').LimitState} LimitState */
/** @typedef {import('./registry.js').RateState} RateState */
/** @typedef {LimitState | RateState} LocalLimit A local limit, of concurrency or of rate */

/**
 * @param {LimitState} limit
 * @returns {number} Its max minus its running jobs.
 */
export function limitRoom(limit) {
    return limit.limit.max - limit.running;
}

/**
 * @param {LocalLimit} limit
 * @returns {number} The jobs that it admits now: of a concurrency limit, its max minus its running jobs; of a rate
 *     limit, the starts that its quota admits now.
 */
export function roomOf(limit) {
    return 'tatUs' in limit ? rateRoom(limit, nowUs()) : limitRoom(limit);
}

/**
 * @param {HandlerEntry} entry
 * @returns {readonly LocalLimit[]} Its local limits of both kinds.
 */
export function localLimitsOf(entry) {
    // Most lanes have no rate limit: no copy
    return entry.rates.length ? [...entry.limits, ...entry.rates] : entry.limits;
}

/**
 * @param {HandlerEntry} entry
 * @returns {number} The lowest room of its local limits, of concurrency and of rate; Infinity without one.
 */
export function limitsRoom(entry) {
    let room = Infinity;

    for (const limit of entry.limits) {
        room = Math.min(room, limitRoom(limit));
    }

    if (entry.rates.length) {
        const now = nowUs();

        for (const rate of entry.rates) {
            room = Math.min(room, rateRoom(rate, now));
        }
    }

    return room;
}

/**
 * The lanes of a choice, with their counts now. The lanes of one limit share one room object; the room of a rate
 * limit is the starts that its quota admits now, one per job.
 * @param {HandlerEntry[]} entries
 * @returns {import('./fair_share.js').ShareLane[]}
 */
export function shareLanesOf(entries) {
    /** @type {Map<LocalLimit, { room: number }>} */
    const rooms = new Map();

    return entries.map(entry => ({
        name: entry.name,
        index: entry.index,
        weight: entry.weight,
        running: entry.running,
        limits: localLimitsOf(entry).map((limit) => {
            const room = rooms.get(limit) ?? { room: Math.max(0, roomOf(limit)) };

            rooms.set(limit, room);

            return room;
        }),
        available: Infinity,
    }));
}

/**
 * @param {import('./registry.js').Registry} registry
 * @param {string[]} lanes
 * @param {number} at
 * @returns {boolean} One of the lanes waits for a local rate limit that admits a start before the time.
 */
export function ratesAdmitBefore(registry, lanes, at) {
    const now = nowUs();

    return lanes.some(lane => registry.getEntry(lane)?.rates.some(
        rate => rateRoom(rate, now) <= 0 && Date.now() + rateWaitMs(rate, now) < at,
    ));
}

/**
 * @typedef {object} LocalRateWakes
 * @property {(entry: HandlerEntry) => void} wakeAfterRates The local rate limits of the lane that admit no start now:
 *     its lanes wake when one may start. A lane over one of them is left out of the turns, as a lane at its local cap.
 * @property {() => void} clear Forgets the limits, and stops the timer.
 */

/**
 * The timer of the local rate limits that a turn left lanes out for: a wake of their lanes when one may start.
 * @param {object} params
 * @param {(func: () => void, delayMs: number) => NodeJS.Timeout} params.setTimer An unref'd timer.
 * @param {(timer: NodeJS.Timeout) => void} params.clearTimer
 * @param {(lanes: string[]) => void} params.wake A speculative wake of the lanes: a probe first.
 * @returns {LocalRateWakes}
 */
export function createLocalRateWakes({ setTimer, clearTimer, wake }) {
    /** @type {Map<string, RateState>} The local rate limits that wait for their next start, by name */
    const waitingRates = new Map();
    const localRateWakes = createRateWakes({
        setTimer,
        clearTimer,
        onDue: (limitNames) => {
            const lanes = limitNames.flatMap(name => waitingRates.get(name)?.lanes ?? []);

            for (const name of limitNames) {
                waitingRates.delete(name);
            }

            wake(lanes);
        },
        batchMs: 0,
    });

    return {
        wakeAfterRates: (entry) => {
            if (!entry.rates.length) {
                return;
            }

            const now = nowUs();

            for (const rate of entry.rates) {
                if (rateRoom(rate, now) <= 0) {
                    waitingRates.set(rate.limit.name, rate);
                    localRateWakes.arm(rate.limit.name, rateWaitMs(rate, now));
                }
            }
        },
        clear: () => {
            localRateWakes.clear();
            waitingRates.clear();
        },
    };
}
