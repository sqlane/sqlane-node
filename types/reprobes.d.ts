export type Reprobes = {
    /**
     * An enqueue of the names: one series of re-probes, from the
     * last enqueue, of the names enqueued within its steps. Only the steps shorter than the poll interval count.
     */
    follow: (names: readonly string[]) => void;
};
/**
 * @typedef {object} Reprobes
 * @property {(names: readonly string[]) => void} follow An enqueue of the names: one series of re-probes, from the
 *     last enqueue, of the names enqueued within its steps. Only the steps shorter than the poll interval count.
 */
/**
 * @param {object} params
 * @param {number} params.pollIntervalMs
 * @param {() => import('./runner.js').RunnerState} params.state No re-probe unless started.
 * @param {(func: () => void, delayMs: number) => NodeJS.Timeout} params.setTimer An unref'd timer.
 * @param {(timer: NodeJS.Timeout) => void} params.clearTimer
 * @param {(names: string[]) => void} params.wake A speculative wake of the names: a probe first.
 * @returns {Reprobes}
 */
export declare function createReprobes({ pollIntervalMs, state, setTimer, clearTimer, wake }: {
    pollIntervalMs: number;
    state: () => import('./runner.js').RunnerState;
    setTimer: (func: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer: (timer: NodeJS.Timeout) => void;
    wake: (names: string[]) => void;
}): Reprobes;
