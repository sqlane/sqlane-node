// The runner of an instance: the dispatcher loop, the handlers, the timers, close() and drain().
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMonotonicUlid } from './ulid.js';
import { getBackoffMs } from './backoff.js';
import { parseDuration } from './duration.js';
import { toErrorJson } from './error_json.js';
import {
    ClosedError,
    ConfigError,
    DrainTimeoutError,
    FatalJobError,
    InvalidOptionsError,
    JobTimeoutError,
    LeaseLostError,
    MissingPayloadError,
    RetryJobError,
    ShutdownError,
} from './errors.js';
import { ANY_NAME, KEY_PREFIX } from './hint_channel.js';
import { buildNewJob } from './new_job.js';
import { isTransientDbError } from './transient_error.js';

/** @typedef {import('./store/store.js').ClaimedJob} ClaimedJob */
/** @typedef {import('./registry.js').HandlerEntry} HandlerEntry */
/** @typedef {import('./registry.js').Lane} Lane */

/**
 * @typedef {object} Timings
 * @property {number} leaseMs
 * @property {number} renewIntervalMs
 * @property {number} recoveryIntervalMs
 * @property {number} cleanupIntervalMs
 * @property {number} pollIntervalMs
 * @property {number} maxFinalizingMs How long a failed write of a result is retried.
 * @property {number} missingPayloadGraceMs A job without its payload waits this long for it.
 */

/** @type {Timings} */
export const DEFAULT_TIMINGS = {
    leaseMs: 240_000,
    renewIntervalMs: 30_000,
    recoveryIntervalMs: 30_000,
    cleanupIntervalMs: 300_000,
    pollIntervalMs: 5000,
    maxFinalizingMs: 600_000,
    missingPayloadGraceMs: 60_000,
};

/** The wakes after the last enqueue (or hint), until its commit makes the job visible */
const REPROBE_DELAYS_MS = [20, 50, 100, 200, 500, 1000, 2000];
const RELEASE_EXTRA_DELAY_MS = 2000;
/**
 * A claim of names without mutex keys requests at most this many names per free process slot: a claim locks up to the
 * free slots of each name it requests, and reads their next due times. More due names take turns.
 */
const CLAIM_NAMES_PER_SLOT = 4;
const STALLED = { name: 'StalledError', message: 'The lease of the job ended: its process stopped or blocked' };
const BATCH = 1000;
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
 * @typedef {object} RunnerParams
 * @property {import('./store/store.js').Store} store
 * @property {import('./registry.js').Registry} registry
 * @property {number} concurrency
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {boolean} cleanup
 * @property {import('./types.js').Logger | undefined} logger
 * @property {((event: import('./types.js').SqlaneEvent) => void) | undefined} onEvent
 * @property {import('./hint_channel.js').HintChannel} hintChannel
 * @property {boolean} hintsAfterCommit The hints come after the commit of their enqueue (PostgreSQL NOTIFY): they wake
 *     at once, with no re-probes.
 * @property {Partial<Timings>} [timings] For tests.
 */

/**
 * @typedef {object} Runner
 * @property {() => Promise<void>} start
 * @property {(options?: import('./types.js').DrainOptions) => Promise<import('./types.js').DrainResult>} drain
 * @property {(options?: import('./types.js').CloseOptions) => Promise<void>} close
 * @property {() => void} wake
 * @property {(names: string[]) => void} onEnqueued An enqueue: its commit is to come.
 * @property {(names: string[]) => void} onCommitted An enqueue committed: wakes at once, then re-probes.
 * @property {() => boolean} isClosed
 * @property {() => boolean} isStarted
 * @property {(name: string) => boolean} canStartNow This process handles the name and has a free slot for it.
 */

/**
 * Waits for the promise, at most `ms`. The timer ends with the wait: it keeps no process alive after it.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @param {{ ref?: boolean }} [options] `ref: false`: the timer alone does not keep the process alive.
 * @returns {Promise<void>}
 */
async function waitAtMost(promise, ms, { ref = true } = {}) {
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
            name: claimed.name,
            attempt: claimed.attempts + 1,
            maxAttempts: claimed.maxAttempts,
            enqueuedAt: claimed.enqueuedAt,
            mutexKeys: claimed.mutexKeys,
        },
        signal: job.controller.signal,
    };
}

/**
 * @param {RunnerParams} params
 * @returns {Runner}
 */
