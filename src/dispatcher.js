// The dispatcher of a process: one loop that finds the due jobs of the handled names, claims as many as the free slots
// allow, by the share of their names, and starts them. See docs/design.md › Dispatcher: one loop per process, Claim.
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigError } from './errors.js';
import { chooseRows, fill, rankNames, replayTie, shareNamesOfRequests } from './fair_share.js';
import { incrementUs, waitUs } from './gcra.js';
import { ANY_NAME } from './hint_channel.js';
import { limitsRoom, localLimitsOf, roomOf, shareNamesOf } from './local_limits.js';
import { isRateKey } from './rate_keys.js';
import { isQuickRetryError } from './transient_error.js';
import { createMonotonicUlid } from './ulid.js';

/** @typedef {import('./store/store.js').ClaimedJob} ClaimedJob */
/** @typedef {import('./registry.js').HandlerEntry} HandlerEntry */
/** @typedef {import('./local_limits.js').LocalLimit} LocalLimit */

/** A turn that fails with a deadlock-like error is retried at once this many times, then reported and backed off */
const MAX_TRANSIENT_DISPATCH_RETRIES = 3;
/** The pause before such a retry: 5 to 30 ms, so that the claims that collided do not collide again */
const TRANSIENT_RETRY_MIN_MS = 5;
const TRANSIENT_RETRY_JITTER_MS = 25;
/**
 * A claim requests at most this many names per free slot, the furthest under their share first: a claim locks up to
 * the free slots of each name it requests, and the next names take the slots of a name whose due jobs are held
 * elsewhere. More due names wait for the next turns.
 */
const CLAIM_NAMES_PER_SLOT = 4;

/**
 * @typedef {object} Dispatcher
 * @property {(names?: readonly string[], options?: { speculative?: boolean }) => void} wake Ends the sleep of the
 *     loop. The next turn looks at the given names, or at all names.
 * @property {() => void} prepare For start() and drain(), after the check of the registry: reads the handled names,
 *     and starts the tie pointer at a random name.
 * @property {(serverCheck?: (() => Promise<void>) | null) => Promise<void>} run The loop: one turn after the other,
 *     while the runner is started. An error of a turn is retried, or reported and backed off. `serverCheck`: the check
 *     of the server that start() could not run (the database was down): no turn before it passes; a `ConfigError` of
 *     it ends the loop.
 * @property {(dueNames: string[]) => Promise<{ candidates: number, claimed: number }>} claimAndStart Claims the due
 *     jobs of the names, by share within the free slots, and starts them. For drain().
 * @property {(entry: HandlerEntry) => number} freeSlots The jobs of the name that can start now: under its local
 *     limits and the instance's cap.
 * @property {() => boolean} claiming A claim runs: it may have counted the free slots before a job ended.
 */

/**
 * @param {object} params
 * @param {import('./store/store.js').Store} params.store
 * @param {import('./registry.js').Registry} params.registry
 * @param {number} params.localMaxConcurrency The instance's cap.
 * @param {ReadonlyMap<string, unknown>} params.running The jobs that run in this process: each takes a slot.
 * @param {{ leaseMs: number, pollIntervalMs: number }} params.timings
 * @param {() => number} params.random The random start of the tie pointer.
 * @param {() => import('./runner.js').RunnerState} params.state
 * @param {import('./types.js').Logger | undefined} params.logger
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @param {(claimed: ClaimedJob, payload: { found: boolean, payload: unknown }) => void} params.startJob Takes a slot
 *     of the instance and of the local limits of its name, and runs the job.
 * @param {(keys: readonly string[]) => Promise<void>} params.unblockKeys The unblock of the concurrency keys: never
 *     rejects.
 * @param {(key: string, delayMs: number) => void} params.armRateWake The timer of a rate key with blocked jobs.
 * @param {(entry: HandlerEntry) => void} params.wakeAfterRates Its local rate limits that admit no start now: a wake of
 *     their names when one may start.
 * @returns {Dispatcher}
 */
export function createDispatcher({
    store,
    registry,
    localMaxConcurrency,
    running,
    timings: t,
    random,
    state,
    logger,
    reportError,
    startJob,
    unblockKeys,
    armRateWake,
    wakeAfterRates,
}) {
    const lockedBy = `${hostname()}:${process.pid}:${createMonotonicUlid()()}`;
    const lockToken = createMonotonicUlid();
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
    /** @type {(() => void) | null} */
    let endSleep = null;
    let contentionDelayMs = 0;
    /** The tie pointer: equal shares go round-robin from it. Random at the start: a fleet breaks ties differently */
    let tiePointer = 0;
    /** The handled names, counted at start() or drain(): the span of the tie order */
    let handledCount = 1;
    /** The last claim left due names out: the next turn runs at once, for them */
    let namesLeftOut = false;
    let claimsInFlight = 0;

    // ---- wakes ----

    /**
     * Ends the sleep of the dispatcher. The next turn looks at the given names, or at all names.
     * @param {readonly string[]} [names] The names that may have ready jobs. None, or `*`: all names.
     * @param {{ speculative?: boolean }} [options] speculative: the jobs may not be visible yet, or there may be none
     *     (a claim on MySQL is a transaction of several statements): a probe first. Else the turn claims at once.
     */
    function wake(names, { speculative = false } = {}) {
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
        if (wakeCount !== seenWakes || state() !== 'started') {
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

        // A set: a probe of many names reads all names (MySQL, MariaDB), those of `direct` too. A name requested twice
        // would lock and claim its jobs twice
        const due = new Set(direct);

        for (const row of probe) {
            if (row.delayMs > 0) {
                schedule(row.name, now + row.delayMs);
            } else {
                // Probed again at the next turns, until none is due
                backlog.add(row.name);

                if (names.has(row.name)) {
                    due.add(row.name);
                }
            }
        }

        if (!due.size) {
            return nextDelayMs();
        }

        namesLeftOut = false;

        const { candidates, claimed } = await claimAndStart([...due]);

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

    /** @type {Dispatcher['run']} */
    async function run(serverCheck = null) {
        /** The transient errors in a row that the next turns retry at once */
        let transientRetries = 0;
        let pendingCheck = serverCheck;

        while (state() === 'started') {
            const seenWakes = wakeCount;
            let delayMs;

            if (pendingCheck) {
                try {
                    // oxlint-disable-next-line no-await-in-loop -- once, before the first turn
                    await pendingCheck();
                    pendingCheck = null;
                } catch (error) {
                    reportError('server_check', error);

                    if (error instanceof ConfigError) {
                        // A wrong dialect or an unsupported version: no claim, ever
                        return;
                    }

                    // oxlint-disable-next-line no-await-in-loop -- one try after the other
                    await sleepUntilWake(Math.min(t.pollIntervalMs, 1000), seenWakes);
                    continue;
                }
            }

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

    return {
        wake,
        prepare: () => {
            namesWithLimits = new Set(registry.namesWithLimits());
            namesWithRates = new Set(registry.namesWithRateLimits());
            entriesWithLocalRates = registry.entries().filter(entry => entry.rates.length);
            handledCount = Math.max(registry.entries().length, 1);
            tiePointer = Math.floor(random() * handledCount);
        },
        run,
        claimAndStart,
        freeSlots,
        claiming: () => claimsInFlight > 0,
    };
}
