// The runner of an instance: the dispatcher loop, the handlers, the timers, close() and drain().
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { monotonicFactory } from 'ulid';
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
import { ANY_NAME } from './hint_channel.js';
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
const STALLED = { name: 'StalledError', message: 'The lease of the job ended: its process stopped or blocked' };
const BATCH = 1000;

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
 * @property {(name: string) => void} wake
 * @property {(names: string[]) => void} onEnqueued
 * @property {() => boolean} isClosed
 * @property {() => boolean} isStarted
 * @property {(name: string) => boolean} canStartNow This process handles the name and has a free slot for it.
 */

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
    const lockedBy = `${hostname()}:${process.pid}:${monotonicFactory()()}`;
    const lockToken = monotonicFactory();
    /** @type {'idle' | 'started' | 'draining' | 'closing' | 'closed'} */
    let state = 'idle';
    /** @type {Map<string, RunningJob>} */
    const running = new Map();
    let wakeCount = 0;
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
    const counts = { completed: 0, retried: 0, failed: 0 };
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

    function wakeUp() {
        wakeCount++;
        endSleep?.();
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

        const controller = new AbortController();

        endSleep = () => controller.abort();

        try {
            await sleep(Math.max(delayMs, 0), undefined, { signal: controller.signal });
        } catch {
            // Woken
        } finally {
            endSleep = null;
        }
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
            await writeResult(job, () => store.completeJob(claimed));
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
        await Promise.race([handlerDone, sleep(t.leaseMs, undefined, { ref: false })]);

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
            leaseEndsAt: Date.now() + t.leaseMs,
            startedAt: Date.now(),
        };

        entry.lane.running++;
        running.set(job.key, job);
        emit({ type: 'claimed', jobId: claimed.id, jobName: claimed.name, attempt: claimed.attempts + 1 });
        job.done = (async () => {
            try {
                await runJob(job, payload);
            } catch (error) {
                reportError('run_job', error);
            } finally {
                entry.lane.running--;
                running.delete(job.key);
                finishedCount++;
                wakeUp();

                if (claimed.mutexKeys.length) {
                    // Its keys are free: the jobs that wait for them can start, here or elsewhere
                    hintChannel.publish(ANY_NAME);
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

        const candidates = await store.findCandidates(limits, registry.keyedNames());

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
        const names = new Set(namesWithFreeSlots());

        if (!names.size) {
            return t.pollIntervalMs;
        }

        const probe = (await store.probe()).filter(row => registry.getEntry(row.name));
        const due = probe.filter(row => row.delayMs <= 0 && names.has(row.name)).map(row => row.name);
        const delays = probe.filter(row => row.delayMs > 0).map(row => row.delayMs);
        const nextDelayMs = Math.min(t.pollIntervalMs, ...delays);

        if (!due.length) {
            return nextDelayMs;
        }

        const { candidates, claimed } = await claimAndStart(due);

        if (claimed) {
            contentionDelayMs = 0;

            return 0;
        }

        if (candidates) {
            // Other processes took them: back off a little
            contentionDelayMs = Math.min(Math.max(contentionDelayMs * 2, 10), 200);

            return contentionDelayMs * (0.5 + Math.random());
        }

        // The due jobs wait for keys: a key release wakes this process, the poll is the fallback
        return nextDelayMs;
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
                delayMs = Math.min(t.pollIntervalMs, 1000);
            }

            // oxlint-disable-next-line no-await-in-loop -- one turn after the other
            await sleepUntilWake(delayMs, seenWakes);
        }
    }

    // ---- timers ----

    async function renewLeases() {
        const jobs = [...running.values()].filter(job => !job.released && !job.leaseLost);

        if (!jobs.length) {
            return;
        }

        const renewedAt = Date.now();
        const renewed = await store.renewLeases(jobs.map(job => job.claimed), t.leaseMs);

        for (const job of jobs) {
            if (renewed.has(job.claimed.id)) {
                job.leaseEndsAt = renewedAt + t.leaseMs;
            } else if (job.leaseEndsAt - Date.now() <= t.renewIntervalMs) {
                // Not renewed in time: another process may take the job
                job.leaseLost = true;
                job.controller.abort(new LeaseLostError(`The lease of job "${job.claimed.id}" was lost`));
                emit({
                    type: 'lease_lost',
                    jobId: job.claimed.id,
                    jobName: job.claimed.name,
                    attempt: job.claimed.attempts + 1,
                });
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
            const { result, failureJob } = await store.recoverStaleJob(id, { leaseMs: t.leaseMs, buildFailureJob });

            if (result === 'released') {
                freedKeys = true;
                emit({ type: 'stalled', jobId: id, jobName: name, attempt: 0 });
            } else if (result === 'failed') {
                freedKeys = true;
                counts.failed++;
                emit({ type: 'failed', jobId: id, jobName: name, attempt: 0, durationMs: 0, error: STALLED });
                reportFailureJob({ id, name, attempt: 0, failureJob: null }, failureJob);
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
     * @param {string[]} names
     */
    function onEnqueued(names) {
        if (state !== 'started') {
            return;
        }

        if (!handlesAny(names)) {
            return;
        }

        // A wake probes all the names: one series of re-probes, from the last enqueue
        reprobeFrom = Date.now();

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
        const at = REPROBE_DELAYS_MS
            .filter(delay => delay < t.pollIntervalMs)
            .map(delay => reprobeFrom + delay)
            .find(time => time > now);

        if (at === undefined || state !== 'started') {
            reprobe = null;

            return;
        }

        const timer = setTimer(() => {
            wakeUp();
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
        state = 'started';
        every('renew_leases', renewLeases, t.renewIntervalMs);
        every('recover_stale_jobs', recoverStaleJobs, t.recoveryIntervalMs);

        if (cleanup) {
            every('delete_expired_jobs', deleteExpiredJobs, t.cleanupIntervalMs);
        }

        loopDone = loop();

        try {
            // NOTIFY comes after the commit: the job is visible. Another hint is sent before the commit of its enqueue:
            // re-probe until the job is visible.
            await hintChannel.listen((name) => {
                if (!hintsAfterCommit) {
                    onEnqueued([name]);
                } else if (state === 'started' && handlesAny([name])) {
                    wakeUp();
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
        closeDone ??= closeOnce(options);

        return closeDone;
    }

    /**
     * @param {import('./types.js').CloseOptions} options
     * @returns {Promise<void>}
     */
    async function closeOnce(options) {
        const startedAt = Date.now();
        const deadlineMs = parseDuration(options.deadline ?? '30s') ?? 30_000;
        let exitsByMs = parseDuration(options.exitsBy ?? deadlineMs + t.leaseMs);

        if (exitsByMs === null || exitsByMs < deadlineMs) {
            logger?.warn({ exitsBy: options.exitsBy }, 'sqlane: close() got an invalid "exitsBy": the default is used');
            exitsByMs = deadlineMs + t.leaseMs;
        }

        const mode = options.mode === 'abandon' ? 'abandon' : 'release';

        state = 'closing';
        wakeUp();
        await hintChannel.stop();
        await loopDone;

        const deadline = startedAt + deadlineMs;
        const allDone = Promise.allSettled([...running.values()].map(job => job.done));

        await Promise.race([allDone, sleep(Math.max(deadline - Date.now(), 0))]);

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
        await Promise.race([
            Promise.allSettled([...running.values()].filter(job => job.settled).map(job => job.done)),
            sleep(Math.max(deadline - Date.now(), 0)),
        ]);

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
        wake: wakeUp,
        onEnqueued,
        isClosed: () => state === 'closing' || state === 'closed',
        isStarted: () => state === 'started',
        canStartNow: (name) => {
            const entry = registry.getEntry(name);

            return state === 'started' && Boolean(entry) && freeSlots(/** @type {HandlerEntry} */ (entry).lane) > 0;
        },
    };
}
