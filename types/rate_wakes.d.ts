export type RateWakes = {
    /**
     * The key is due after the delay. A key that is due sooner keeps
     * its time: its unblock gives the next one.
     */
    arm: (key: string, delayMs: number) => void;
    /**
     * A key is due before this time.
     */
    dueBefore: (at: number) => boolean;
    /**
     * Forgets the keys, and stops the timer.
     */
    clear: () => void;
};
/**
 * @typedef {object} RateWakes
 * @property {(key: string, delayMs: number) => void} arm The key is due after the delay. A key that is due sooner keeps
 *     its time: its unblock gives the next one.
 * @property {(at: number) => boolean} dueBefore A key is due before this time.
 * @property {() => void} clear Forgets the keys, and stops the timer.
 */
/**
 * @param {object} params
 * @param {(func: () => void, delayMs: number) => NodeJS.Timeout} params.setTimer An unref'd timer.
 * @param {(timer: NodeJS.Timeout) => void} params.clearTimer
 * @param {(keys: string[]) => void} params.onDue The due keys: the timer forgot them.
 * @param {number} [params.batchMs] The keys due within this time of the timer go with it.
 * @param {() => number} [params.now]
 * @returns {RateWakes}
 */
export declare function createRateWakes({ setTimer, clearTimer, onDue, batchMs, now }: {
    setTimer: (func: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer: (timer: NodeJS.Timeout) => void;
    onDue: (keys: string[]) => void;
    batchMs?: number;
    now?: () => number;
}): RateWakes;
