// The runner of an instance: start(), drain() and close(), and the slot of each job that runs in this process. It
// connects the parts: the dispatcher loop (dispatcher.js), the runs of the jobs and their results (job_runs.js), the
// leases (leases.js), the unblocks of keys (key_unblocks.js), the local limits (local_limits.js), the re-probes after
// an enqueue (reprobes.js) and the periodic work (maintenance.js).
import { setTimeout as sleep } from 'node:timers/promises';
import { createDispatcher } from './dispatcher.js';
import { parseDuration } from './duration.js';
import { ClosedError, ConfigError, DrainTimeoutError, InvalidOptionsError, ShutdownError } from './errors.js';
import { createFailureLanes } from './failure_lanes.js';
import { ANY_LANE } from './hint_channel.js';
import { createJobRuns, waitAtMost } from './job_runs.js';
import { createKeyUnblocks } from './key_unblocks.js';
import { createLeases } from './leases.js';
import { createLocalRateWakes, limitRoom, ratesAdmitBefore } from './local_limits.js';
import { nowUs, takeRate } from './local_rates.js';
import { createMaintenance } from './maintenance.js';
import { createReprobes } from './reprobes.js';
import { isTransientDbError } from './transient_error.js';

/** @typedef {import('./store/store.js').ClaimedJob} ClaimedJob */
/** @typedef {import('./registry.js').HandlerEntry} HandlerEntry */
/** @typedef {import('./job_runs.js').RunningJob} RunningJob */

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

const RELEASE_EXTRA_DELAY_MS = 2000;

/** @typedef {'idle' | 'started' | 'draining' | 'closing' | 'closed'} RunnerState */

/**
 * @typedef {object} RunnerParams
 * @property {import('./store/store.js').Store} store
 * @property {import('./registry.js').Registry} registry
 * @property {number} localMaxConcurrency The runner's cap.
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {boolean} cleanup
 * @property {import('./types.js').Logger | undefined} logger
 * @property {((event: import('./types.js').SqlaneEvent) => void) | undefined} onEvent
 * @property {import('./hint_channel.js').HintChannel} hintChannel
 * @property {boolean} hintsAfterCommit The hints come after the commit of their enqueue (PostgreSQL NOTIFY): they wake
 *     at once, with no re-probes.
 * @property {Partial<Timings>} [timings] For tests.
 * @property {() => number} [random] For tests: the random start of the tie pointer.
 * @property {() => boolean} [fairGroupsReady] The schema has `0011_fair_groups`: the claims read the groups, the lanes
 *     with `fairGroup` are claimed by group, the failure jobs keep their group. Default: it has.
 */

/**
 * @typedef {object} Runner
 * @property {(options?: { serverCheck?: (() => Promise<void>) | null }) => Promise<void>} start `serverCheck`: the
 *     check of the server that did not run (the database was down): the dispatcher runs it before its first turn,
 *     and the recovery and the cleanup start once it passes.
 * @property {(options?: import('./types.js').DrainOptions) => Promise<import('./types.js').DrainResult>} drain
 * @property {(options?: import('./types.js').CloseOptions) => Promise<void>} close
 * @property {(lanes: string[]) => void} wakeLanes Jobs of the lanes are due: an unblock.
 * @property {(lanes: string[]) => void} onEnqueued An enqueue: its commit is to come.
 * @property {(lanes: string[]) => void} onCommitted An enqueue committed: wakes at once, then re-probes.
 * @property {() => boolean} isClosed
 * @property {() => boolean} isStarted
 * @property {() => boolean} isIdle Neither started, draining nor closed.
 * @property {() => boolean} isDraining
 * @property {() => boolean} isBusy Started, draining or closing: its queries run.
 * @property {(event: import('./types.js').SqlaneEvent) => void} emit Calls `onEvent`; logs what it throws.
 * @property {(keys: string[]) => Promise<void>} unblockKeys Makes due the jobs blocked on keys with room, wakes and
 *     hints them. Never rejects: a failure is an `error` event (operation `unblock`).
 * @property {(key: string, delayMs: number) => void} armRateWake The timer of a rate key: an unblock of its jobs in
 *     `delayMs`, then the next ones while blocked jobs are left. Idle: at the next start() or drain().
 * @property {(lane: string) => boolean} canStartNow The lane is handled in this process, not paused, and has a free
 *     slot.
 * @property {(entries: readonly HandlerEntry[]) => void} added Lanes handled from now on (a mount): claimed at once
 *     when started.
 * @property {(entries: readonly HandlerEntry[]) => void} removed Lanes no longer handled (an unmount). A claim in
 *     flight and the jobs that run keep their handler.
 * @property {(lane: string) => void} pauseLocally This process claims no job of the lane, until resumeLocally().
 * @property {(lane: string) => void} resumeLocally Claims the lane again, at once.
 * @property {(lane: string) => boolean} isPausedLocally
 * @property {(lane: string) => boolean} claimsByGroup The lane is claimed by fair group now
 *     (`LaneRunStatus.fairGroups`).
 */

