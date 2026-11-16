// The leases of the jobs that run in this process: renewed in one statement about every 30 s while handlers run, and
// lost when a renewal does not come in time. See docs/design.md › Leases and stalls.
import { setTimeout as sleep } from 'node:timers/promises';
import { LeaseLostError } from './errors.js';

/** @typedef {import('./job_runs.js').RunningJob} RunningJob */

/**
 * @typedef {object} Leases
 * @property {() => void} keepRenewing Renews the leases while handlers run: also while close() waits for them and
 *     during drain(), not only when started. The timer stops when no handler runs; the next claimed job starts it
 *     again.
 */

/**
 * @param {object} params
 * @param {import('./store/store.js').Store} params.store
 * @param {ReadonlyMap<string, RunningJob>} params.running The jobs that run in this process.
 * @param {{ leaseMs: number, renewIntervalMs: number }} params.timings
 * @param {() => import('./runner.js').RunnerState} params.state
 * @param {(func: () => void, delayMs: number) => NodeJS.Timeout} params.setTimer An unref'd timer.
 * @param {(event: import('./types.js').SqlaneEvent) => void} params.emit
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @returns {Leases}
 */
export function createLeases({ store, running, timings: t, state, setTimer, emit, reportError }) {
    /** How long a renewal of the leases is waited for: a later one counts as failed */
    const renewWaitMs = t.renewIntervalMs;
    /** The most time between two checks of the leases: the jitter of the timer (× 1.1), then the wait of a renewal */
    const maxRenewGapMs = (1.1 * t.renewIntervalMs) + renewWaitMs;
    /** A renewal of the leases waits for the store */
    let renewing = false;
    /** The renewal timer runs: while handlers run, in every state but closed */
    let renewalTimerOn = false;

    /**
     * A job whose lease is not renewed `renewIntervalMs` before it ends loses it: another process may take the job
     * after. The next check can come too late for that (see `maxRenewGapMs`): a timer then checks at that time.
     * @param {RunningJob} job
     */
    function checkLease(job) {
        if (job.released || job.leaseLost || running.get(job.key) !== job) {
            return;
        }

        const lostInMs = job.leaseEndsAt - t.renewIntervalMs - Date.now();

        if (lostInMs > 0) {
            if (lostInMs <= maxRenewGapMs) {
                setTimer(() => checkLease(job), lostInMs);
            }

            return;
        }

        job.leaseLost = true;
        job.controller.abort(new LeaseLostError(`The lease of job "${job.claimed.id}" was lost`));
        emit({
            type: 'lease_lost',
            jobId: job.claimed.id,
            jobName: job.claimed.name,
            attempt: job.claimed.attempts + 1,
        });
    }

    /** @returns {boolean} No lease to renew. A function: the state changes while a renewal waits. */
    function renewalStops() {
        return state() === 'closed' || running.size === 0;
    }

    /** @type {Leases['keepRenewing']} */
    function keepRenewing() {
        if (renewalTimerOn) {
            return;
        }

        renewalTimerOn = true;

        const run = async () => {
            if (renewalStops()) {
                renewalTimerOn = false;

                return;
            }

            try {
                await renewLeases();
            } catch (error) {
                reportError('renew_leases', error);
            }

            if (renewalStops()) {
                renewalTimerOn = false;

                return;
            }

            setTimer(run, t.renewIntervalMs * (0.9 + (Math.random() * 0.2)));
        };

        setTimer(run, t.renewIntervalMs * (0.9 + (Math.random() * 0.2)));
    }

    async function renewLeases() {
        const jobs = [...running.values()].filter(job => !job.released && !job.leaseLost);

        if (!jobs.length) {
            return;
        }

        const renewedAt = Date.now();
        /** @type {Set<string> | null} */
        let renewed = null;

        // A renewal that still waits (a pool with no free connection) is not started again: its result is dropped
        if (!renewing) {
            const controller = new AbortController();

            try {
                renewing = true;

                const renewal = (async () => {
                    try {
                        return await store.renewLeases(jobs.map(job => job.claimed), t.leaseMs);
                    } finally {
                        renewing = false;
                    }
                })();

                // The race handles the rejections of the renewal and of the aborted timer
                renewed = await Promise.race([
                    renewal,
                    sleep(renewWaitMs, null, { signal: controller.signal, ref: false }),
                ]);

                if (!renewed) {
                    reportError('renew_leases', new Error(`The renewal of the leases took more than ${renewWaitMs} ms`));
                }
            } catch (error) {
                reportError('renew_leases', error);
            } finally {
                controller.abort();
            }
        }

        for (const job of jobs) {
            if (renewed?.has(job.claimed.id) && !job.leaseLost) {
                job.leaseEndsAt = renewedAt + t.leaseMs;
            } else {
                // Not renewed: it throws, it hangs, or the job is not this process's any more
                checkLease(job);
            }
        }
    }

    return { keepRenewing };
}
