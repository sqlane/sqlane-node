// The scheduler of an instance: one timer for the earliest slot of its schedules, and the fire of the due slots. No
// leader: every started process with a schedule tries its slots, and the cursor row of the schedule lets one of them
// add the job. See docs/design.md › Schedules.
import { ConfigError, InvalidMutexKeyError, InvalidOptionsError, PayloadTooLargeError } from './errors.js';
import { buildNewJob } from './new_job.js';
import { dueOf, latestSlot, nextSlot, pendingSlots, previousSlot } from './schedule.js';
import { isConnectionError, isMissingTableError, isTransientDbError } from './transient_error.js';

/** @typedef {import('./schedule.js').ScheduleEntry} ScheduleEntry */
/** @typedef {import('./store/fire_slots.js').SlotCandidate} SlotCandidate */
/** @typedef {import('./store/fire_slots.js').FireResult} FireResult */
/** @typedef {import('./store/fire_slots.js').ClockSample} ClockSample */
/** @typedef {import('./store/store.js').ScheduleRead} ScheduleRead */

/**
 * @typedef {object} SchedulerTimings
 * @property {number} graceMs A slot is on time while the database time minus the slot is at most this.
 * @property {number} futureMs A slot more than this ahead of the database time is deferred.
 * @property {number} catchUpReachMs A late slot runs if the cursor is at most one period plus this older.
 * @property {number} recheckMs When a busy row is read again; doubles while it stays busy.
 * @property {number} maxRecheckMs
 * @property {number} maxSleepMs The longest sleep of the timer: wall-clock jumps, the limit of setTimeout.
 * @property {number} retryMs The backoff after a failed fire; doubles.
 * @property {number} maxRetryMs
 * @property {number} skewSampleRttMs Only samples of the database clock with a round trip up to this count.
 * @property {number} skewWindowMs The samples of this window count: the one with the smallest round trip wins.
 * @property {number} skewWarnMs Above this, a warning, at most once per skew window.
 * @property {number} batch The most candidates in one fire transaction.
 * @property {() => number} now The clock of the process.
 * @property {() => number} monotonic A clock that never jumps: tells a step of `now()` from the time that passed.
 * @property {(() => void) | null} onWake Undocumented, for the benchmarks: called at each wake of the timer.
 */

/** @type {SchedulerTimings} */
export const DEFAULT_SCHEDULER_TIMINGS = {
    graceMs: 60_000,
    futureMs: 1000,
    catchUpReachMs: 86_400_000,
    recheckMs: 1000,
    maxRecheckMs: 60_000,
    maxSleepMs: 60_000,
    retryMs: 5000,
    maxRetryMs: 60_000,
    skewSampleRttMs: 50,
    skewWindowMs: 600_000,
    skewWarnMs: 5000,
    batch: 100,
    now: Date.now,
    monotonic: () => performance.now(),
    onWake: null,
};
/** A step of the process clock larger than this drops the samples of the skew */
const CLOCK_STEP_MS = 1000;
/** The steps of the walk from the next slot to the latest due one, before a search */
const MAX_WALK = 100;
/** The shortest wait of a deferred slot */
const MIN_DEFER_MS = 100;

/**
 * @param {ScheduleEntry} entry
 * @param {number} nowMs Database time.
 * @returns {number | null} The latest due slot.
 */
function latestDue(entry, nowMs) {
    let slot = /** @type {number} */ (entry.nextAt);

    for (let step = 0; step < MAX_WALK; step++) {
        const next = nextSlot(entry, slot);

        if (next === null || (entry.jitterMs ? dueOf(entry, next) : next) > nowMs) {
            return slot;
        }

        slot = next;
    }

    return entry.jitterMs ? pendingSlots(entry, nowMs).latest : latestSlot(entry, nowMs);
}

/**
 * @param {ScheduleEntry} entry
 * @param {number} slot
 * @returns {number} When the job of the slot is due.
 */
function dueAt(entry, slot) {
    return entry.jitterMs ? dueOf(entry, slot) : slot;
}

