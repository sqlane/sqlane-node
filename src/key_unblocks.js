// The unblocks of the jobs blocked on keys: on a concurrency key after a release or a claim that blocked jobs, on a
// rate key by the timer of the process that blocked them. See docs/design.md › Global limits, Rate limits.
import { createRateWakes } from './rate_wakes.js';

/** A failed unblock of rate keys: again after this */
const RATE_UNBLOCK_RETRY_MS = 1000;

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
export function createKeyUnblocks({ store, state, setTimer, clearTimer, wake, hintChannel, reportError }) {
    /** The unblocks of rate keys that run: their keys left the timer, their jobs are not pending yet */
    let rateUnblocks = 0;
    /** @type {Set<Promise<void>>} The same: close() waits for them */
    const rateUnblocksRunning = new Set();
    /** @type {Set<string>} The rate keys whose timer fired while idle (after a drain()): the next start() or drain()
     *     unblocks them */
    const idleRateKeys = new Set();
    /** @type {Map<string, { debtUs: number, atMs: number }>} Of each rate key, its debt after the jobs that the last
     *     unblock here made pending, and when: the next unblock counts them, until the claims take their quota */
    const rateFloors = new Map();
    /** The timer of the rate keys on which this process blocked jobs: an unblock when their next start is due */
    const rateWakes = createRateWakes({
        setTimer,
        clearTimer,
        onDue: (keys) => {
            void runRateUnblock(keys);
        },
    });
    /** The checks of the rate keys whose last unblock left no blocked job: a job blocked during it (gcra.js,
     * `nextUnblockMs`). drain() does not wait for them */
    const rateRechecks = createRateWakes({
        setTimer,
        clearTimer,
        onDue: (keys) => {
            void runRateUnblock(keys);
        },
    });

    /**
     * Arms the timer of a rate key, unless the process closes: its timers are cleared, and fire no unblock.
     * @param {string} key
     * @param {number} delayMs
     * @param {import('./rate_wakes.js').RateWakes} [wakes] Default: the next starts, not the checks.
     */
    function armRateWake(key, delayMs, wakes = rateWakes) {
        const now = state();

        if (now !== 'closing' && now !== 'closed') {
            wakes.arm(key, delayMs);
        }
    }

    /**
     * @param {string[]} keys
     * @returns {Promise<void>} Never rejects.
     */
    async function runRateUnblock(keys) {
        const unblocking = unblockRateKeys(keys);

        rateUnblocksRunning.add(unblocking);

        try {
            await unblocking;
        } finally {
            rateUnblocksRunning.delete(unblocking);
        }
    }

    /** @param {string[]} names The names of the jobs that an unblock made pending. */
    function wakeUnblocked(names) {
        if (names.length) {
            wake(names);

            for (const name of names) {
                hintChannel.publish(name);
            }
        }
    }

    /** @type {KeyUnblocks['unblockKeys']} */
    async function unblockKeys(keys) {
        try {
            wakeUnblocked(await store.unblock([...new Set(keys)]));
        } catch (error) {
            reportError('unblock', error);
        }
    }

    /**
     * Makes the jobs blocked on the rate keys pending again, as far as their quota allows now, and wakes their names
     * here and in the other processes. The timer of the keys calls it; the keys with blocked jobs left get their next
     * time. The jobs that the last unblock of a key made pending count, as if they started then (`rateFloors`): without
     * them, an unblock right after another one (a full batch) would make the same quota pending again.
     * @param {string[]} keys
     * @returns {Promise<void>} Never rejects: an error is reported, and the keys are tried again in 1 s.
     */
    async function unblockRateKeys(keys) {
        const now = state();

        if (now === 'idle') {
            // After a drain(): the next start() or drain() unblocks them
            for (const key of keys) {
                idleRateKeys.add(key);
            }

            return;
        }

        if (now !== 'started' && now !== 'draining') {
            // Closing: the sweep of another process takes them
            return;
        }

        rateUnblocks++;

        try {
            const { names, waits } = await store.unblockRates(keys, floorsOf(keys));
            const atMs = Date.now();
            const withWaits = new Set(waits.map(wait => wait.key));

            for (const key of keys.filter(each => !withWaits.has(each))) {
                // No blocked job left
                rateFloors.delete(key);
            }

            for (const { key, delayMs, debtUs, left } of waits) {
                if (debtUs !== null) {
                    rateFloors.set(key, { debtUs, atMs });
                }

                armRateWake(key, delayMs, left ? rateWakes : rateRechecks);
            }

            wakeUnblocked(names);
        } catch (error) {
            reportError('unblock', error);

            for (const key of keys) {
                armRateWake(key, RATE_UNBLOCK_RETRY_MS);
            }
        } finally {
            rateUnblocks--;
        }
    }

    /**
     * @param {string[]} keys
     * @returns {Map<string, number>} The debt of the keys after the jobs that their last unblock here made pending, as
     *     if they started then: less by the time since.
     */
    function floorsOf(keys) {
        const now = Date.now();
        /** @type {Map<string, number>} */
        const floors = new Map();

        for (const key of keys) {
            const floor = rateFloors.get(key);
            const debtUs = floor ? floor.debtUs - ((now - floor.atMs) * 1000) : 0;

            if (debtUs > 0) {
                floors.set(key, debtUs);
            } else {
                rateFloors.delete(key);
            }
        }

        return floors;
    }

    return {
        unblockKeys,
        armRateWake: (key, delayMs) => armRateWake(key, delayMs),
        resume: () => {
            for (const key of idleRateKeys) {
                rateWakes.arm(key, 0);
            }

            idleRateKeys.clear();
        },
        busy: () => rateUnblocks > 0,
        dueBefore: at => rateWakes.dueBefore(at),
        settled: () => Promise.allSettled(rateUnblocksRunning),
        clear: () => {
            rateWakes.clear();
            rateRechecks.clear();
            rateFloors.clear();
            idleRateKeys.clear();
        },
    };
}
