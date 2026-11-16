export type HandlerEntry = import('./registry.js').HandlerEntry;
export type LimitState = import('./registry.js').LimitState;
export type RateState = import('./registry.js').RateState;
export type LocalLimit = LimitState | RateState;
/** @typedef {import('./registry.js').HandlerEntry} HandlerEntry */
/** @typedef {import('./registry.js').LimitState} LimitState */
/** @typedef {import('./registry.js').RateState} RateState */
/** @typedef {LimitState | RateState} LocalLimit A local limit, of concurrency or of rate */
/**
 * @param {LimitState} limit
 * @returns {number} Its max minus its running jobs.
 */
export declare function limitRoom(limit: LimitState): number;
/**
 * @param {LocalLimit} limit
 * @returns {number} The jobs that it admits now: of a concurrency limit, its max minus its running jobs; of a rate
 *     limit, the starts that its quota admits now.
 */
export declare function roomOf(limit: LocalLimit): number;
/**
 * @param {HandlerEntry} entry
 * @returns {readonly LocalLimit[]} Its local limits of both kinds.
 */
export declare function localLimitsOf(entry: HandlerEntry): readonly LocalLimit[];
/**
 * @param {HandlerEntry} entry
 * @returns {number} The lowest room of its local limits, of concurrency and of rate; Infinity without one.
 */
export declare function limitsRoom(entry: HandlerEntry): number;
/**
 * The names of a choice, with their counts now. The names of one limit share one room object; the room of a rate
 * limit is the starts that its quota admits now, one per job.
 * @param {HandlerEntry[]} entries
 * @returns {import('./fair_share.js').ShareName[]}
 */
export declare function shareNamesOf(entries: HandlerEntry[]): import('./fair_share.js').ShareName[];
/**
 * @param {import('./registry.js').Registry} registry
 * @param {string[]} names
 * @param {number} at
 * @returns {boolean} One of the names waits for a local rate limit that admits a start before the time.
 */
export declare function ratesAdmitBefore(registry: import('./registry.js').Registry, names: string[], at: number): boolean;
export type LocalRateWakes = {
    /**
     * The local rate limits of the name that admit no start now:
     * its names wake when one may start. A name over one of them is left out of the turns, as a name at its local cap.
     */
    wakeAfterRates: (entry: HandlerEntry) => void;
    /**
     * Forgets the limits, and stops the timer.
     */
    clear: () => void;
};
/**
 * @typedef {object} LocalRateWakes
 * @property {(entry: HandlerEntry) => void} wakeAfterRates The local rate limits of the name that admit no start now:
 *     its names wake when one may start. A name over one of them is left out of the turns, as a name at its local cap.
 * @property {() => void} clear Forgets the limits, and stops the timer.
 */
/**
 * The timer of the local rate limits that a turn left names out for: a wake of their names when one may start.
 * @param {object} params
 * @param {(func: () => void, delayMs: number) => NodeJS.Timeout} params.setTimer An unref'd timer.
 * @param {(timer: NodeJS.Timeout) => void} params.clearTimer
 * @param {(names: string[]) => void} params.wake A speculative wake of the names: a probe first.
 * @returns {LocalRateWakes}
 */
export declare function createLocalRateWakes({ setTimer, clearTimer, wake }: {
    setTimer: (func: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer: (timer: NodeJS.Timeout) => void;
    wake: (names: string[]) => void;
}): LocalRateWakes;