/**
 * The next slot to track after a decided or busy slot. Without jitter: after now, the latest due slot rule. With
 * jitter: right after the slot, whose due time may be ahead.
 * @param {ScheduleEntry} entry
 * @param {number} slot
 * @param {number} dbNow
 * @returns {number | null}
 */
function advance(entry, slot, dbNow) {
    if (entry.jitterMs) {
        return nextSlot(entry, slot);
    }

    return nextSlot(entry, Math.max(dbNow, slot));
}

/**
 * @typedef {object} SchedulerParams
 * @property {import('./store/store.js').Store} store
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {number} maxPayloadBytes
 * @property {(name: string) => import('./types.js').JobDefinition | null} findDefinition
 * @property {'allow' | 'reject'} unknownJobs
 * @property {string | null} notifyChannel
 * @property {(name: string) => void} onCreated After the commit of a fire: once per name that got a job.
 * @property {(event: import('./types.js').SqlaneEvent) => void} emit
 * @property {import('./types.js').Logger | undefined} logger
 * @property {Partial<SchedulerTimings>} [timings] For tests.
 */

/**
 * @typedef {object} Scheduler
 * @property {(entry: ScheduleEntry) => void} add Throws a ConfigError for a second schedule with the same id.
 * @property {() => void} prepare At start(): resolves the definitions, and builds a test job of each schedule.
 * @property {() => Promise<ScheduleRead>} register Inserts the missing rows, reads them all.
 * @property {(read: ScheduleRead | null) => void} start Arms the timer. Null: the registration failed; it retries.
 * @property {() => Promise<void>} stop Clears the timer, waits for the fire in flight.
 * @property {() => Promise<import('./types.js').ScheduleInfo[]>} list
 * @property {(error: unknown) => void} reportFailure The registration of start() failed: logged as the fires are.
 * @property {() => number} size
 */

/**
 * A slot that another transaction held: read again later.
 * @typedef {object} Recheck
 * @property {SlotCandidate} candidate
 * @property {number} at Local time.
 * @property {number} delayMs
 * @property {number} since Local time of the first busy result.
 * @property {boolean} warned
 */

/**
 * @typedef {object} FireOutcome
 * @property {import('./store/fire_slots.js').DecidedSlot[]} decided
 * @property {string[]} busy
 * @property {string[]} deferred
 * @property {SlotCandidate[]} failed
 * @property {number | null} dbNowMs Of the last fire that read it.
 */

/**
 * @param {SchedulerParams} params
 * @returns {Scheduler}
 */