export function createRunner({
    store,
    registry,
    concurrency,
    defaults,
    cleanup,
    logger,
    onEvent,
    hintChannel,
    hintsAfterCommit,
    timings = {},
}) {
    const t = { ...DEFAULT_TIMINGS, ...timings };
    /** How long a renewal of the leases is waited for: a later one counts as failed */
    const renewWaitMs = t.renewIntervalMs;
    /** The most time between two checks of the leases: the jitter of the timer (× 1.1), then the wait of a renewal */
    const maxRenewGapMs = (1.1 * t.renewIntervalMs) + renewWaitMs;
    /** A renewal of the leases waits for the store */
    let renewing = false;
    /** The renewal timer runs: while handlers run, in every state but closed */
    let renewalTimerOn = false;
    const lockedBy = `${hostname()}:${process.pid}:${createMonotonicUlid()()}`;
    const lockToken = createMonotonicUlid();
    /** @type {'idle' | 'started' | 'draining' | 'closing' | 'closed'} */
    let state = 'idle';
    /** @type {Map<string, RunningJob>} */
    const running = new Map();
    let wakeCount = 0;
    /** A wake of all names since the last turn: the next turn probes all names */
    let wakeAll = true;
    /** @type {Set<string>} The names of the wakes since the last turn whose jobs are visible: claimed at once */
    const wakeNames = new Set();
    /** @type {Set<string>} The names of the wakes since the last turn that may have no visible job: probed first */
    const wakeProbeNames = new Set();
    /** @type {Set<string>} The mutex keys released since the last turn: the jobs that wait for them can start */
    const wakeKeys = new Set();
    /** @type {Set<string>} The names whose last probe saw due jobs: probed again at each turn, until none is due */
    const backlog = new Set();
    /** @type {Map<string, number>} The next due time of the names with only future pending jobs, by the probes */
    const scheduled = new Map();
    /** The earliest time of `scheduled`; null: to compute again */
    let earliestScheduled = /** @type {number | null} */ (Infinity);
    /** @type {Set<string>} The handled names whose definition has mutex keys: set by start() */
    let namesWithKeys = new Set();
    /** The time of the next probe of all names: the poll */
    let fullProbeAt = 0;
    /** @type {Map<string, number>} The names of the enqueues of the current series of re-probes: their last enqueue */
    const reprobeNames = new Map();
    /** @type {(() => void) | null} */
    let endSleep = null;
    /** @type {Promise<void> | null} */
    let loopDone = null;
    /** @type {Promise<void> | null} */
    let closeDone = null;
    /** @type {Set<NodeJS.Timeout>} */
    const timers = new Set();
    /** The time of the last enqueue (or hint): the re-probes follow it */
    let reprobeFrom = 0;
    /** @type {{ timer: NodeJS.Timeout, at: number } | null} The next re-probe */
    let reprobe = null;
    let contentionDelayMs = 0;
    /** Where the next turn of due names starts, when they are more than a claim requests */
    let claimTurn = 0;
    /** The last claim left due names out: the next turn runs at once, for them */
    let namesLeftOut = false;
    let claimsInFlight = 0;
    const counts = { completed: 0, retried: 0, failed: 0 };
    /** @type {{ job: import('./store/store.js').FinishedJob, written: PromiseWithResolvers<boolean> }[]} */
    let toComplete = [];
    let completing = false;
    /** The jobs that finished: their results are written */
    let finishedCount = 0;

    // ---- events, logs, timers ----

    /** @param {import('./types.js').SqlaneEvent} event */
    function emit(event) {
        try {
            onEvent?.(event);
        } catch (error) {
            logger?.error({ error }, 'sqlane: onEvent threw');
        }
    }

    /**
     * @param {string} operation
     * @param {unknown} error
     */
    function reportError(operation, error) {
        logger?.error({ error, operation }, `sqlane: ${operation} failed`);
        emit({ type: 'error', operation, error });
    }

    /**
     * @param {() => void} func
     * @param {number} delayMs
     * @returns {NodeJS.Timeout}
     */
    function setTimer(func, delayMs) {
        const timer = setTimeout(() => {
            timers.delete(timer);
            func();
        }, delayMs);

        timer.unref();
        timers.add(timer);

        return timer;
    }

    /**
     * A timer that runs func again after it settles, while the runner is started.
     * @param {string} operation
     * @param {() => Promise<unknown>} func
     * @param {number} intervalMs
     */
    function every(operation, func, intervalMs) {
        const run = async () => {
            if (state !== 'started') {
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

    /**
     * Ends the sleep of the dispatcher. The next turn looks at the given names, or at all names.
     * @param {readonly string[]} [names] The names that may have ready jobs. None, or `*`: all names.
     * @param {{ speculative?: boolean }} [options] speculative: the jobs may not be visible yet, or there may be none
     *     (a claim on MySQL is a transaction of several statements): a probe first. Else the turn claims at once.
     */
    function wakeUp(names, { speculative = false } = {}) {
        if (!names || names.includes(ANY_NAME)) {
            wakeAll = true;
        } else {
            for (const name of names) {
                (speculative ? wakeProbeNames : wakeNames).add(name);
            }
        }

        wakeCount++;
        endSleep?.();
    }

    /**
     * Ends the sleep of the dispatcher after a release of mutex keys: the next turn looks at the names of the oldest
     * due job of each key.
     * @param {readonly string[]} keys
     */
    function wakeUpKeys(keys) {
        if (!namesWithKeys.size) {
            return;
        }

        for (const key of keys) {
            wakeKeys.add(key);
        }

        wakeCount++;
        endSleep?.();
    }

    /**
     * The names that the next turn looks at. Claimed at once: those of the certain wakes, of the backlog, and those
     * whose next due time came. Probed first: those of the speculative wakes. All names at a wake of all names, and
     * each poll interval.
     * Keys: the released mutex keys.
     * @returns {{ claim: Set<string>, probe: Set<string>, keys: Set<string> } | null} Null: all names.
     */
    function takeScope() {
        const now = Date.now();

        if (wakeAll || now >= fullProbeAt) {
            wakeAll = false;
            wakeNames.clear();
            wakeProbeNames.clear();
            wakeKeys.clear();

            return null;
        }

        const keys = new Set(wakeKeys);

        wakeKeys.clear();

        const claim = new Set([...wakeNames, ...backlog]);

        if (earliestDueTime() <= now) {
            for (const [name, at] of scheduled) {
                if (at <= now) {
                    claim.add(name);
                }
            }
        }

        const probe = new Set([...wakeProbeNames].filter(name => !claim.has(name)));

        wakeNames.clear();
        wakeProbeNames.clear();

        return { claim, probe, keys };
    }

    /**
     * @param {string} name
     * @param {number} at
     */
    function schedule(name, at) {
        scheduled.set(name, at);

        if (earliestScheduled !== null) {
            earliestScheduled = Math.min(earliestScheduled, at);
        }
    }

    /** @param {string} name */
    function unschedule(name) {
        const at = scheduled.get(name);

        if (at !== undefined) {
            scheduled.delete(name);

            if (at === earliestScheduled) {
                earliestScheduled = null;
            }
        }
    }

    /** @returns {number} The earliest next due time that the probes saw: Infinity for none. */
    function earliestDueTime() {
        if (earliestScheduled === null) {
            earliestScheduled = Infinity;

            for (const at of scheduled.values()) {
                earliestScheduled = Math.min(earliestScheduled, at);
            }
        }

        return earliestScheduled;
    }

    /** @returns {number} The delay until the next due time that a probe saw, or the next full probe. */
    function nextDelayMs() {
        return Math.max(0, Math.min(fullProbeAt, earliestDueTime()) - Date.now());
    }

    /**
     * Sleeps until the delay ends or a wake.
     * @param {number} delayMs
     * @param {number} seenWakes The wakes before the decision to sleep: a wake since then ends the sleep at once.
     * @returns {Promise<void>}
     */
    async function sleepUntilWake(delayMs, seenWakes) {
        if (wakeCount !== seenWakes || state !== 'started') {
            return;
        }

        // A plain timer: an aborted sleep would build an error at each wake
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, Math.max(delayMs, 0));

            endSleep = () => {
                clearTimeout(timer);
                resolve(undefined);
            };
        });
        endSleep = null;
    }

    // ---- slots ----

    /** @returns {number} */
    function freeProcessSlots() {
        return concurrency - running.size;
    }

    /**
     * @param {Lane} lane
     * @returns {number}
     */
    function freeSlots(lane) {
        return Math.max(0, Math.min(lane.concurrency - lane.running, freeProcessSlots()));
    }

    /**
     * Takes the locked jobs that fit the free slots and whose keys are free, oldest first. A passed-over job keeps its
     * keys from the newer ones.
     * @param {ClaimedJob[]} locked
     * @param {Set<string>} busyKeys
     * @returns {ClaimedJob[]}
     */
    function pick(locked, busyKeys) {
        /** @type {Map<Lane, number>} */
        const pickedByLane = new Map();
        const seenKeys = new Set(busyKeys);
        let picked = 0;

        return locked.filter((job) => {
            const entry = registry.getEntry(job.name);
            const keysFree = job.mutexKeys.every(key => !seenKeys.has(key));

            for (const key of job.mutexKeys) {
                seenKeys.add(key);
            }

            if (!entry || !keysFree) {
                return false;
            }

            const laneCount = pickedByLane.get(entry.lane) ?? 0;

            if (laneCount >= freeSlots(entry.lane) || picked >= freeProcessSlots()) {
                return false;
            }

            pickedByLane.set(entry.lane, laneCount + 1);
            picked++;

            return true;
        });
    }

    // ---- results ----

    /** @type {import('./store/store.js').FailureJobBuilder} */
    function buildFailureJob(failed) {
        const newJob = buildNewJob({
            name: failed.failureJob,
            definition: registry.findDefinition(failed.failureJob),
            defaults,
            payload: {
                job: {
                    id: failed.id,
                    name: failed.name,
                    payload: failed.payload,
                    attempt: failed.attempt,
                    maxAttempts: failed.maxAttempts,
                },
                error: failed.error,
            },
            options: undefined,
            maxPayloadBytes: Infinity,
        });

        return { ...newJob, failureJob: null };
    }

    /**
     * @param {{ id: string, name: string, attempt: number, failureJob: string | null }} job
     * @param {import('./store/store.js').FailureJobResult | null} result
     */
    function reportFailureJob(job, result) {
        if (result && 'notAdded' in result) {
            reportError('failure_job', result.notAdded);
            emit({
                type: 'failure_job_not_added',
                jobId: job.id,
                jobName: job.name,
                attempt: job.attempt,
                failureJob: String(job.failureJob),
                error: result.notAdded,
            });
        } else if (result && 'added' in result) {
            onEnqueued([result.added.name]);
            hintChannel.publish(result.added.name);
        }
    }

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

                if (Date.now() - since >= t.maxFinalizingMs || job.released || state === 'closed') {
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
        const base = { jobId: claimed.id, jobName: claimed.name, attempt: claimed.attempts + 1 };
        const durationMs = Date.now() - job.startedAt;

        if (error === null && !job.timedOut) {
            await writeResult(job, async () => {
                job.completionConfirmed = await completeJob(claimed);
            });
            counts.completed++;
            emit({ type: 'completed', ...base, durationMs });

            return;
        }

        const fatal = error instanceof FatalJobError || error instanceof MissingPayloadError;
        const attemptsLeft = claimed.attempts + 1 < claimed.maxAttempts;

        if (!fatal && attemptsLeft) {
            const backoff = job.entry.definition?.backoff ?? defaults.backoff;
            const delayMs = error instanceof RetryJobError
                ? parseDuration(error.delay) ?? getBackoffMs(backoff, claimed.attempts + 1)
                : getBackoffMs(backoff, claimed.attempts + 1);

            await writeResult(job, () => store.retryJob(claimed, { delayMs, error: toErrorJson(error) }));
            counts.retried++;
            emit({ type: 'retried', ...base, durationMs, delayMs, error });

            return;
        }

        logger?.error({ error, jobId: claimed.id, jobName: claimed.name }, 'sqlane: job failed');
        await writeResult(job, async () => {
            const { failureJob } = await store.failJob(claimed, { error: toErrorJson(error), buildFailureJob });

            reportFailureJob(
                { id: claimed.id, name: claimed.name, attempt: base.attempt, failureJob: claimed.failureJob },
                failureJob,
            );
        });
        counts.failed++;
        emit({ type: 'failed', ...base, durationMs, error });
    }

    /**
     * Runs the handler, then writes the result.
     * @param {RunningJob} job
     * @param {{ found: boolean, payload: unknown }} payload
     * @returns {Promise<void>}
     */
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
        } else if (claimed.mutexKeys.length && entry.timeoutMs === null) {
            error = new FatalJobError(
                'A job with mutex keys needs a timeout: set one in handle(), the definition or "defaults"',
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
            jobName: job.claimed.name,
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

    /**
     * @param {ClaimedJob} claimed
     * @param {{ found: boolean, payload: unknown }} payload
     */
    function startJob(claimed, payload) {
        const entry = /** @type {HandlerEntry} */ (registry.getEntry(claimed.name));
        /** @type {RunningJob} */
        const job = {
            key: `${claimed.id}\n${claimed.lockToken}`,
            claimed,
            entry,
            controller: new AbortController(),
            done: Promise.resolve(),
            settled: false,
            released: false,
            timedOut: false,
            leaseLost: false,
            completionConfirmed: false,
            leaseEndsAt: Date.now() + t.leaseMs,
            startedAt: Date.now(),
        };

        entry.lane.running++;
        running.set(job.key, job);
        keepRenewingLeases();
        emit({ type: 'claimed', jobId: claimed.id, jobName: claimed.name, attempt: claimed.attempts + 1 });
        job.done = (async () => {
            try {
                await runJob(job, payload);
            } catch (error) {
                reportError('run_job', error);
            } finally {
                // A successful keyless completion with spare capacity adds no ready work. The post-claim probe
                // already scheduled pending jobs. Claims in flight may have captured an older slot count.
                const mustWake = state !== 'started' || claimsInFlight > 0 || !job.completionConfirmed
                    || job.released || job.leaseLost || freeSlots(entry.lane) === 0;

                entry.lane.running--;
                running.delete(job.key);
                finishedCount++;

                if (mustWake) {
                    // Its own name, and the backlog
                    wakeUp([claimed.name], { speculative: true });
                }

                if (claimed.mutexKeys.length) {
                    // Its keys are free: the jobs that wait for them can start, here or elsewhere
                    wakeUpKeys(claimed.mutexKeys);

                    for (const key of claimed.mutexKeys) {
                        hintChannel.publish(KEY_PREFIX + key);
                    }
                }
            }
        })();
    }

    // ---- dispatch ----

    /**
     * Claims the due jobs of the given names that fit the free slots, and starts them.
     * @param {string[]} dueNames
     * @returns {Promise<{ candidates: number, claimed: number }>}
     */
    async function claimAndStart(dueNames) {
        claimsInFlight++;

        try {
            const plain = await claimAndStartPlain(dueNames.filter(name => !namesWithKeys.has(name)));
            const withKeys = await claimAndStartWithKeys(dueNames.filter(name => namesWithKeys.has(name)));

            return { candidates: plain.candidates + withKeys.candidates, claimed: plain.claimed + withKeys.claimed };
        } finally {
            claimsInFlight--;
        }
    }

    /**
     * The due jobs of names without mutex keys: found, claimed and read at once.
     * @param {string[]} dueNames
     * @returns {Promise<{ candidates: number, claimed: number }>}
     */
    async function claimAndStartPlain(dueNames) {
        /** @type {Lane[]} */
        const lanes = [];
        /** @type {import('./store/store.js').DueRequest[]} */
        const requests = [];

        for (const name of takeTurn(dueNames)) {
            const entry = registry.getEntry(name);
            const free = entry ? freeSlots(entry.lane) : 0;

            if (entry && free > 0) {
                const lane = lanes.includes(entry.lane) ? lanes.indexOf(entry.lane) : lanes.push(entry.lane) - 1;

                requests.push({ name, maxJobs: free, lane });
            }
        }

        if (!requests.length) {
            return { candidates: 0, claimed: 0 };
        }

        const { jobs, next } = await store.claimDue({
            requests,
            laneFree: lanes.map(lane => freeSlots(lane)),
            processMax: freeProcessSlots(),
            lockToken: lockToken(),
            lockedBy,
            leaseMs: t.leaseMs,
        });
        const requested = new Set(requests.map(request => request.name));
        const now = Date.now();
        let stillDue = 0;

        for (const name of requested) {
            unschedule(name);
            backlog.delete(name);
        }

        if (next === null) {
            // The claim filled the free slots, without reading the next due times: its names may have more due jobs
            for (const name of requested) {
                backlog.add(name);
            }
        }

        for (const row of next ?? []) {
            if (!requested.has(row.name)) {
                continue;
            }

            if (row.delayMs > 0) {
                schedule(row.name, now + row.delayMs);
            } else {
                // Due jobs left: over the free slots, or held by other claims
                backlog.add(row.name);
                stillDue++;
            }
        }

        for (const job of jobs) {
            startJob(job, job.payload);
        }

        // Names with due jobs left and none claimed: other processes hold them
        return { candidates: stillDue, claimed: jobs.length };
    }

    /**
     * The names of this turn: all of them, or, when they are many, the next ones in turn. The others stay in the
     * backlog, for the next turns.
     * @param {string[]} dueNames
     * @returns {string[]}
     */
    function takeTurn(dueNames) {
        const limit = CLAIM_NAMES_PER_SLOT * Math.max(freeProcessSlots(), 1);

        namesLeftOut = dueNames.length > limit;

        if (!namesLeftOut) {
            return dueNames;
        }

        const from = claimTurn % dueNames.length;
        const turn = [...dueNames.slice(from), ...dueNames.slice(0, from)].slice(0, limit);
        const inTurn = new Set(turn);

        claimTurn = from + limit;

        for (const name of dueNames) {
            if (!inTurn.has(name)) {
                backlog.add(name);
            }
        }

        return turn;
    }

    /**
     * The due jobs of names with mutex keys: candidates, then a claim of those whose keys are free.
     * @param {string[]} dueNames
     * @returns {Promise<{ candidates: number, claimed: number }>}
     */
    async function claimAndStartWithKeys(dueNames) {
        /** @type {Map<string, number>} */
        const limits = new Map();

        for (const name of dueNames) {
            const entry = registry.getEntry(name);
            const free = entry ? freeSlots(entry.lane) : 0;

            if (free > 0) {
                // 2 × the free slots: the processes woken together can take different rows
                limits.set(name, 2 * free);
            }
        }

        if (!limits.size) {
            return { candidates: 0, claimed: 0 };
        }

        const candidates = await store.findCandidates(limits, [...namesWithKeys]);
        const withCandidates = new Set(candidates.map(candidate => candidate.name));

        for (const name of limits.keys()) {
            if (!withCandidates.has(name)) {
                // Its due jobs wait for keys: the release of a key wakes it
                backlog.delete(name);
            }
        }

        if (!candidates.length) {
            return { candidates: 0, claimed: 0 };
        }

        const claimed = await store.claim({
            candidateIds: candidates.map(candidate => candidate.id),
            lockToken: lockToken(),
            lockedBy,
            leaseMs: t.leaseMs,
            pick,
        });

        if (!claimed.length) {
            return { candidates: candidates.length, claimed: 0 };
        }

        let payloads;

        try {
            payloads = await store.readPayloads(claimed.map(job => job.id));
        } catch (error) {
            reportError('read_payloads', error);
            await Promise.all(claimed.map(job => store.releaseJob(job, { delayMs: 0, lingerMs: 0 }).catch(
                releaseError => reportError('release', releaseError),
            )));

            return { candidates: candidates.length, claimed: 0 };
        }

        for (const job of claimed) {
            startJob(job, { found: payloads.has(job.id), payload: payloads.get(job.id) });
        }

        return { candidates: candidates.length, claimed: claimed.length };
    }

    /** @returns {string[]} The handled names whose lane has a free slot. */
    function namesWithFreeSlots() {
        return registry.entries().filter(entry => freeSlots(entry.lane) > 0).map(entry => entry.name);
    }

    /**
     * One turn of the dispatcher.
     * @returns {Promise<number>} The delay before the next turn (a wake ends it sooner).
     */
    async function dispatch() {
        const scope = takeScope();
        /** @type {Set<string>} */
        let names;
        /** @type {string[]} The names with mutex keys with a job at the head of a released key: due, claimed at once */
        let waiting = [];

        if (scope) {
            names = new Set();

            if (scope.keys.size) {
                waiting = await store.namesWaitingFor([...scope.keys], [...namesWithKeys]);

                for (const name of waiting) {
                    scope.claim.add(name);
                }
            }

            for (const name of [...scope.claim, ...scope.probe]) {
                const entry = registry.getEntry(name);

                if (entry && freeSlots(entry.lane) > 0) {
                    names.add(name);
                } else if (entry) {
                    // No free slot: the turn after a completion looks at it again
                    (scope.claim.has(name) ? backlog : wakeProbeNames).add(name);
                }
            }
        } else {
            names = new Set(namesWithFreeSlots());
        }

        if (!names.size) {
            if (!scope) {
                // A completion probes all names
                wakeAll = true;
            }

            return nextDelayMs();
        }

        // The names of a certain wake without mutex keys: claimed at once, the claim gives their next due time. The
        // others: probed first.
        const known = new Set(waiting);
        const direct = scope
            ? [...names].filter(name => scope.claim.has(name) && (!namesWithKeys.has(name) || known.has(name)))
            : [];
        const probed = scope
            ? [...names].filter(name => !scope.claim.has(name) || (namesWithKeys.has(name) && !known.has(name)))
            : null;
        const probe = probed?.length === 0
            ? []
            : (await store.probe(probed)).filter(row => registry.getEntry(row.name));
        const now = Date.now();

        if (probed) {
            for (const name of probed) {
                unschedule(name);
                backlog.delete(name);
            }
        } else {
            scheduled.clear();
            earliestScheduled = Infinity;
            backlog.clear();
            fullProbeAt = now + t.pollIntervalMs;
        }

        /** @type {string[]} */
        const due = [...direct];

        for (const row of probe) {
            if (row.delayMs > 0) {
                schedule(row.name, now + row.delayMs);
            } else {
                // Probed again at the next turns, until none is due
                backlog.add(row.name);

                if (names.has(row.name)) {
                    due.push(row.name);
                }
            }
        }

        if (!due.length) {
            return nextDelayMs();
        }

        namesLeftOut = false;

        const { candidates, claimed } = await claimAndStart(due);

        if (claimed) {
            contentionDelayMs = 0;

            return 0;
        }

        if (namesLeftOut) {
            // The names of the next turn: each turn that claims nothing takes its names out of the backlog
            return 0;
        }

        if (candidates) {
            // Other processes took them: back off a little
            contentionDelayMs = Math.min(Math.max(contentionDelayMs * 2, 10), 200);

            return contentionDelayMs * (0.5 + Math.random());
        }

        // The due jobs wait for keys: a key release wakes this process, the poll is the fallback
        return nextDelayMs();
    }

    async function loop() {
        // oxlint-disable-next-line no-unmodified-loop-condition -- close() changes it
        while (state === 'started') {
            const seenWakes = wakeCount;
            let delayMs;

            try {
                // oxlint-disable-next-line no-await-in-loop -- one turn after the other
                delayMs = await dispatch();
            } catch (error) {
                reportError('dispatch', error);
                // The names of its wakes are lost: all names
                wakeAll = true;
                delayMs = Math.min(t.pollIntervalMs, 1000);
            }

            // oxlint-disable-next-line no-await-in-loop -- one turn after the other
            await sleepUntilWake(delayMs, seenWakes);
        }
    }

    // ---- timers ----

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
        return state === 'closed' || running.size === 0;
    }

    /**
     * Renews the leases while handlers run: also while close() waits for them and during drain(), not only when
     * started. The timer stops when no handler runs; the next claimed job starts it again.
     */
    function keepRenewingLeases() {
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

    async function recoverStaleJobs() {
        const ownIds = new Set([...running.values()].map(job => job.claimed.id));
        let freedKeys = false;

        for (const { id, name } of await store.findStaleJobs(100)) {
            if (state !== 'started' || ownIds.has(id)) {
                continue;
            }

            // oxlint-disable-next-line no-await-in-loop -- small batches, one job per transaction
            const recovered = await store.recoverStaleJob(id, { leaseMs: t.leaseMs, buildFailureJob });

            if (recovered.result === 'released') {
                freedKeys = true;
                emit({ type: 'stalled', jobId: id, jobName: name, attempt: recovered.attempt });
            } else if (recovered.result === 'failed') {
                const { attempt, runMs } = recovered;

                freedKeys = true;
                counts.failed++;
                emit({ type: 'failed', jobId: id, jobName: name, attempt, durationMs: runMs, error: STALLED });
                reportFailureJob({ id, name, attempt, failureJob: null }, recovered.failureJob);
            }
        }

        const { lingers, orphans } = await store.sweepMutexes(100);

        if (freedKeys || lingers || orphans) {
            wakeUp();
            hintChannel.publish(ANY_NAME);
        }
    }

    async function deleteExpiredJobs() {
        // oxlint-disable-next-line no-unmodified-loop-condition -- close() changes state
        for (let deleted = BATCH; deleted >= BATCH && state === 'started';) {
            // oxlint-disable-next-line no-await-in-loop -- batches one after the other
            deleted = await store.deleteExpiredJobs(BATCH);
        }
    }

    // ---- public ----

    /**
     * The commit of an enqueue: the job is visible. The re-probes cover a commit event that comes before it is.
     * @param {string[]} names
     */
    function onCommitted(names) {
        if (state !== 'started' || !handlesAny(names)) {
            return;
        }

        wakeUp(names);
        onEnqueued(names);
    }

    /**
     * @param {string[]} names
     */
    function onEnqueued(names) {
        if (state !== 'started') {
            return;
        }

        if (!handlesAny(names)) {
            return;
        }

        // One series of re-probes, from the last enqueue: of the names enqueued within its steps
        reprobeFrom = Date.now();

        for (const name of names) {
            reprobeNames.set(name, reprobeFrom);
        }

        // A re-probe that comes sooner stays: then the series goes on from this enqueue. A burst of enqueues gives a
        // re-probe at most each first step, not one per enqueue.
        if (reprobe && reprobe.at <= reprobeFrom + REPROBE_DELAYS_MS[0]) {
            return;
        }

        if (reprobe) {
            clearTimeout(reprobe.timer);
            timers.delete(reprobe.timer);
        }

        scheduleReprobe();
    }

    /**
     * @param {string[]} names
     * @returns {boolean} This process handles one of the names, or one is `*`.
     */
    function handlesAny(names) {
        return names.some(name => name === ANY_NAME || registry.getEntry(name));
    }

    /** Sets the timer of the next step of the series, if one is left before the poll. */
    function scheduleReprobe() {
        const now = Date.now();
        const delays = REPROBE_DELAYS_MS.filter(delay => delay < t.pollIntervalMs);
        const at = delays.map(delay => reprobeFrom + delay).find(time => time > now);
        const lastDelay = delays.at(-1) ?? 0;

        if (at === undefined || state !== 'started') {
            reprobe = null;
            reprobeNames.clear();

            return;
        }

        const timer = setTimer(() => {
            const stepAt = Date.now();

            for (const [name, enqueuedAt] of reprobeNames) {
                // Its last step is past: a series that goes on for later enqueues does not probe it again
                if (stepAt - enqueuedAt > lastDelay) {
                    reprobeNames.delete(name);
                }
            }

            wakeUp([...reprobeNames.keys()], { speculative: true });
            scheduleReprobe();
        }, at - now);

        reprobe = { at, timer };
    }

    async function start() {
        if (state === 'closing' || state === 'closed') {
            throw new ClosedError('start() after close()');
        }

        if (state !== 'idle') {
            return;
        }

        registry.validate();
        namesWithKeys = new Set(registry.namesWithKeys());
        state = 'started';
        every('recover_stale_jobs', recoverStaleJobs, t.recoveryIntervalMs);

        if (cleanup) {
            every('delete_expired_jobs', deleteExpiredJobs, t.cleanupIntervalMs);
        }

        loopDone = loop();

        try {
            // NOTIFY comes after the commit: the job is visible. Another hint is sent before the commit of its enqueue:
            // re-probe until the job is visible.
            await hintChannel.listen((name) => {
                if (name.startsWith(KEY_PREFIX)) {
                    // A release: committed before its message
                    if (state === 'started') {
                        wakeUpKeys([name.slice(KEY_PREFIX.length)]);
                    }
                } else if (!hintsAfterCommit) {
                    onEnqueued([name]);
                } else if (state === 'started' && handlesAny([name])) {
                    wakeUp([name]);
                }
            });
        } catch (error) {
            reportError('hint_listen', error);
        }
    }

    /**
     * @param {import('./types.js').DrainOptions} [options]
     * @returns {Promise<import('./types.js').DrainResult>}
     */
    async function drain(options = {}) {
        if (state === 'closing' || state === 'closed') {
            throw new ClosedError('drain() after close()');
        }

        if (state !== 'idle') {
            throw new ConfigError('drain() runs without start(), and one at a time');
        }

        const timeoutMs = parseDuration(options.timeout ?? '10s');

        if (timeoutMs === null) {
            throw new InvalidOptionsError('drain: "timeout" must be a duration');
        }

        registry.validate();
        namesWithKeys = new Set(registry.namesWithKeys());
        state = 'draining';

        const before = { ...counts };
        const deadline = Date.now() + timeoutMs;
        const names = registry.entries().map(entry => entry.name);

        let quietRounds = 0;

        try {
            while (Date.now() < deadline) {
                // A job that finishes during this round can add a job (a retry, a failure job) that the round misses
                const finishedBefore = finishedCount;

                let claimed = 0;
                let lostRace = false;

                try {
                    if (options.includeDelayed) {
                        // oxlint-disable-next-line no-await-in-loop -- one round after the other
                        await store.makeDue(names);
                    }

                    // oxlint-disable-next-line no-await-in-loop -- one round after the other
                    ({ claimed } = await claimAndStart(names));
                } catch (error) {
                    if (!isTransientDbError(error)) {
                        throw error;
                    }

                    // A deadlock with a write of a job: the next round does the work again
                    reportError('drain', error);
                    lostRace = true;
                }

                const quiet = !claimed && !lostRace && !running.size && finishedCount === finishedBefore;

                quietRounds = quiet ? quietRounds + 1 : 0;

                // Two quiet rounds in a row: a write that commits late still gets a round
                if (quietRounds >= 2) {
                    return {
                        completed: counts.completed - before.completed,
                        retried: counts.retried - before.retried,
                        failed: counts.failed - before.failed,
                    };
                }

                // oxlint-disable-next-line no-await-in-loop -- one round after the other
                await Promise.race([...[...running.values()].map(job => job.done), sleep(claimed ? 0 : 10)]);
            }

            throw new DrainTimeoutError(`drain() did not finish in ${timeoutMs} ms`);
        } finally {
            if (state === 'draining') {
                state = 'idle';
            }
        }
    }

    /**
     * @param {import('./types.js').CloseOptions} [options]
     * @returns {Promise<void>}
     */
    function close(options = {}) {
        closeDone ??= closeOnce(parseCloseOptions(options));

        return closeDone;
    }

    /**
     * @typedef {object} CloseSettings
     * @property {number} startedAt
     * @property {number} deadlineMs
     * @property {number} exitsByMs
     * @property {'release' | 'abandon'} mode
     */

    /**
     * The options of close(). close() never rejects because of its options, so a shutdown always releases its jobs:
     * an invalid option logs a warning, and its default is used.
     * @param {import('./types.js').CloseOptions} options
     * @returns {CloseSettings}
     */
    function parseCloseOptions(options) {
        /**
         * @param {string} message
         * @returns {void}
         */
        const warn = message => logger?.warn({ options }, `sqlane: close() got ${message}: the default is used`);
        const given = /** @type {Record<string, unknown>} */ (options ?? {});
        const unknownKeys = Object.keys(given).filter(key => !['deadline', 'mode', 'exitsBy'].includes(key));

        if (unknownKeys.length) {
            warn(`unknown options (${unknownKeys.join(', ')})`);
        }

        let deadlineMs = parseDuration(given.deadline ?? '30s');

        if (deadlineMs === null) {
            warn('an invalid "deadline"');
            deadlineMs = 30_000;
        }

        let exitsByMs = parseDuration(given.exitsBy ?? deadlineMs + t.leaseMs);

        if (exitsByMs === null || exitsByMs < deadlineMs) {
            warn('an invalid "exitsBy", or one before the deadline');
            exitsByMs = deadlineMs + t.leaseMs;
        }

        let mode = /** @type {'release' | 'abandon'} */ (given.mode ?? 'release');

        if (mode !== 'release' && mode !== 'abandon') {
            warn('an invalid "mode"');
            mode = 'release';
        }

        return { startedAt: Date.now(), deadlineMs, exitsByMs, mode };
    }

    /**
     * @param {CloseSettings} settings
     * @returns {Promise<void>}
     */
    async function closeOnce({ startedAt, deadlineMs, exitsByMs, mode }) {
        state = 'closing';
        wakeUp();
        await hintChannel.stop();
        await loopDone;

        const deadline = startedAt + deadlineMs;
        const allDone = Promise.allSettled([...running.values()].map(job => job.done));

        await waitAtMost(allDone, deadline - Date.now());

        const unfinished = [...running.values()].filter(job => !job.settled);

        for (const job of unfinished) {
            job.released = true;
            job.controller.abort(new ShutdownError('The process is closing'));
        }

        if (mode === 'release') {
            const delayMs = Math.max(startedAt + exitsByMs - Date.now(), 0) + RELEASE_EXTRA_DELAY_MS;

            await Promise.all(unfinished.map(async (job) => {
                try {
                    await store.releaseJob(job.claimed, { delayMs, lingerMs: delayMs });
                    emit({
                        type: 'released',
                        jobId: job.claimed.id,
                        jobName: job.claimed.name,
                        attempt: job.claimed.attempts + 1,
                    });
                } catch (error) {
                    reportError('release', error);
                }
            }));
        }

        // The writes of the finished handlers, until the deadline
        await waitAtMost(
            Promise.allSettled([...running.values()].filter(job => job.settled).map(job => job.done)),
            deadline - Date.now(),
        );

        for (const timer of timers) {
            clearTimeout(timer);
        }

        timers.clear();
        state = 'closed';
    }

    return {
        start,
        drain,
        close,
        wake: () => wakeUp(),
        onEnqueued,
        onCommitted,
        isClosed: () => state === 'closing' || state === 'closed',
        isStarted: () => state === 'started',
        canStartNow: (name) => {
            const entry = registry.getEntry(name);

            return state === 'started' && Boolean(entry) && freeSlots(/** @type {HandlerEntry} */ (entry).lane) > 0;
        },
    };
}
