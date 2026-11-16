// The runner of an instance: the dispatcher loop, the handlers, the timers, close() and drain().
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMonotonicUlid } from './ulid.js';
import { parseDuration } from './duration.js';
import {
    ClosedError,
    ConfigError,
    DrainTimeoutError,
    InvalidOptionsError,
    ShutdownError,
} from './errors.js';
import { createFailureJobs } from './failure_jobs.js';
import { ANY_NAME } from './hint_channel.js';
import { chooseRows, fill, rankNames, replayTie, shareNamesOfRequests } from './fair_share.js';
import { incrementUs, waitUs } from './gcra.js';
import { createJobRuns, waitAtMost } from './job_runs.js';
import { createKeyUnblocks } from './key_unblocks.js';
import { createLeases } from './leases.js';
import {
    createLocalRateWakes,
    limitRoom,
    limitsRoom,
    localLimitsOf,
    ratesAdmitBefore,
    roomOf,
    shareNamesOf,
} from './local_limits.js';
import { nowUs, takeRate } from './local_rates.js';
import { createMaintenance } from './maintenance.js';
import { isRateKey } from './rate_keys.js';
import { isQuickRetryError, isTransientDbError } from './transient_error.js';

/** @typedef {import('./store/store.js').ClaimedJob} ClaimedJob */
/** @typedef {import('./registry.js').HandlerEntry} HandlerEntry */
/** @typedef {import('./job_runs.js').RunningJob} RunningJob */
/** @typedef {import('./local_limits.js').LocalLimit} LocalLimit */

/** A turn that fails with a deadlock-like error is retried at once this many times, then reported and backed off */
const MAX_TRANSIENT_DISPATCH_RETRIES = 3;
/** The pause before such a retry: 5 to 30 ms, so that the claims that collided do not collide again */
const TRANSIENT_RETRY_MIN_MS = 5;
const TRANSIENT_RETRY_JITTER_MS = 25;

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
 * A claim requests at most this many names per free slot, the furthest under their share first: a claim locks up to
 * the free slots of each name it requests, and the next names take the slots of a name whose due jobs are held
 * elsewhere. More due names wait for the next turns.
 */
const CLAIM_NAMES_PER_SLOT = 4;

/** @typedef {'idle' | 'started' | 'draining' | 'closing' | 'closed'} RunnerState */

