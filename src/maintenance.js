// The periodic work of a started process: the stall recovery with the sweep of the slots and of the rate keys, about
// every 30 s, and the cleanup of the finished jobs, every 5 minutes. See docs/design.md › Leases and stalls, Cleanup.
import { ANY_LANE } from './hint_channel.js';

const BATCH = 1000;

/**
 * @typedef {object} Maintenance
 * @property {() => void} start Arms the timers of the stall recovery and of the cleanup (with `cleanup`). Each runs
 *     again after it settles, while the runner is started, at a random time of its first interval.
 */

/**
 * @param {object} params
 * @param {import('./store/store.js').Store} params.store
 * @param {ReadonlyMap<string, import('./job_runs.js').RunningJob>} params.running The jobs that run in this process:
 *     never recovered here.
 * @param {{ leaseMs: number, recoveryIntervalMs: number, cleanupIntervalMs: number }} params.timings
 * @param {boolean} params.cleanup
 * @param {() => import('./runner.js').RunnerState} params.state
 * @param {(func: () => void, delayMs: number) => NodeJS.Timeout} params.setTimer An unref'd timer.
 * @param {(event: import('./types.js').SqlaneEvent) => void} params.emit
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @param {(key: string, delayMs: number) => void} params.armRateWake The timer of a rate key with blocked jobs.
 * @param {() => void} params.wake A wake of all lanes of this process.
 * @param {import('./hint_channel.js').HintChannel} params.hintChannel
 * @returns {Maintenance}
 */
export function createMaintenance({
    store,
    running,
    timings: t,
    cleanup,
    state,
    setTimer,
    emit,
    reportError,
    armRateWake,
    wake,
    hintChannel,
}) {
    /**
     * A timer that runs func again after it settles, while the runner is started.
     * @param {string} operation
     * @param {() => Promise<unknown>} func
     * @param {number} intervalMs
     */
    function every(operation, func, intervalMs) {
        const run = async () => {
            if (state() !== 'started') {
                return;
            }

            try {
                await func();
            } catch (error) {
                reportError(operation, error);
            }

            setTimer(run, intervalMs * (0.9 + (Math.random() * 0.2)));
        };

        setTimer(run, intervalMs * Math.random());
    }

    async function recoverStaleJobs() {
        const ownIds = new Set([...running.values()].map(job => job.claimed.id));
        // One read: the stale jobs, and the parts of the sweeps with work. An idle recovery ends with it
        const work = await store.findRecoveryWork(100);
        let freedKeys = false;

        for (const { id, lane } of work.stale) {
            if (state() !== 'started' || ownIds.has(id)) {
                continue;
            }

            // Past its maxStalls too: its next claim fails it, in a process that adds its lane
            // oxlint-disable-next-line no-await-in-loop -- small batches, one job per transaction
            const recovered = await store.recoverStaleJob(id, { leaseMs: t.leaseMs });

            if (recovered.result === 'released') {
                freedKeys = true;
                emit({ type: 'stalled', jobId: id, lane, attempt: recovered.attempt });
            }
        }

        const { lingers, orphans, unblocked, rateWaits } = await store.sweepSlots(100, work);

        // The rate keys whose timer was lost: this process takes it over
        for (const { key, delayMs } of rateWaits) {
            armRateWake(key, delayMs);
        }

        if (freedKeys || lingers || orphans || unblocked) {
            wake();
            hintChannel.publish(ANY_LANE);
        }

        // oxlint-disable-next-line no-unmodified-loop-condition -- close() changes state
        for (let deleted = work.idleRateKeys ? BATCH : 0; deleted >= BATCH && state() === 'started';) {
            // oxlint-disable-next-line no-await-in-loop -- batches one after the other
            deleted = await store.deleteIdleRateKeys(BATCH);
        }
    }

    async function deleteExpiredJobs() {
        // oxlint-disable-next-line no-unmodified-loop-condition -- close() changes state
        for (let deleted = BATCH; deleted >= BATCH && state() === 'started';) {
            // oxlint-disable-next-line no-await-in-loop -- batches one after the other
            deleted = await store.deleteExpiredJobs(BATCH);
        }
    }

    return {
        start: () => {
            every('recover_stale_jobs', recoverStaleJobs, t.recoveryIntervalMs);

            if (cleanup) {
                every('delete_expired_jobs', deleteExpiredJobs, t.cleanupIntervalMs);
            }
        },
    };
}
