// The run of a claimed job in this process: its handler, its timeout, then the write of its result (complete, retry,
// fail, wait for a rate limit, or release) and its event. See docs/design.md › Leases and stalls, Rate limits.
import { setTimeout as sleep } from 'node:timers/promises';
import { getBackoffMs } from './backoff.js';
import { parseDuration } from './duration.js';
import { toErrorJson } from './error_json.js';
import { FatalJobError, JobTimeoutError, MissingPayloadError, RateLimitedError, RetryJobError } from './errors.js';
import { nowUs, pauseRate } from './local_rates.js';
import { parseRateKey, rateKeyOf } from './rate_limit_shape.js';
import { scheduledAtOf } from './schedule.js';

/** @typedef {import('./store/store.js').ClaimedJob} ClaimedJob */
/** @typedef {import('./registry.js').HandlerEntry} HandlerEntry */

/** The completed jobs of one write */
const MAX_COMPLETE_BATCH = 100;

/**
 * @typedef {object} RunningJob
 * @property {string} key
 * @property {ClaimedJob} claimed
 * @property {HandlerEntry} entry
 * @property {AbortController} controller
 * @property {Promise<void>} done Resolves when the result is written (or given up).
 * @property {boolean} settled The handler settled.
 * @property {boolean} released Released or abandoned on close: the result is not written.
 * @property {boolean} timedOut
 * @property {boolean} leaseLost
 * @property {boolean} completionConfirmed The completion batch changed every owned row.
 * @property {number} leaseEndsAt
 * @property {number} startedAt
 */

/**
 * @typedef {object} JobRuns
 * @property {(job: RunningJob, payload: { found: boolean, payload: unknown }) => Promise<void>} runJob Runs the
 *     handler, then writes the result, retried while the lease is renewed. Nothing for a job released or with its lease
 *     lost. Counts the result in `counts`, and emits its event.
 */

/**
 * Waits for the promise, at most `ms`. The timer ends with the wait: it keeps no process alive after it.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @param {{ ref?: boolean }} [options] `ref: false`: the timer alone does not keep the process alive.
 * @returns {Promise<void>}
 */