/**
 * @typedef {object} RunnerParams
 * @property {import('./store/store.js').Store} store
 * @property {import('./registry.js').Registry} registry
 * @property {number} localMaxConcurrency The instance's cap.
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {boolean} cleanup
 * @property {import('./types.js').Logger | undefined} logger
 * @property {((event: import('./types.js').SqlaneEvent) => void) | undefined} onEvent
 * @property {import('./hint_channel.js').HintChannel} hintChannel
 * @property {boolean} hintsAfterCommit The hints come after the commit of their enqueue (PostgreSQL NOTIFY): they wake
 *     at once, with no re-probes.
 * @property {Partial<Timings>} [timings] For tests.
 * @property {() => number} [random] For tests: the random start of the tie pointer.
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
 * @property {() => boolean} isIdle Neither started, draining nor closed.
 * @property {(event: import('./types.js').SqlaneEvent) => void} emit Calls `onEvent`; logs what it throws.
 * @property {(name: string) => boolean} canStartNow This process handles the name and has a free slot for it.
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
}) {
    const t = { ...DEFAULT_TIMINGS, ...timings };
    const lockedBy = `${hostname()}:${process.pid}:${createMonotonicUlid()()}`;
    const lockToken = createMonotonicUlid();
    /** @type {RunnerState} */
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
    /** @type {Set<string>} The names whose last probe saw due jobs: probed again at each turn, until none is due */
    const backlog = new Set();
    /** @type {Map<string, number>} The next due time of the names with only future pending jobs, by the probes */
    const scheduled = new Map();
    /** The earliest time of `scheduled`; null: to compute again */
    let earliestScheduled = /** @type {number | null} */ (Infinity);
    /** @type {Set<string>} The handled names with global limits: their definition's, set by start(); and the names
     *     whose jobs got limits from their enqueue options, seen by the claims */
    let namesWithLimits = new Set();
    /** @type {Set<string>} The handled names with global rate limits: their definition's, set by start(); and the
     *     names whose jobs got rate limits from their enqueue options, seen by the search of candidates */
    let namesWithRates = new Set();
    /** @type {HandlerEntry[]} The handled names with local rate limits, set by start() */
    let entriesWithLocalRates = [];
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
    /** The tie pointer: equal shares go round-robin from it. Random at the start: a fleet breaks ties differently */
    let tiePointer = 0;
    /** The handled names, counted at start() or drain(): the span of the tie order */
    let handledCount = 1;
    /** The last claim left due names out: the next turn runs at once, for them */
    let namesLeftOut = false;
    let claimsInFlight = 0;
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
        wake: names => wakeUp(names),
        hintChannel,
        reportError,
    });
    const { unblockKeys, armRateWake } = unblocks;
    const { wakeAfterRates, clear: clearLocalRateWakes } = createLocalRateWakes({
        setTimer,
        clearTimer,
        wake: names => wakeUp(names, { speculative: true }),
    });
    const failureJobs = createFailureJobs({
        registry,
        defaults,
        emit,
        reportError,
        onAdded: (name) => {
            onEnqueued([name]);
            hintChannel.publish(name);
        },
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
        counts,
        failureJobs,
        armRateWake,
        wake: () => wakeUp(),
        hintChannel,
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
        failureJobs,
        armRateWake,
        wakeAfterRates,
        hintChannel,
    });

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
     * The names that the next turn looks at. Claimed at once: those of the certain wakes, of the backlog, and those
     * whose next due time came. Probed first: those of the speculative wakes. All names at a wake of all names, and
     * each poll interval.
     * @returns {{ claim: Set<string>, probe: Set<string> } | null} Null: all names.
     */
    function takeScope() {
        const now = Date.now();

        if (wakeAll || now >= fullProbeAt) {
            wakeAll = false;
            wakeNames.clear();
            wakeProbeNames.clear();

            return null;
        }

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

        return { claim, probe };
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
        return localMaxConcurrency - running.size;
    }

    /**
     * @param {HandlerEntry} entry
     * @returns {number} The jobs of the name that can start now: under its local limits and the instance's cap.
     */
    function freeSlots(entry) {
        // Each poll checks every handled name, and most have no limit: the check stays small enough for V8 to inline,
        // and the loops of limitsRoom() run only for the names with limits
        const room = entry.limits.length || entry.rates.length ? limitsRoom(entry) : Infinity;

        return Math.max(0, Math.min(room, freeProcessSlots()));
    }

    /** @returns {number} The handled names: the span of the tie order. Fixed from start() or drain(). */
    function tieSpan() {
        return handledCount;
    }

    /**
     * After a choice: equal shares go next to the name after the last one that won a tie.
     * @param {number | null} lastTieWinner
     */
    function movePointer(lastTieWinner) {
        if (lastTieWinner !== null) {
            tiePointer = (lastTieWinner + 1) % tieSpan();
        }
    }

    /**
     * @param {string[]} names
     * @returns {HandlerEntry[]} Their entries.
     */
    function entriesOf(names) {
        /** @type {HandlerEntry[]} */
        const entries = [];

        for (const name of names) {
            const entry = registry.getEntry(name);

            if (entry) {
                entries.push(entry);
            }
        }

        return entries;
    }

    /**
     * Takes the locked jobs of names with global limits, by the share of their names, FIFO within a name: a job whose
     * keys all have room, and whose rate keys all have quota (gcra.js), with the jobs that this choice took. A
     * passed-over job stays pending.
     * @param {ClaimedJob[]} locked In the order of run_at; none of their keys was full.
     * @param {Map<string, number>} held The held slots of their keys.
     * @param {Map<string, number>} debts The debts of their rate keys, in µs.
     * @returns {ClaimedJob[]}
     */
    function pick(locked, held, debts) {
        const taken = new Map(held);
        const used = new Map(debts);
        const fits = (/** @type {ClaimedJob} */ job) => job.limits.every(({ key, max }) => (taken.get(key) ?? 0) < max)
            && job.rateLimits.every(limit => waitUs(used.get(limit.key) ?? 0, limit) <= 0);
        /** @type {Map<string, ClaimedJob[]>} */
        const rowsByName = new Map();

        for (const job of locked) {
            if (registry.getEntry(job.name)) {
                rowsByName.set(job.name, [...rowsByName.get(job.name) ?? [], job]);
            }
        }

        const names = shareNamesOf(entriesOf([...rowsByName.keys()]));

        for (const name of names) {
            name.available = /** @type {ClaimedJob[]} */ (rowsByName.get(name.name)).length;
        }

        const { chosen, lastTieWinner } = fill({
            names,
            free: freeProcessSlots(),
            base: tiePointer,
            size: tieSpan(),
            take: (name) => {
                const rows = /** @type {ClaimedJob[]} */ (rowsByName.get(name.name));
                const at = rows.findIndex(fits);

                if (at === -1) {
                    return null;
                }

                const [job] = rows.splice(at, 1);

                for (const { key } of job.limits) {
                    taken.set(key, (taken.get(key) ?? 0) + 1);
                }

                for (const limit of job.rateLimits) {
                    used.set(limit.key, (used.get(limit.key) ?? 0) + incrementUs(limit));
                }

                return job;
            },
        });

        movePointer(lastTieWinner);

        return chosen;
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

        entry.running++;

        for (const limit of entry.limits) {
            limit.running++;
        }

        if (entry.rates.length) {
            // A claim takes the quota of the local rate limits
            const now = nowUs();

            for (const rate of entry.rates) {
                takeRate(rate, now);
            }
        }

        running.set(job.key, job);
        keepRenewingLeases();
        emit({ type: 'claimed', jobId: claimed.id, jobName: claimed.name, attempt: claimed.attempts + 1 });
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
                const mustWake = state !== 'started' || claimsInFlight > 0 || !job.completionConfirmed
                    || job.released || job.leaseLost || freeSlots(entry) === 0;
                // Its full limits: their other names were left out of the turns, and may have due jobs
                const fullLimits = entry.limits.filter(limit => limitRoom(limit) <= 0);

                entry.running--;

                for (const limit of entry.limits) {
                    limit.running--;
                }

                running.delete(job.key);
                finishedCount++;

                if (mustWake) {
                    // Its own name (with the names of its limits that were full), and the backlog
                    wakeUp([...new Set([claimed.name, ...fullLimits.flatMap(limit => limit.names)])], {
                        speculative: true,
                    });
                }
            }
        })();
    }

    // ---- dispatch ----

    /**
     * The names of this turn: the due names with a free slot, the furthest under their share first, at most 4 per free
     * slot, and at most 4 per free slot of each of their limits. The others stay in the backlog, for the next turns.
     * @param {string[]} dueNames
     * @returns {HandlerEntry[]}
     */
    function requestNames(dueNames) {
        /** @type {HandlerEntry[]} */
        const withRoom = [];

        for (const name of dueNames) {
            const entry = registry.getEntry(name);

            if (entry && freeSlots(entry) > 0) {
                withRoom.push(entry);
            }
        }

        const limit = CLAIM_NAMES_PER_SLOT * Math.max(freeProcessSlots(), 1);

        namesLeftOut = withRoom.length > limit;

        if (!namesLeftOut) {
            // All of them: the claim chooses among their rows, the order of the names does not matter
            return withRoom;
        }

        /** @type {Map<LocalLimit, number>} */
        const inLimits = new Map();
        /** @type {HandlerEntry[]} */
        const turn = [];

        // The share, then the tie order
        rankNames(withRoom, tiePointer, tieSpan());

        for (const entry of withRoom) {
            const { name } = entry;
            // A full limit takes no more names: the names after it get their turn
            const limitFull = localLimitsOf(entry).some(
                each => (inLimits.get(each) ?? 0) >= CLAIM_NAMES_PER_SLOT * roomOf(each),
            );

            if (turn.length >= limit || limitFull) {
                backlog.add(name);
            } else {
                turn.push(entry);

                for (const each of localLimitsOf(entry)) {
                    inLimits.set(each, (inLimits.get(each) ?? 0) + 1);
                }
            }
        }

        return turn;
    }

    /**
     * Claims the due jobs of the given names, by share within the free slots, and starts them. The candidates of the
     * names with global limits come first: a plan reserves their share of the free slots, of the instance and of their
     * local limits, the plain claim takes the rest, then the claim of the candidates.
     * @param {string[]} dueNames
     * @returns {Promise<{ candidates: number, claimed: number }>}
     */
    async function claimAndStart(dueNames) {
        claimsInFlight++;

        try {
            const turn = requestNames(dueNames);
            /** @type {HandlerEntry[]} */
            const keyed = [];
            /** @type {HandlerEntry[]} */
            const plainEntries = [];

            for (const entry of turn) {
                (namesWithLimits.has(entry.name) ? keyed : plainEntries).push(entry);
            }

            const found = keyed.length ? await findCandidatesOf(keyed) : { startable: [], full: [] };
            const reserved = reservedForKeys(turn, found.startable);
            const plain = await claimAndStartPlain(plainEntries, freeProcessSlots() - reserved.slots, reserved.limits);
            const withKeys = await claimAndStartWithKeys(found);

            return { candidates: plain.candidates + withKeys.candidates, claimed: plain.claimed + withKeys.claimed };
        } finally {
            claimsInFlight--;
        }
    }

    /**
     * The candidates of names with global limits: their due jobs whose keys have room, and those with a full key.
     * @param {HandlerEntry[]} entries
     * @returns {Promise<import('./store/store.js').FoundCandidates>}
     */
    async function findCandidatesOf(entries) {
        /** @type {Map<string, number>} */
        const limits = new Map();

        for (const entry of entries) {
            // 2 × the free slots: the processes woken together can take different rows
            limits.set(entry.name, 2 * freeSlots(entry));
        }

        const found = await store.findCandidates(limits, namesWithRates);
        const withCandidates = new Set([...found.startable, ...found.full].map(candidate => candidate.name));

        for (const { name } of entries) {
            if (!withCandidates.has(name)) {
                // No due job: an enqueue, a retry or the release of a key wakes it
                backlog.delete(name);
            }
        }

        return found;
    }

    /**
     * The free slots that the names with global limits get by their share, on their candidates: the plain claim leaves
     * them free, in the instance and in their local limits.
     * @param {HandlerEntry[]} turn
     * @param {import('./store/store.js').Candidate[]} candidates
     * @returns {{ slots: number, limits: Map<LocalLimit, number> }} The slots of the instance, and of each limit.
     */
    function reservedForKeys(turn, candidates) {
        /** @type {Map<LocalLimit, number>} */
        const limits = new Map();

        if (!candidates.length) {
            return { slots: 0, limits };
        }

        /** @type {Map<string, number>} */
        const candidateCounts = new Map();

        for (const candidate of candidates) {
            candidateCounts.set(candidate.name, (candidateCounts.get(candidate.name) ?? 0) + 1);
        }

        const names = shareNamesOf(turn);
        const byName = new Map(turn.map(entry => [entry.name, entry]));

        for (const name of names) {
            name.available = namesWithLimits.has(name.name) ? candidateCounts.get(name.name) ?? 0 : Infinity;
        }

        const { chosen } = fill({
            names,
            free: freeProcessSlots(),
            base: tiePointer,
            size: tieSpan(),
            take: name => byName.get(name.name) ?? null,
        });
        let slots = 0;

        for (const entry of chosen) {
            if (namesWithLimits.has(entry.name)) {
                slots++;

                for (const limit of localLimitsOf(entry)) {
                    limits.set(limit, (limits.get(limit) ?? 0) + 1);
                }
            }
        }

        return { slots, limits };
    }

    /**
     * The due jobs of names without global limits: found, chosen by share, claimed and read at once.
     * @param {HandlerEntry[]} turn
     * @param {number} free The free slots for them.
     * @param {Map<LocalLimit, number>} reservedInLimits The slots of each local limit for the names with global limits.
     * @returns {Promise<{ candidates: number, claimed: number }>}
     */
    async function claimAndStartPlain(turn, free, reservedInLimits) {
        if (!turn.length) {
            return { candidates: 0, claimed: 0 };
        }

        const base = tiePointer;
        const size = tieSpan();
        /** @type {HandlerEntry[]} */
        const entries = [];
        /** @type {LocalLimit[]} */
        const limits = [];
        /** @type {import('./store/store.js').DueRequest[]} */
        const requests = [];

        for (const entry of turn) {
            const maxJobs = Math.min(
                freeSlots(entry),
                free,
                ...localLimitsOf(entry).map(limit => roomOf(limit) - (reservedInLimits.get(limit) ?? 0)),
            );

            if (maxJobs <= 0) {
                // The names with global limits took its free slots: the next turn
                backlog.add(entry.name);
                continue;
            }

            entries.push(entry);
            requests.push({
                name: entry.name,
                maxJobs,
                running: entry.running,
                weight: entry.weight,
                limits: localLimitsOf(entry).map((limit) => {
                    const at = limits.indexOf(limit);

                    return at === -1 ? limits.push(limit) - 1 : at;
                }),
                tie: (((entry.index - base) % size) + size) % size,
            });
        }

        if (!entries.length) {
            return { candidates: 0, claimed: 0 };
        }

        const limitRooms = limits.map(limit => Math.max(0, roomOf(limit) - (reservedInLimits.get(limit) ?? 0)));
        /** @type {number | null | undefined} */
        let chosenTie;
        const { jobs, next, unpicked, limited } = await store.claimDue({
            requests,
            limitRooms,
            free,
            lockToken: lockToken(),
            lockedBy,
            leaseMs: t.leaseMs,
            // MySQL and MariaDB: the choice over the locked rows. One name: no tie
            choose: (locked) => {
                if (entries.length === 1) {
                    // Its maxJobs held the locked rows within the free slots
                    chosenTie = null;

                    return locked;
                }

                // The counts and the rooms of the requests: the locked rows kept under them
                const result = chooseRows({
                    rows: locked,
                    names: shareNamesOfRequests(entries, requests, limitRooms),
                    free,
                    base,
                    size,
                });

                chosenTie = result.lastTieWinner;

                return result.chosen;
            },
        });

        // PostgreSQL chose in SQL: the same choice again over the claimed rows, with the names that it left rows of.
        // One name, or no job: no tie
        if (chosenTie !== undefined) {
            movePointer(chosenTie);
        } else if (entries.length > 1 && jobs.length) {
            movePointer(replayTie({ entries, requests, limitRooms, jobs, unpicked: unpicked ?? [], base, size }));
        }

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

        for (const name of limited ?? []) {
            // Its jobs got global limits from their enqueue options: from now on, claimed with their limits
            namesWithLimits.add(name);
            backlog.add(name);
        }

        for (const job of jobs) {
            startJob(job, job.payload);
        }

        // Names with due jobs left and none claimed: other processes hold them
        return { candidates: stillDue, claimed: jobs.length };
    }

    /**
     * The candidates of names with global limits: a claim of those whose keys have room, by share, then their
     * payloads. The claim blocks the jobs with a full key: they leave the due jobs until a release of the key.
     * @param {import('./store/store.js').FoundCandidates} found
     * @returns {Promise<{ candidates: number, claimed: number }>}
     */
    async function claimAndStartWithKeys({ startable, full }) {
        if (!startable.length && !full.length) {
            return { candidates: 0, claimed: 0 };
        }

        const { jobs: claimed, blockedKeys, blockedNames, rateWaits } = await store.claim({
            candidateIds: startable.map(candidate => candidate.id),
            fullIds: full.map(candidate => candidate.id),
            lockToken: lockToken(),
            lockedBy,
            leaseMs: t.leaseMs,
            pick,
            withRates: [...startable, ...full].some(candidate => namesWithRates.has(candidate.name)),
        });

        // A rate key frees by time: its timer, here
        for (const { key, delayMs } of rateWaits) {
            armRateWake(key, delayMs);
        }

        if (blockedKeys.length) {
            // The due jobs after the blocked ones: the next turn
            for (const name of blockedNames) {
                backlog.add(name);
            }

            const slotKeys = blockedKeys.filter(key => !isRateKey(key));

            if (slotKeys.length) {
                // A release that committed during the claim did not see the blocked jobs
                await unblockKeys(slotKeys);
            }
        }

        if (!claimed.length) {
            return { candidates: startable.length, claimed: 0 };
        }

        let payloads;

        try {
            payloads = await store.readPayloads(claimed.map(job => job.id));
        } catch (error) {
            reportError('read_payloads', error);
            await Promise.all(claimed.map(job => store.releaseJob(job, { delayMs: 0, lingerMs: 0 }).catch(
                releaseError => reportError('release', releaseError),
            )));
            await unblockKeys(claimed.flatMap(job => job.limits.map(limit => limit.key)));

            return { candidates: startable.length, claimed: 0 };
        }

        for (const job of claimed) {
            startJob(job, { found: payloads.has(job.id), payload: payloads.get(job.id) });
        }

        return { candidates: startable.length, claimed: claimed.length };
    }

    /** @returns {string[]} The handled names with a free slot. A name over a local rate limit wakes at its time. */
    function namesWithFreeSlots() {
        // Each poll checks every handled name: the loop goes over the few with local rate limits only. A loop over all
        // of them cost an idle worker more instructions per poll (its allocations until optimized, then its compile)
        for (const entry of entriesWithLocalRates) {
            if (freeSlots(entry) <= 0) {
                wakeAfterRates(entry);
            }
        }

        return registry.entries().filter(entry => freeSlots(entry) > 0).map(entry => entry.name);
    }

    /**
     * One turn of the dispatcher.
     * @returns {Promise<number>} The delay before the next turn (a wake ends it sooner).
     */
    async function dispatch() {
        const scope = takeScope();
        /** @type {Set<string>} */
        let names;

        if (scope) {
            names = new Set();

            for (const name of [...scope.claim, ...scope.probe]) {
                const entry = registry.getEntry(name);

                if (entry && freeSlots(entry) > 0) {
                    names.add(name);
                } else if (entry) {
                    // No free slot: the turn after a completion looks at it again, or the time of its rate limit
                    (scope.claim.has(name) ? backlog : wakeProbeNames).add(name);
                    wakeAfterRates(entry);
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

        // The names of a certain wake: claimed at once, the claim gives their next due time. The others: probed first.
        const direct = scope ? [...names].filter(name => scope.claim.has(name)) : [];
        const probed = scope ? [...names].filter(name => !scope.claim.has(name)) : null;
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
        /** The transient errors in a row that the next turns retry at once */
        let transientRetries = 0;

        // oxlint-disable-next-line no-unmodified-loop-condition -- close() changes it
        while (state === 'started') {
            const seenWakes = wakeCount;
            let delayMs;

            try {
                // oxlint-disable-next-line no-await-in-loop -- one turn after the other
                delayMs = await dispatch();
                transientRetries = 0;
            } catch (error) {
                // The names of its wakes are lost: all names
                wakeAll = true;

                // A deadlock, a serialization failure, a 1020: the turn again at once, before an error event and a
                // back-off. Not a lock wait timeout: the lock is likely still held, and each retry would wait as long
                if (isQuickRetryError(error) && transientRetries < MAX_TRANSIENT_DISPATCH_RETRIES) {
                    transientRetries++;
                    logger?.debug({ error, operation: 'dispatch', retry: transientRetries },
                        'sqlane: dispatch failed with a transient error, retried at once');
                    // oxlint-disable-next-line no-await-in-loop -- one turn after the other
                    await sleep(TRANSIENT_RETRY_MIN_MS + (Math.random() * TRANSIENT_RETRY_JITTER_MS));
                    continue;
                }

                transientRetries = 0;
                reportError('dispatch', error);
                delayMs = Math.min(t.pollIntervalMs, 1000);
            }

            // oxlint-disable-next-line no-await-in-loop -- one turn after the other
            await sleepUntilWake(delayMs, seenWakes);
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
        namesWithLimits = new Set(registry.namesWithLimits());
        namesWithRates = new Set(registry.namesWithRateLimits());
        entriesWithLocalRates = registry.entries().filter(entry => entry.rates.length);
        handledCount = Math.max(registry.entries().length, 1);
        tiePointer = Math.floor(random() * handledCount);
        state = 'started';
        unblocks.resume();
        maintenance.start();

        loopDone = loop();

        try {
            // NOTIFY comes after the commit: the job is visible. Another hint is sent before the commit of its enqueue:
            // re-probe until the job is visible.
            await hintChannel.listen((name) => {
                if (!hintsAfterCommit) {
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
            throw new InvalidOptionsError('drain(): "timeout" must be a duration');
        }

        registry.validate();
        namesWithLimits = new Set(registry.namesWithLimits());
        namesWithRates = new Set(registry.namesWithRateLimits());
        entriesWithLocalRates = registry.entries().filter(entry => entry.rates.length);
        handledCount = Math.max(registry.entries().length, 1);
        tiePointer = Math.floor(random() * handledCount);
        state = 'draining';
        unblocks.resume();

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
                /** @type {string[]} */
                let due = [];

                try {
                    if (options.includeDelayed) {
                        // oxlint-disable-next-line no-await-in-loop -- one round after the other
                        await store.makeDue(names);
                    }

                    // One probe per round: only the due names compete for the free slots
                    // oxlint-disable-next-line no-await-in-loop -- one round after the other
                    due = (await store.probe(names)).filter(row => row.delayMs <= 0).map(row => row.name);

                    // oxlint-disable-next-line no-await-in-loop -- one round after the other
                    ({ claimed } = due.length ? await claimAndStart(due) : { claimed: 0 });
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
        wake: () => wakeUp(),
        onEnqueued,
        onCommitted,
        isClosed: () => state === 'closing' || state === 'closed',
        isStarted: () => state === 'started',
        isIdle: () => state === 'idle',
        emit,
        canStartNow: (name) => {
            const entry = registry.getEntry(name);

            return state === 'started' && Boolean(entry) && freeSlots(/** @type {HandlerEntry} */ (entry)) > 0;
        },
    };
}
