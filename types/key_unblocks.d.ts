export type KeyUnblocks = {
    /**
     * Makes the jobs blocked on the concurrency keys
     * pending again, as far as the keys have room, and wakes their names here and in the other processes. It runs after
     * the commit of a release, and after the commit of a claim that blocked jobs: the later of the two sees both, so a
     * job is not left blocked on a key with room. Never rejects: an error is reported.
     */
    unblockKeys: (keys: readonly string[]) => Promise<void>;
    /**
     * Arms the timer of a rate key on which this process
     * blocked jobs: an unblock when their next start is due. Not while the process closes: its timers are cleared, and
     * fire no unblock.
     */
    armRateWake: (key: string, delayMs: number) => void;
    /**
     * Arms the rate keys whose timer fired while idle (after a drain()): at once. For start()
     * and drain().
     */
    resume: () => void;
    /**
     * An unblock of rate keys runs: its keys left the timer, its jobs are not pending yet.
     */
    busy: () => boolean;
    /**
     * The timer of a rate key is due before the time. Not the checks after
     * the last unblock of a key: drain() does not wait for them.
     */
    dueBefore: (at: number) => boolean;
    /**
     * Settles when the unblocks of rate keys that run now have settled.
     */
    settled: () => Promise<unknown>;
    /**
     * Forgets the keys, and stops the timers. For close(), after `settled()`.
     */
    clear: () => void;
};
/**
 * @typedef {object} KeyUnblocks
 * @property {(keys: readonly string[]) => Promise<void>} unblockKeys Makes the jobs blocked on the concurrency keys
 *     pending again, as far as the keys have room, and wakes their names here and in the other processes. It runs after
 *     the commit of a release, and after the commit of a claim that blocked jobs: the later of the two sees both, so a
 *     job is not left blocked on a key with room. Never rejects: an error is reported.
 * @property {(key: string, delayMs: number) => void} armRateWake Arms the timer of a rate key on which this process
 *     blocked jobs: an unblock when their next start is due. Not while the process closes: its timers are cleared, and
 *     fire no unblock.
 * @property {() => void} resume Arms the rate keys whose timer fired while idle (after a drain()): at once. For start()
 *     and drain().
 * @property {() => boolean} busy An unblock of rate keys runs: its keys left the timer, its jobs are not pending yet.
 * @property {(at: number) => boolean} dueBefore The timer of a rate key is due before the time. Not the checks after
 *     the last unblock of a key: drain() does not wait for them.
 * @property {() => Promise<unknown>} settled Settles when the unblocks of rate keys that run now have settled.
 * @property {() => void} clear Forgets the keys, and stops the timers. For close(), after `settled()`.
 */
/**
 * @param {object} params
 * @param {import('./store/store.js').Store} params.store
 * @param {() => import('./runner.js').RunnerState} params.state
 * @param {(func: () => void, delayMs: number) => NodeJS.Timeout} params.setTimer An unref'd timer.
 * @param {(timer: NodeJS.Timeout) => void} params.clearTimer
 * @param {(names: string[]) => void} params.wake A wake of the names of this process: their jobs are due.
 * @param {import('./hint_channel.js').HintChannel} params.hintChannel
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @returns {KeyUnblocks}
 */
export declare function createKeyUnblocks({ store, state, setTimer, clearTimer, wake, hintChannel, reportError }: {
    store: import('./store/store.js').Store;
    state: () => import('./runner.js').RunnerState;
    setTimer: (func: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer: (timer: NodeJS.Timeout) => void;
    wake: (names: string[]) => void;
    hintChannel: import('./hint_channel.js').HintChannel;
    reportError: (operation: string, error: unknown) => void;
}): KeyUnblocks;