/**
 * @param {RunnerParams} params
 * @returns {Runner}
 */
export function createRunner({
    store,
    registry,
    localMaxConcurrency,
    defaults,
    cleanup,
    logger,
    onEvent,
    hintChannel,
    hintsAfterCommit,
    timings = {},
    random = Math.random,
    fairGroupsReady = () => true,
}) {
    const t = { ...DEFAULT_TIMINGS, ...timings };
    /** @type {RunnerState} */
    let state = 'idle';
    /** @type {Map<string, RunningJob>} */
    const running = new Map();
    /** @type {Promise<void> | null} */
    let loopDone = null;
    /** @type {Promise<void> | null} */
    let closeDone = null;
    /** @type {Set<NodeJS.Timeout>} */
    const timers = new Set();
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

    /** @param {NodeJS.Timeout} timer */
    function clearTimer(timer) {
        clearTimeout(timer);
        timers.delete(timer);
    }

    const unblocks = createKeyUnblocks({
        store,
        state: () => state,
        setTimer,
        clearTimer,
        wake: wakeUp,
        hintChannel,
        reportError,
    });
    const { unblockKeys, armRateWake } = unblocks;
    const { wakeAfterRates, clear: clearLocalRateWakes } = createLocalRateWakes({
        setTimer,
        clearTimer,
        wake: lanes => wakeUp(lanes, { speculative: true }),
    });
    const failureLanes = createFailureLanes({
        defaults,
        emit,
        reportError,
        onAdded: (lane) => {
            onEnqueued([lane]);
            hintChannel.publish(lane);
        },
        fairGroupsReady,
    });
    const { keepRenewing: keepRenewingLeases } = createLeases({
        store,
        running,
        timings: t,
        state: () => state,
        setTimer,
        emit,
        reportError,
    });
    const maintenance = createMaintenance({
        store,
        running,
        timings: t,
        cleanup,
        state: () => state,
        setTimer,
        emit,
        reportError,
        armRateWake,
        wake: wakeUp,
        hintChannel,
        fairGroupsReady,
    });
    const { runJob } = createJobRuns({
        store,
        defaults,
        logger,
        emit,
        reportError,
        counts,
        timings: t,
        state: () => state,
        failureLanes,
        armRateWake,
        wakeAfterRates,
        hintChannel,
    });
    const reprobes = createReprobes({
        pollIntervalMs: t.pollIntervalMs,
        state: () => state,
        setTimer,
        clearTimer,
        wake: lanes => wakeUp(lanes, { speculative: true }),
    });
    const dispatcher = createDispatcher({
        store,
        registry,
        localMaxConcurrency,
        running,
        timings: t,
        random,
        state: () => state,
        logger,
        reportError,
        startJob,
        unblockKeys,
        armRateWake,
        wakeAfterRates,
        fairGroupsReady,
        groupRunningOf: lane => (group) => {
            let count = 0;

            for (const job of running.values()) {
                if (job.claimed.lane === lane && job.claimed.fairGroup === group) {
                    count++;
                }
            }

            return count;
        },
    });

    /**
     * Ends the sleep of the dispatcher. The next turn looks at the given lanes, or at all lanes.
     * @param {readonly string[]} [lanes] The lanes that may have ready jobs. None, or `*`: all lanes.
     * @param {{ speculative?: boolean }} [options] speculative: the jobs may not be visible yet, or there may be none
     *     (a claim on MySQL is a transaction of several statements): a probe first. Else the turn claims at once.
     */
    function wakeUp(lanes, options) {
        dispatcher.wake(lanes, options);
    }

    /**
     * @param {ClaimedJob} claimed
     * @param {{ found: boolean, payload: unknown }} payload
     * @param {HandlerEntry} entry The handler of the claim.
     */
    function startJob(claimed, payload, entry) {
        const key = `${claimed.id}\n${claimed.lockToken}`;

        if (running.has(key)) {
            // A claim that gave the job twice (a bug): it runs once
            reportError('start_job', new Error(`sqlane: the job ${claimed.id} was claimed twice by one claim, `
                + 'it runs once'));

            return;
        }

        /** @type {RunningJob} */
        const job = {
            key,
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

        entry.running++;

        for (const limit of entry.limits) {
            limit.running++;
        }

        if (entry.rates.length && claimed.stalls <= claimed.maxStalls) {
            // A claim takes the quota of the local rate limits; a job past its maxStalls fails without a run
            const now = nowUs();

            for (const rate of entry.rates) {
                takeRate(rate, now);
            }
        }

        running.set(job.key, job);
        keepRenewingLeases();
        emit({
            type: 'claimed',
            jobId: claimed.id,
            lane: claimed.lane,
            attempt: claimed.attempts + 1,
            fairGroup: claimed.fairGroup,
            runAt: claimed.runAt,
            enqueuedAt: claimed.enqueuedAt,
            startedAt: claimed.startedAt,
        });
        job.done = (async () => {
            try {
                await runJob(job, payload);
            } catch (error) {
                reportError('run_job', error);
            } finally {
                if (claimed.limits.length) {
                    // Its slots of the global limits are free: the jobs blocked on its keys are due before its slot of
                    // the instance is, so that the next turn shares that slot with them too
                    await unblockKeys(claimed.limits.map(limit => limit.key));
                }

                // A successful keyless completion with spare capacity adds no ready work. The post-claim probe
                // already scheduled pending jobs. Claims in flight may have captured an older slot count.
                const mustWake = state !== 'started' || dispatcher.claiming() || !job.completionConfirmed
                    || job.released || job.leaseLost || dispatcher.freeSlots(entry) === 0;
                // Its full limits: their other lanes were left out of the turns, and may have due jobs
                const fullLimits = entry.limits.filter(limit => limitRoom(limit) <= 0);

                entry.running--;

                for (const limit of entry.limits) {
                    limit.running--;
                }

                running.delete(job.key);
                finishedCount++;

                if (mustWake) {
                    // Its own lane (with the lanes of its limits that were full), and the backlog
                    wakeUp([...new Set([claimed.lane, ...fullLimits.flatMap(limit => limit.lanes)])], {
                        speculative: true,
                    });
                }
            }
        })();
    }

    // ---- public ----

    /**
     * The commit of an enqueue: the job is visible. The re-probes cover a commit event that comes before it is.
     * @param {string[]} lanes
     */
    function onCommitted(lanes) {
        if (state !== 'started' || !anyAdded(lanes)) {
            return;
        }

        wakeUp(lanes);
        onEnqueued(lanes);
    }

    /**
     * @param {string[]} lanes
     */
    function onEnqueued(lanes) {
        if (state !== 'started') {
            return;
        }

        if (!anyAdded(lanes)) {
            return;
        }

        reprobes.follow(lanes);
    }

    /**
     * @param {string[]} lanes
     * @returns {boolean} One of the lanes is handled in this process and not paused, or one is `*`.
     */
    function anyAdded(lanes) {
        return lanes.some(lane => lane === ANY_LANE || (registry.getEntry(lane) && !dispatcher.isPaused(lane)));
    }

    /**
     * @returns {string[]} The lanes that drain() runs: handled, not paused.
     */
    function drainLanes() {
        return registry.entries().map(entry => entry.name).filter(lane => !dispatcher.isPaused(lane));
    }

    /**
     * @param {{ serverCheck?: (() => Promise<void>) | null }} [options]
     */
    async function start({ serverCheck = null } = {}) {
        if (state === 'closing' || state === 'closed') {
            throw new ClosedError('start() after close()');
        }

        if (state !== 'idle') {
            return;
        }

        dispatcher.prepare();
        state = 'started';
        unblocks.resume();

        if (serverCheck) {
            // The check did not run (the database was down): the recovery and the cleanup write too, so they start
            // once it passes. A wrong server gets none of their writes
            loopDone = dispatcher.run(async () => {
                await serverCheck();

                if (state === 'started') {
                    maintenance.start();
                }
            });
        } else {
            maintenance.start();
            loopDone = dispatcher.run();
        }

        try {
            // NOTIFY comes after the commit: the job is visible. Another hint is sent before the commit of its enqueue:
            // re-probe until the job is visible.
            await hintChannel.listen((lane) => {
                if (!hintsAfterCommit) {
                    onEnqueued([lane]);
                } else if (state === 'started' && anyAdded([lane])) {
                    wakeUp([lane]);
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
            throw new InvalidOptionsError('drain(): "timeout" must be a duration');
        }

        dispatcher.prepare();
        state = 'draining';
        unblocks.resume();

        const before = { ...counts };
        const deadline = Date.now() + timeoutMs;

        let quietRounds = 0;

        try {
            while (Date.now() < deadline) {
                // A job that finishes during this round can add a job (a retry, a failure job) that the round misses
                const finishedBefore = finishedCount;

                let claimed = 0;
                let lostRace = false;
                /** @type {string[]} */
                let due = [];
                // Each round: a pause during drain() holds from the next round
                const lanes = drainLanes();

                try {
                    if (options.includeDelayed && lanes.length) {
                        // oxlint-disable-next-line no-await-in-loop -- one round after the other
                        await store.makeDue(lanes);
                    }

                    // One probe per round: only the due lanes compete for the free slots
                    due = lanes.length
                        // oxlint-disable-next-line no-await-in-loop -- one round after the other
                        ? (await store.probe(lanes)).filter(row => row.delayMs <= 0).map(row => row.name)
                        : [];

                    // oxlint-disable-next-line no-await-in-loop -- one round after the other
                    ({ claimed } = due.length ? await dispatcher.claimAndStart(due) : { claimed: 0 });
                } catch (error) {
                    if (!isTransientDbError(error)) {
                        throw error;
                    }

                    // A deadlock with a write of a job: the next round does the work again
                    reportError('drain', error);
                    lostRace = true;
                }

                // A rate key that this process unblocks, now or before the deadline, or a local rate limit that admits
                // a due job before it: its jobs are still to run
                const quiet = !claimed && !lostRace && !running.size && finishedCount === finishedBefore
                    && !unblocks.busy() && !unblocks.dueBefore(deadline) && !ratesAdmitBefore(registry, due, deadline);

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
        // The hint of the sqlane goes on: its enqueues still send it
        await hintChannel.unlisten();
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
                        lane: job.claimed.lane,
                        attempt: job.claimed.attempts + 1,
                        fairGroup: job.claimed.fairGroup,
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

        // An unblock that runs: its writes, until the deadline; it arms no timer now
        await waitAtMost(unblocks.settled(), deadline - Date.now());
        unblocks.clear();
        clearLocalRateWakes();

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
        wakeLanes: lanes => wakeUp(lanes),
        onEnqueued,
        onCommitted,
        isClosed: () => state === 'closing' || state === 'closed',
        isStarted: () => state === 'started',
        isIdle: () => state === 'idle',
        isDraining: () => state === 'draining',
        isBusy: () => state === 'started' || state === 'draining' || state === 'closing',
        emit,
        unblockKeys,
        armRateWake,
        canStartNow: (lane) => {
            const entry = registry.getEntry(lane);

            return state === 'started' && Boolean(entry) && !dispatcher.isPaused(lane)
                && dispatcher.freeSlots(/** @type {HandlerEntry} */ (entry)) > 0;
        },
        added: (entries) => {
            dispatcher.added(entries);

            if (state === 'started' && entries.length) {
                // Its due jobs: claimed at once
                wakeUp(entries.map(entry => entry.name));
            }
        },
        removed: entries => dispatcher.removed(entries),
        pauseLocally: (lane) => {
            dispatcher.setPaused(lane, true);
        },
        resumeLocally: (lane) => {
            if (!dispatcher.isPaused(lane)) {
                return;
            }

            dispatcher.setPaused(lane, false);

            if (state === 'started' && registry.getEntry(lane)) {
                wakeUp([lane]);
            }
        },
        isPausedLocally: lane => dispatcher.isPaused(lane),
        claimsByGroup: lane => dispatcher.claimsByGroup(lane),
    };
}