export async function waitAtMost(promise, ms, { ref = true } = {}) {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;

    try {
        // A plain timer, cleared: an aborted sleep would build an error at each wait
        await Promise.race([promise, new Promise((resolve) => {
            timer = setTimeout(resolve, Math.max(ms, 0));

            if (!ref) {
                timer.unref();
            }
        })]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @param {RunningJob} job
 * @returns {import('./types.js').HandlerContext}
 */
function contextOf(job) {
    const { claimed } = job;

    return {
        payload: undefined,
        job: {
            id: claimed.id,
            lane: claimed.lane,
            attempt: claimed.attempts + 1,
            maxAttempts: claimed.maxAttempts,
            enqueuedAt: claimed.enqueuedAt,
            globalConcurrencyLimits: claimed.limits,
            scheduledAt: scheduledAtOf(claimed.id),
            runAt: claimed.runAt,
            startedAt: claimed.startedAt,
        },
        signal: job.controller.signal,
    };
}

/**
 * @param {object} params
 * @param {import('./store/store.js').Store} params.store
 * @param {import('./defaults.js').ResolvedDefaults} params.defaults
 * @param {import('./types.js').Logger | undefined} params.logger
 * @param {(event: import('./types.js').SqlaneEvent) => void} params.emit
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @param {{ completed: number, retried: number, failed: number }} params.counts The results, counted for drain().
 * @param {{ leaseMs: number, maxFinalizingMs: number, missingPayloadGraceMs: number }} params.timings
 * @param {() => import('./runner.js').RunnerState} params.state
 * @param {import('./failure_lanes.js').FailureLanes} params.failureLanes
 * @param {(key: string, delayMs: number) => void} params.armRateWake The timer of a rate key with a job blocked on it.
 * @param {(entry: HandlerEntry) => void} params.wakeAfterRates Its local rate limits that admit no start now: a wake of
 *     their lanes when one may start.
 * @param {import('./hint_channel.js').HintChannel} params.hintChannel
 * @returns {JobRuns}
 */
export function createJobRuns({
    store,
    defaults,
    logger,
    emit,
    reportError,
    counts,
    timings: t,
    state,
    failureLanes,
    armRateWake,
    wakeAfterRates,
    hintChannel,
}) {
    /** @type {{ job: import('./store/store.js').FinishedJob, written: PromiseWithResolvers<boolean> }[]} */
    let toComplete = [];
    let completing = false;

    /**
     * Completes the job in the next write. One write at a time: the jobs that finish during a write go together in the
     * next one, in one transaction. The first write waits for the jobs that finish in the same turn of the event loop
     * (the jobs of one claim, with short handlers): one commit for them, and their slots free together for one claim.
     * @param {import('./store/store.js').FinishedJob} job
     * @returns {Promise<boolean>} Every job in its batch was completed. Rejects with the error of its write.
     */
    function completeJob(job) {
        /** @type {PromiseWithResolvers<boolean>} */
        const written = Promise.withResolvers();

        toComplete.push({ job, written });

        if (!completing) {
            completing = true;
            setImmediate(() => void writeCompletions());
        }

        return written.promise;
    }

    async function writeCompletions() {
        while (toComplete.length) {
            const batch = toComplete.slice(0, MAX_COMPLETE_BATCH);

            toComplete = toComplete.slice(MAX_COMPLETE_BATCH);

            try {
                // In the order of the ids: the row locks of two writes come in one order
                // oxlint-disable-next-line no-await-in-loop -- one write at a time
                const changed = await store.completeJobs(
                    batch.map(entry => entry.job).toSorted((a, b) => (a.id < b.id ? -1 : 1)),
                );

                for (const { written } of batch) {
                    // The count cannot identify stale entries in a partial batch: keep all their wakes.
                    written.resolve(changed === batch.length);
                }
            } catch (error) {
                for (const { written } of batch) {
                    written.reject(error);
                }
            }
        }

        completing = false;
    }

    /**
     * Runs a write of the result until it succeeds; on errors, it retries with a backoff while the lease is renewed.
     * @param {RunningJob} job
     * @param {() => Promise<unknown>} write
     * @returns {Promise<void>}
     */
    async function writeResult(job, write) {
        const since = Date.now();

        for (let attempt = 0; ; attempt++) {
            try {
                // oxlint-disable-next-line no-await-in-loop -- a retry waits for the previous try
                await write();

                return;
            } catch (error) {
                reportError('write_result', error);

                if (Date.now() - since >= t.maxFinalizingMs || job.released || state() === 'closed') {
                    // The lease ends, and the stall recovery takes the job.
                    return;
                }

                // oxlint-disable-next-line no-await-in-loop -- a retry waits for the previous try
                await sleep(Math.min(100 * (2 ** attempt), 2000));
            }
        }
    }

    /**
     * @param {RunningJob} job
     * @param {unknown} error Null: the handler succeeded.
     * @returns {Promise<void>}
     */
    async function finalize(job, error) {
        const { claimed } = job;
        const base = { jobId: claimed.id, lane: claimed.lane, attempt: claimed.attempts + 1 };
        const durationMs = Date.now() - job.startedAt;

        if (error === null && !job.timedOut) {
            await writeResult(job, async () => {
                job.completionConfirmed = await completeJob(claimed);
            });
            counts.completed++;
            emit({ type: 'completed', ...base, durationMs });

            return;
        }

        if (error instanceof RateLimitedError && await waitForRate(job, error, durationMs)) {
            return;
        }

        const fatal = error instanceof FatalJobError || error instanceof MissingPayloadError;
        const attemptsLeft = claimed.attempts + 1 < claimed.maxAttempts;

        if (!fatal && attemptsLeft) {
            const delayMs = retryDelayMs(job, error);

            await writeResult(job, () => store.retryJob(claimed, { delayMs, error: toErrorJson(error) }));
            counts.retried++;
            emit({ type: 'retried', ...base, durationMs, delayMs, error });

            return;
        }

        logger?.error({ error, jobId: claimed.id, lane: claimed.lane }, 'sqlane: job failed');
        await writeResult(job, async () => {
            const { failureResult } = await store.failJob(claimed, {
                error: toErrorJson(error),
                buildFailureJob: failureLanes.build,
            });

            failureLanes.report(
                { id: claimed.id, lane: claimed.lane, attempt: base.attempt, failureLane: claimed.failureLane },
                failureResult,
            );
        });
        counts.failed++;
        emit({ type: 'failed', ...base, durationMs, error });
    }

    /**
     * @param {RunningJob} job
     * @param {unknown} error Of a failed attempt that is retried.
     * @returns {number} The delay of a RetryJobError, or the `retryAfter` of a RateLimitedError on no rate limit of
     *     the job; else the backoff.
     */
    function retryDelayMs(job, error) {
        const backoffMs = getBackoffMs(job.entry.definition?.backoff ?? defaults.backoff, job.claimed.attempts + 1);

        if (error instanceof RetryJobError) {
            return parseDuration(error.delay) ?? backoffMs;
        }

        if (error instanceof RateLimitedError) {
            return parseDuration(error.retryAfter) ?? backoffMs;
        }

        return backoffMs;
    }

    /**
     * A RateLimitedError on rate limits of the job (`limit`, or all of them without it), without an attempt used: a
     * global key gets its next start at `retryAfter` from now at the earliest, and the job is blocked on it, its slots
     * freed; a local limit pauses in this process until then, and a job without a global key to wait on is pending
     * again at once, for any process.
     * @param {RunningJob} job
     * @param {RateLimitedError} error
     * @param {number} durationMs
     * @returns {Promise<boolean>} False: `limit` is not a rate limit of the job, or it has none.
     */
    async function waitForRate(job, error, durationMs) {
        const { claimed, entry } = job;
        const key = error.limit === undefined ? null : rateKeyOf(error.limit);
        const globalLimits = claimed.rateLimits.filter(limit => key === null || limit.key === key);
        const localRates = entry.rates.filter(rate => key === null || rate.settings.key === key);

        if (!globalLimits.length && !localRates.length) {
            return false;
        }

        // Checked by the constructor
        const retryAfterMs = parseDuration(error.retryAfter) ?? 0;
        const now = nowUs();
        let waitMs = retryAfterMs;

        for (const rate of localRates) {
            pauseRate(rate, now, retryAfterMs * 1000);
        }

        wakeAfterRates(entry);

        if (globalLimits.length) {
            await writeResult(job, async () => {
                const result = await store.rateLimited(claimed, {
                    limits: globalLimits,
                    retryAfterMs,
                    error: toErrorJson(error),
                });

                if (result.changed) {
                    // Blocked on its first key: the timer of this process unblocks it
                    armRateWake(globalLimits[0].key, result.delayMs);
                    waitMs = Math.max(waitMs, result.delayMs);
                }
            });
        } else {
            await writeResult(job, () => store.releaseJob(claimed, { delayMs: 0, lingerMs: 0 }));
            // The other processes may run it now
            hintChannel.publish(claimed.lane);
        }

        emit({
            type: 'rate_limited',
            jobId: claimed.id,
            lane: claimed.lane,
            attempt: claimed.attempts + 1,
            ...(globalLimits.length
                ? { ...parseRateKey(globalLimits[0].key), scope: 'global' }
                : { limit: localRates[0].limit.name, key: null, scope: 'local' }),
            retryAt: new Date(Date.now() + waitMs),
            durationMs,
            error,
        });

        return true;
    }

    /** @type {JobRuns['runJob']} */
    async function runJob(job, payload) {
        const { claimed, entry } = job;
        /** @type {unknown} */
        let error = null;

        if (!payload.found) {
            if (Date.now() - claimed.enqueuedAt.getTime() < t.missingPayloadGraceMs) {
                // Its payload can still be on the way (an enqueue outside a transaction)
                job.settled = true;
                await writeResult(job, () => store.releaseJob(claimed, { delayMs: 1000, lingerMs: 0 }));

                return;
            }

            error = new MissingPayloadError(`The payload of job "${claimed.id}" is missing`);
        } else if (claimed.limits.length && entry.timeoutMs === null) {
            error = new FatalJobError(
                'A job with global concurrency limits needs a timeout: set one in the definition or "defaults"',
            );
        } else {
            error = await runHandler(job, payload.payload);
        }

        job.settled = true;

        if (job.released || job.leaseLost) {
            return;
        }

        await finalize(job, error);
    }

    /**
     * @param {RunningJob} job
     * @param {unknown} payload
     * @returns {Promise<unknown>} The error, or null.
     */
    async function runHandler(job, payload) {
        const { entry } = job;
        const handlerDone = (async () => {
            try {
                await entry.handler({ ...contextOf(job), payload });

                return null;
            } catch (error) {
                return error ?? new Error('The handler threw no error object');
            }
        })();

        if (entry.timeoutMs === null) {
            return handlerDone;
        }

        /** @type {NodeJS.Timeout | undefined} */
        let timer;
        const timedOut = new Promise((resolve) => {
            timer = setTimeout(() => resolve('timeout'), entry.timeoutMs ?? 0);
        });
        const first = await Promise.race([handlerDone, timedOut]);

        clearTimeout(timer);

        if (first !== 'timeout') {
            return first;
        }

        const timeoutError = new JobTimeoutError(`The job timed out after ${entry.timeoutMs} ms`);

        job.timedOut = true;
        job.controller.abort(timeoutError);
        emit({
            type: 'timed_out',
            jobId: job.claimed.id,
            lane: job.claimed.lane,
            attempt: job.claimed.attempts + 1,
            durationMs: Date.now() - job.startedAt,
        });

        try {
            await store.markTimedOut(job.claimed);
        } catch (error) {
            reportError('mark_timed_out', error);
        }

        // The job keeps its keys and its slot until the handler settles, at most one more lease
        await waitAtMost(handlerDone, t.leaseMs, { ref: false });

        return timeoutError;
    }

    return { runJob };
}