export function createScheduler({
    store,
    defaults,
    maxPayloadBytes,
    findDefinition,
    unknownJobs,
    notifyChannel,
    onCreated,
    emit,
    logger,
    timings = {},
}) {
    const t = { ...DEFAULT_SCHEDULER_TIMINGS, ...timings };
    const { now } = t;
    /** @type {Map<string, ScheduleEntry>} */
    const entries = new Map();
    /** @type {Map<string, number>} The local time before which an entry is not fired: a backoff, a deferral */
    const retryAt = new Map();
    /** @type {Map<string, Recheck>} */
    const rechecks = new Map();
    /** @type {{ skewMs: number, rttMs: number, at: number }[]} */
    let samples = [];
    let skewMs = 0;
    let lastSkewWarnAt = -Infinity;
    let started = false;
    let stopped = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    /** @type {Promise<void> | null} */
    let current = null;
    /** The fires fail: the first failure is logged as an error, the next ones as debug, until a fire succeeds */
    let failing = false;
    let registerDelayMs = 0;
    /** The local time of the last fallback sample (a slow round trip): one per window, while no good sample comes */
    let seededAt = -Infinity;
    /** @type {{ local: number, monotonic: number } | null} The clocks at the last sample */
    let lastClocks = null;
    /** @type {Set<string>} The schedules that failed alone (the bisect found them): logged once until they succeed */
    const failingIds = new Set();
    /** The fires succeed again after failures: the next results log it */
    let recovering = false;

    /** @returns {number} The database time, as this process estimates it. */
    const dbTime = () => now() + skewMs;

    /**
     * @param {ClockSample | null} clock
     */
    function sample(clock) {
        if (!clock) {
            return;
        }

        const at = clock.receivedAt;

        checkStep();
        samples = samples.filter(kept => at - kept.at <= t.skewWindowMs && kept.at <= at);

        if (clock.receivedAt - clock.sentAt > t.skewSampleRttMs) {
            // Better than nothing while no sample with a short round trip comes: the first read of the registration,
            // then one per window
            if (!samples.length && at - seededAt >= t.skewWindowMs) {
                seededAt = at;
                skewMs = Math.round(clock.dbNowMs - ((clock.sentAt + clock.receivedAt) / 2));
            }

            return;
        }

        samples.push({
            skewMs: clock.dbNowMs - ((clock.sentAt + clock.receivedAt) / 2),
            rttMs: clock.receivedAt - clock.sentAt,
            at,
        });

        let best = samples[0];

        // A tie goes to the newest sample
        for (const kept of samples) {
            best = kept.rttMs <= best.rttMs ? kept : best;
        }

        skewMs = Math.round(best.skewMs);

        if (Math.abs(skewMs) > t.skewWarnMs && at - lastSkewWarnAt >= t.skewWindowMs) {
            lastSkewWarnAt = at;
            logger?.warn({ skewMs }, 'sqlane: the clock of this process differs from the database clock');
        }
    }

    /**
     * The process clock jumped against the monotonic clock: the samples before the jump are dropped. A backward jump
     * can only be a step (NTP): the skew moves by it. A forward jump is a step or a suspend (sleep, a VM pause), during
     * which the monotonic clock stops: the wall clock is then right, so the skew stays. After a forward step, the next
     * fire comes back deferred, and its sample corrects the skew.
     */
    function checkStep() {
        const local = now();
        const monotonic = t.monotonic();

        if (lastClocks) {
            const stepMs = (local - lastClocks.local) - (monotonic - lastClocks.monotonic);

            if (Math.abs(stepMs) > CLOCK_STEP_MS) {
                skewMs -= stepMs < 0 ? Math.round(stepMs) : 0;
                samples = [];
                seededAt = -Infinity;
            }
        }

        lastClocks = { local, monotonic };
    }

    /**
     * @param {ScheduleEntry} entry
     * @param {number} slot
     * @returns {SlotCandidate}
     */
    function candidateOf(entry, slot) {
        return {
            id: entry.id,
            name: entry.name,
            spec: entry.spec,
            slot,
            due: entry.jitterMs ? dueOf(entry, slot) : slot,
            missed: entry.missed,
            overlap: entry.overlap,
            catchUpFrom: (previousSlot(entry, slot) ?? -Infinity) - t.catchUpReachMs,
        };
    }

    /**
     * @param {SlotCandidate} candidate
     * @param {boolean} late Due now; on time: due at the slot.
     * @returns {import('./new_job.js').NewJob}
     */
    function buildJob(candidate, late) {
        const entry = /** @type {ScheduleEntry} */ (entries.get(candidate.id));
        const at = new Date(candidate.slot);
        const slot = entry.key === null ? { at } : { at, key: entry.key };
        /** @type {import('./types.js').EnqueueOptions} */
        let options = late ? { slot } : { slot, runAt: new Date(candidate.due) };

        // A late catch-up keeps its jitter: the schedules do not all run in the same second after an outage
        if (late && entry.jitterMs) {
            options = { slot, delay: candidate.due - candidate.slot };
        }

        return buildNewJob({
            name: entry.name,
            definition: entry.definition,
            defaults,
            payload: entry.payload,
            options,
            maxPayloadBytes,
        });
    }

    /** A fire or a read succeeded: after failures, the next results log the recovery once */
    function recovered() {
        if (failing) {
            failing = false;
            recovering = true;
        }
    }

    /**
     * @param {unknown} error
     * @param {{ id: string }[]} candidates The schedules of the failure.
     */
    function logFailure(error, candidates) {
        const details = { error, schedules: candidates.length, ids: candidates.slice(0, 10).map(({ id }) => id) };

        if (failing) {
            logger?.debug(details, 'sqlane: schedules could not enqueue their slots');

            return;
        }

        failing = true;
        logger?.error(details, 'sqlane: schedules could not enqueue their slots');
        emit({ type: 'error', operation: 'schedule', error });
    }

    /**
     * @param {SlotCandidate[]} chunk
     * @returns {Promise<FireResult>}
     */
    function fireOnce(chunk) {
        return store.fireSlots({
            candidates: chunk,
            buildJob,
            notifyChannel,
            now,
            graceMs: t.graceMs,
            futureMs: t.futureMs,
        });
    }

    /**
     * Fires a chunk. A transient error retries it once; a connection error fails it; another error splits it.
     * @param {SlotCandidate[]} chunk
     * @param {FireOutcome} outcome Filled in.
     * @returns {Promise<boolean>} False: the database cannot be reached: the rest is not tried.
     */
    async function fireChunk(chunk, outcome) {
        /** @type {FireResult} */
        let result;

        try {
            try {
                result = await fireOnce(chunk);
            } catch (error) {
                if (!isTransientDbError(error) || stopped) {
                    throw error;
                }

                result = await fireOnce(chunk);
            }
        } catch (error) {
            if (isConnectionError(error)) {
                logFailure(error, chunk);
                outcome.failed.push(...chunk);

                return false;
            }

            if (stopped) {
                logFailure(error, chunk);
                outcome.failed.push(...chunk);

                return false;
            }

            if (chunk.length === 1) {
                // The bisect found it: one error and one event per bad schedule, until a slot of it is decided; its
                // next backoff steps log at debug. The other schedules are not failing.
                const [{ id }] = chunk;

                if (failingIds.has(id)) {
                    logger?.debug({ error, scheduleId: id }, 'sqlane: a schedule could not enqueue its slot');
                } else {
                    failingIds.add(id);
                    logger?.error({ error, scheduleId: id }, 'sqlane: a schedule could not enqueue its slot');
                    emit({ type: 'error', operation: 'schedule', error });
                }

                outcome.failed.push(...chunk);

                return true;
            }

            // Bisect: one bad schedule does not block the others
            const middle = Math.ceil(chunk.length / 2);
            const halves = [chunk.slice(0, middle), chunk.slice(middle)];

            return fireInTurn(halves, outcome);
        }

        recovered();
        sample(result.clock);
        outcome.dbNowMs = result.clock?.dbNowMs ?? outcome.dbNowMs;
        outcome.decided.push(...result.decided);
        outcome.busy.push(...result.busy);
        outcome.deferred.push(...result.deferred);

        return true;
    }

    /**
     * Fires the chunks one after the other. After a stop, or a connection error, the rest fails without a try.
     * @param {SlotCandidate[][]} chunks
     * @param {FireOutcome} outcome Filled in.
     * @returns {Promise<boolean>} False: stopped, or the database cannot be reached.
     */
    async function fireInTurn(chunks, outcome) {
        for (const [index, chunk] of chunks.entries()) {
            if (stopped) {
                outcome.failed.push(...chunks.slice(index).flat());

                return false;
            }

            // oxlint-disable-next-line no-await-in-loop -- one transaction at a time
            if (!(await fireChunk(chunk, outcome))) {
                outcome.failed.push(...chunks.slice(index + 1).flat());

                return false;
            }
        }

        return true;
    }

    /**
     * Fires the candidates in chunks of `batch`, in id order, and applies the results.
     * @param {SlotCandidate[]} candidates
     * @returns {Promise<void>}
     */
    async function fire(candidates) {
        if (!candidates.length) {
            return;
        }

        const sorted = candidates.toSorted((a, b) => (a.id < b.id ? -1 : 1));
        /** @type {FireOutcome} */
        const outcome = { decided: [], busy: [], deferred: [], failed: [], dbNowMs: null };

        const chunks = [];

        for (let start = 0; start < sorted.length; start += t.batch) {
            chunks.push(sorted.slice(start, start + t.batch));
        }

        await fireInTurn(chunks, outcome);
        apply(candidates, outcome);
    }

    /**
     * @param {SlotCandidate[]} candidates
     * @param {FireOutcome} outcome
     */
    function apply(candidates, outcome) {
        const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
        const localNow = now();
        const dbNow = dbTime();
        /** @type {Set<string>} */
        const createdNames = new Set();

        if (recovering && !failing) {
            recovering = false;
            logger?.info(
                { late: outcome.decided.filter(decided => decided.late).length },
                'sqlane: schedules enqueue their slots again',
            );
        }

        for (const decided of outcome.decided) {
            const entry = entries.get(decided.id);

            rechecks.delete(decided.id);
            failingIds.delete(decided.id);

            if (!entry) {
                continue;
            }

            entry.retryDelayMs = 0;
            retryAt.delete(entry.id);
            entry.nextAt = advance(entry, decided.slot, dbNow);

            if (decided.created) {
                createdNames.add(decided.name);
            }

            if (decided.outcome === 'enqueued' || decided.outcome === 'skipped') {
                emit({
                    type: 'schedule_fired',
                    scheduleId: decided.id,
                    jobName: decided.name,
                    scheduledAt: new Date(decided.slot),
                    late: decided.late,
                    jobId: decided.jobId,
                });
            }
        }

        for (const id of outcome.busy) {
            const entry = entries.get(id);
            const candidate = /** @type {SlotCandidate} */ (byId.get(id));
            const known = rechecks.get(id);
            const delayMs = known ? Math.min(known.delayMs * 2, t.maxRecheckMs) : t.recheckMs;

            if (!entry) {
                continue;
            }

            const recheck = known ?? { candidate, at: 0, delayMs, since: localNow, warned: false };

            recheck.candidate = { ...candidate, insertMissing: false };
            recheck.at = localNow + delayMs;
            recheck.delayMs = delayMs;

            if (!recheck.warned && localNow - recheck.since > t.graceMs) {
                recheck.warned = true;
                logger?.warn(
                    { scheduleId: id, busyMs: localNow - recheck.since },
                    'sqlane: the row of a schedule stays locked by another transaction',
                );
            }

            rechecks.set(id, recheck);
            entry.nextAt = advance(entry, candidate.slot, dbNow);
        }

        for (const id of outcome.deferred) {
            const candidate = /** @type {SlotCandidate} */ (byId.get(id));
            const entry = entries.get(id);
            const dbNowMs = outcome.dbNowMs ?? dbNow;
            const waitMs = candidate.due - dbNowMs;
            // The entry waits for its earliest tracked slot, not for the deferred one: after a forward step of the
            // process clock, the slots before the deferred one come first, with the skew that this fire corrected
            const nextAt = entry?.nextAt ?? null;
            const entryWaitMs = Math.min(waitMs, entry && nextAt !== null ? dueAt(entry, nextAt) - dbNowMs : Infinity);

            retryAt.set(id, localNow + Math.max(entryWaitMs, MIN_DEFER_MS));

            const recheck = rechecks.get(id);

            // A recheck that comes back deferred waits for its slot: no read and fire in a loop
            if (recheck) {
                recheck.at = localNow + Math.max(waitMs, MIN_DEFER_MS);
            }

            // The deferred slot stays tracked
            if (entry?.jitterMs) {
                entry.nextAt = candidate.slot;
            }
        }

        for (const candidate of outcome.failed) {
            const entry = entries.get(candidate.id);

            if (!entry) {
                continue;
            }

            entry.retryDelayMs = Math.min(entry.retryDelayMs ? entry.retryDelayMs * 2 : t.retryMs, t.maxRetryMs);
            retryAt.set(entry.id, localNow + entry.retryDelayMs);
            // Kept due: the next tick recomputes its latest slot
            entry.nextAt = Math.min(entry.nextAt ?? candidate.slot, candidate.slot);

            const recheck = rechecks.get(candidate.id);

            if (recheck) {
                recheck.at = localNow + entry.retryDelayMs;
            }
        }

        for (const name of createdNames) {
            onCreated(name);
        }
    }

    /**
     * The busy rows: read them, then fire again those that nobody decided.
     * @param {Recheck[]} due
     * @returns {Promise<void>}
     */
    async function recheckBusy(due) {
        /** @type {ScheduleRead} */
        let read;

        try {
            read = await store.readSchedules(due.map(({ candidate }) => candidate.id), now);
        } catch (error) {
            logFailure(error, due.map(({ candidate }) => candidate));

            for (const known of due) {
                known.delayMs = Math.min(known.delayMs * 2, t.maxRecheckMs);
                known.at = now() + known.delayMs;
            }

            return;
        }

        recovered();
        sample(read.clock);

        const rowsById = new Map(read.rows.map(row => [row.id, row]));
        const dbNowMs = read.clock.dbNowMs;
        /** @type {SlotCandidate[]} */
        const again = [];

        for (const { candidate } of due) {
            const row = rowsById.get(candidate.id);

            if (row && row.lastSlotMs >= candidate.slot) {
                // The holder took the slot: the usual case
                rechecks.delete(candidate.id);
            } else if (!row && dbNowMs - candidate.due > t.graceMs) {
                // A late slot never creates a row
                rechecks.delete(candidate.id);
            } else {
                again.push({ ...candidate, insertMissing: !row });
            }
        }

        await fire(again);
    }

    async function tick() {
        timer = null;

        if (stopped) {
            return;
        }

        t.onWake?.();
        checkStep();

        const due = [...rechecks.values()].filter(known => known.at <= now());

        if (due.length) {
            await recheckBusy(due);
        }

        const nowMs = dbTime();
        const localNow = now();
        /** @type {SlotCandidate[]} */
        const candidates = [];

        for (const entry of entries.values()) {
            if (stopped || entry.nextAt === null || dueAt(entry, entry.nextAt) > nowMs
                || (retryAt.get(entry.id) ?? 0) > localNow) {
                continue;
            }

            retryAt.delete(entry.id);

            const slot = latestDue(entry, nowMs);

            if (slot !== null && (nowMs - dueAt(entry, slot) <= t.graceMs || entry.missed === 'once')) {
                candidates.push(candidateOf(entry, slot));
            } else if (entry.jitterMs && slot !== null) {
                // Late, with missed: 'skip': nothing to write
                entry.nextAt = nextSlot(entry, slot);
            } else {
                entry.nextAt = nextSlot(entry, nowMs);
            }
        }

        await fire(candidates);
    }

    function arm() {
        if (stopped) {
            return;
        }

        if (timer) {
            clearTimeout(timer);
        }

        const localNow = now();
        const dbNow = dbTime();
        let delayMs = t.maxSleepMs;

        for (const entry of entries.values()) {
            const retry = retryAt.get(entry.id);

            if (retry !== undefined && retry > localNow) {
                delayMs = Math.min(delayMs, retry - localNow);
            } else if (entry.nextAt !== null) {
                delayMs = Math.min(delayMs, dueAt(entry, entry.nextAt) - dbNow);
            }
        }

        for (const known of rechecks.values()) {
            delayMs = Math.min(delayMs, known.at - localNow);
        }

        timer = setTimeout(() => {
            current = run(tick);
        }, Math.max(delayMs, 0));
        timer.unref();
    }

    /**
     * Runs a step, then arms the timer. A step never rejects.
     * @param {() => Promise<void>} step
     * @returns {Promise<void>}
     */
    async function run(step) {
        try {
            await step();
        } catch (error) {
            logger?.error({ error }, 'sqlane: the scheduler failed');
        }

        arm();
    }

    /**
     * @param {ScheduleRead} read
     * @returns {Promise<void>}
     */
    async function startWith(read) {
        sample(read.clock);

        const nowMs = dbTime();
        const rowsById = new Map(read.rows.map(row => [row.id, row]));
        /** @type {SlotCandidate[]} */
        const candidates = [];

        for (const entry of entries.values()) {
            let slot;

            if (entry.jitterMs) {
                // The latest slot whose due time has come; the next one to track may be before now
                ({ latest: slot, nextAt: entry.nextAt } = pendingSlots(entry, nowMs));
            } else {
                slot = latestSlot(entry, nowMs);
                entry.nextAt = nextSlot(entry, nowMs);
            }

            const row = rowsById.get(entry.id);

            // Only the candidates that the transaction would not reject anyway
            if (slot !== null && row && row.lastSlotMs < slot
                && (nowMs - dueAt(entry, slot) <= t.graceMs || (entry.missed === 'once' && row.spec === entry.spec))) {
                // Due: a failed fire keeps it
                entry.nextAt = slot;
                candidates.push(candidateOf(entry, slot));
            }
        }

        await fire(candidates);
    }

    /**
     * The registration failed at start(): retried with a backoff.
     * @returns {Promise<void>}
     */
    async function retryRegister() {
        timer = null;

        if (stopped) {
            return;
        }

        try {
            const read = await store.registerSchedules([...entries.values()], now);

            registerDelayMs = 0;
            failing = false;

            if (!stopped) {
                await startWith(read);
            }

            arm();
        } catch (error) {
            logFailure(error, []);
            armRegister();
        }
    }

    function armRegister() {
        if (stopped) {
            return;
        }

        registerDelayMs = Math.min(registerDelayMs ? registerDelayMs * 2 : t.retryMs, t.maxRetryMs);
        timer = setTimeout(() => {
            current = retryRegister();
        }, registerDelayMs);
        timer.unref();
    }

    /**
     * Before start(): the next slot to track, as start() will find it.
     * @param {ScheduleEntry} entry
     * @returns {number | null}
     */
    function nextBeforeStart(entry) {
        return entry.jitterMs ? pendingSlots(entry, dbTime()).nextAt : nextSlot(entry, dbTime());
    }

    return {
        add: (entry) => {
            if (entries.has(entry.id)) {
                throw new ConfigError(`schedule(${JSON.stringify(entry.name)}): the schedule "${entry.id}" exists already`);
            }

            entries.set(entry.id, entry);
        },
        prepare: () => {
            for (const entry of entries.values()) {
                const where = `schedule(${JSON.stringify(entry.id)})`;
                const known = findDefinition(entry.name);

                if (entry.definition && known && known !== entry.definition) {
                    throw new ConfigError(`${where}: another definition of "${entry.name}" is in "jobs" or handled`);
                }

                entry.definition ??= known;

                if (!entry.definition && unknownJobs === 'reject') {
                    throw new ConfigError(`${where}: the job "${entry.name}" is not in "jobs" and not handled`);
                }

                try {
                    buildJob(candidateOf(entry, 0), true);
                } catch (error) {
                    if (error instanceof InvalidOptionsError || error instanceof PayloadTooLargeError
                        || error instanceof InvalidMutexKeyError) {
                        throw new ConfigError(`${where}: ${error.message}`, { cause: error });
                    }

                    throw error;
                }
            }
        },
        register: () => store.registerSchedules([...entries.values()], now),
        reportFailure: (error) => {
            logFailure(error, [...entries.values()]);
        },
        start: (read) => {
            if (stopped || started || !entries.size) {
                return;
            }

            started = true;

            if (read === null) {
                failing = true;
                armRegister();

                return;
            }

            current = run(() => startWith(read));
        },
        stop: async () => {
            stopped = true;

            if (timer) {
                clearTimeout(timer);
                timer = null;
            }

            await current;
        },
        list: async () => {
            /** @type {import('./store/fire_slots.js').ScheduleRow[]} */
            let rows = [];

            try {
                const read = await store.readSchedules(null, now);

                sample(read.clock);
                ({ rows } = read);
            } catch (error) {
                // No table yet: no rows
                if (!isMissingTableError(error)) {
                    throw error;
                }
            }

            const rowsById = new Map(rows.map(row => [row.id, row]));
            const ids = [...new Set([...rowsById.keys(), ...entries.keys()])].toSorted();

            return ids.map((id) => {
                const row = rowsById.get(id);
                const entry = entries.get(id);
                const nextAt = entry && (started ? entry.nextAt : nextBeforeStart(entry));
                const known = entry !== undefined && nextAt !== null && nextAt !== undefined;

                return {
                    id,
                    name: row?.jobName ?? /** @type {ScheduleEntry} */ (entry).name,
                    spec: row?.spec ?? /** @type {ScheduleEntry} */ (entry).spec,
                    registered: Boolean(entry),
                    nextAt: known ? new Date(nextAt) : null,
                    nextRunAt: known ? new Date(dueAt(entry, nextAt)) : null,
                    lastSlotAt: row ? new Date(row.lastSlotMs) : null,
                    lastJobId: row?.lastJobId ?? null,
                };
            });
        },
        size: () => entries.size,
    };
}
