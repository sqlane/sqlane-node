// The store: the SQL of one dialect, bound to an adapter and a table prefix.
import { setTimeout as sleep } from 'node:timers/promises';
import { getJob, listJobs } from './job_reads.js';
import { keyStats } from './key_stats.js';
import * as mariadbFinal from './mariadb_final.js';
import * as mariadbSchedules from './mariadb_schedules.js';
import * as mariadbWorker from './mariadb_worker.js';
import * as mysqlFinal from './mysql_final.js';
import * as mysqlSchedules from './mysql_schedules.js';
import * as mysqlWorker from './mysql_worker.js';
import * as postgresFinal from './postgres_final.js';
import * as postgresSchedules from './postgres_schedules.js';
import * as postgresWorker from './postgres_worker.js';
import { createPauseStore } from './pauses.js';
import { isRateKey } from '../rate_keys.js';
import { isQuickRetryError, isUnknownSystemVariableError } from '../transient_error.js';

/**
 * A sweep of the slots that fails with a deadlock-like error runs again at once this many times, after 5 to 30 ms, as a
 * turn of the dispatcher; then it rejects
 */
const MAX_SWEEP_RETRIES = 3;
const SWEEP_RETRY_MIN_MS = 5;
const SWEEP_RETRY_JITTER_MS = 25;
/** @type {SweepParts} */
const ALL_SWEEP_PARTS = { lingers: true, orphans: true, blocked: true };

/**
 * @typedef {object} ProbeRow
 * @property {string} name A lane with pending jobs.
 * @property {number} delayMs Until its oldest pending job is due: 0 or less means due now.
 */

/**
 * A fair group of a lane with pending jobs, by `probeGroups`.
 * @typedef {object} GroupProbeRow
 * @property {string} lane
 * @property {string | null} group Null: the jobs without a group.
 * @property {number} delayMs Until its oldest pending job is due: 0 or less means due now.
 */

/**
 * @typedef {object} Candidate
 * @property {string} id
 * @property {string} lane
 * @property {number} runAtMs
 */

/**
 * The due jobs of lanes with global limits: those whose keys have room, at most the asked number per lane, and those
 * with a full key, which a claim blocks. A rate key is full for the jobs that its quota does not allow, after the older
 * jobs of the search, and for the jobs behind an older job blocked on it.
 * @typedef {{ startable: Candidate[], full: Candidate[] }} FoundCandidates
 */

/**
 * The candidates of a search, with the lanes of the returned jobs that have rate keys when it left them out.
 * @typedef {FoundCandidates & { ratedLanes: string[] }} FoundCandidatesOf
 */

/**
 * A job that a claim locked, and then claimed: it runs.
 * @typedef {object} ClaimedJob
 * @property {string} id
 * @property {string} lane
 * @property {import('../concurrency_keys.js').GlobalLimit[]} limits Its global limits, sorted by key.
 * @property {import('../rate_keys.js').GlobalRateLimit[]} rateLimits Its global rate limits, sorted by key.
 * @property {number} attempts The failed attempts so far.
 * @property {number} maxAttempts
 * @property {number} stalls
 * @property {number} maxStalls Below `stalls`: its last stall was past its max, so its claim fails it, without its
 *     limits and its rate limits.
 * @property {Date} enqueuedAt
 * @property {Date} runAt Its due time, as stored: its place in line.
 * @property {Date} startedAt The database time of the claim, as stored in `started_at`; also the time of its new slots.
 * @property {number} waitedMs Since it was due.
 * @property {string} lockToken
 * @property {string | null} fairGroup Its fair group, read when the claim asks for it (`withFairGroups`); else null.
 */

/**
 * @typedef {object} ClaimParams
 * @property {string[]} candidateIds
 * @property {string[]} fullIds Due jobs with a full key: blocked, if a key is still full.
 * @property {string} lockToken Of this claim.
 * @property {string} lockedBy The process.
 * @property {number} leaseMs
 * @property {(locked: ClaimedJob[], held: Map<string, number>, debts: Map<string, number>) => ClaimedJob[]} pick
 *     The jobs to take among the locked ones whose keys have room (in the order of run_at), given the held slots of
 *     their keys and the debts of their rate keys (µs, gcra.js): the free slots, fewer jobs on each key than its max,
 *     and the quota of each rate key, with the picked ones.
 * @property {boolean} [withRates] The candidates may have rate keys (their lanes are known to): PostgreSQL locks the
 *     rows of the rate keys in the statement that locks the jobs. Without, a statement of its own, if they have some.
 * @property {readonly string[] | null} [pausedLanes] MySQL and MariaDB: the paused lanes of the last probe, for the
 *     heads of the rate keys (`pausedFilter`). Set by the store.
 * @property {boolean} [withFairGroups] The schema has `0011_fair_groups`: the claimed jobs have their fair group.
 */

/** @typedef {import('../gcra.js').RateWait} RateWait */

/**
 * A rate key after an unblock, with its debt after the jobs that the unblock made pending (null: none). `left`: blocked
 * jobs are left; else the next unblock is a check, for a job blocked during this one.
 * @typedef {RateWait & { debtUs: number | null, left: boolean }} RateUnblockWait
 */

/**
 * @typedef {object} ClaimResult
 * @property {ClaimedJob[]} jobs The claimed jobs, in the order of run_at.
 * @property {string[]} blockedKeys The keys on which the claim blocked jobs, of both kinds.
 * @property {string[]} blockedLanes The lanes of the blocked jobs.
 * @property {RateWait[]} rateWaits The rate keys on which the claim blocked the first jobs: when the oldest may start.
 */

/**
 * One request of a claim of due jobs: a lane without global limits, and what its share needs.
 * @typedef {object} DueRequest
 * @property {string} name
 * @property {number} maxJobs At most this many of its jobs: the minimum of the rooms of its local limits and the
 *     free slots.
 * @property {number} running Its jobs that run in this instance.
 * @property {number} weight Its fairShareWeight.
 * @property {number[]} limits Its local limits, as indexes in `limitRooms`.
 * @property {number} tie Its place in the order of the ties.
 * @property {import('../fair_groups.js').GroupRequest[]} [groups] A lane with fair groups: the groups to lock the
 *     oldest due jobs of, in the order of `requestGroups` (fair_groups.js). Its rows rank in the order of `fill()` over
 *     them, and the claim takes at most its `maxJobs`. Never empty.
 */

/**
 * @typedef {object} ClaimDueParams
 * @property {DueRequest[]} requests
 * @property {number[]} limitRooms The free slots of each local limit.
 * @property {number} free The free slots of the instance for this claim.
 * @property {string} lockToken Of this claim.
 * @property {string} lockedBy The process.
 * @property {number} leaseMs
 * @property {(locked: StartableJob[]) => StartableJob[]} choose MySQL and MariaDB: the jobs to take among the locked
 *     ones (in the order of run_at), by share. PostgreSQL makes the same choice in SQL.
 * @property {boolean} [withFairGroups] The schema has `0011_fair_groups`: the claimed jobs have their fair group. Set
 *     with a request that has `groups`.
 */

/**
 * A claimed job with its payload.
 * @typedef {ClaimedJob & { payload: { found: boolean, payload: unknown } }} StartableJob
 */

/**
 * @typedef {object} ClaimDueResult
 * @property {StartableJob[]} jobs The claimed jobs, in the order of run_at.
 * @property {ProbeRow[] | null} next The next due time of the requested lanes with pending jobs that the claim did not
 *     take: zero or less, more of their jobs are due. It may give other lanes too. Null: the claim filled the free
 *     process slots and did not read them.
 * @property {string[]} [unpicked] PostgreSQL: the requested lanes with a locked row that the claim did not take, under
 *     any cap. The runner replays the choice with them, to move the tie pointer as the choice did.
 * @property {string[]} limited The requested lanes with a locked row with global limits (from its enqueue options):
 *     not taken, they need the claim of lanes with global limits.
 * @property {Map<string, (string | null)[]>} [leftGroups] PostgreSQL, a claim with grouped lanes: the groups of each
 *     grouped lane with a locked row that the claim did not take. The runner replays the choice of its groups with
 *     them, to move the pointer of the lane's groups.
 */

/**
 * A job that this process claimed: every write of it checks the lock token.
 * @typedef {object} OwnedJob
 * @property {string} id
 * @property {string} lockToken
 */

/**
 * A job that this process ran, with its global limits.
 * @typedef {OwnedJob & { limits?: readonly import('../concurrency_keys.js').GlobalLimit[] }} FinishedJob
 */

/**
 * The job that fails for good, as the failure job gets it.
 * @typedef {object} FailedJob
 * @property {string} id
 * @property {string} lane
 * @property {unknown} payload Null: its payload is missing.
 * @property {number} attempt
 * @property {number} maxAttempts
 * @property {import('../error_json.js').ErrorJson} error
 */

/**
 * The failure job of a job that fails for good, by the definition of its lane in the process that fails it.
 * @typedef {object} FailureJobBuilder
 * @property {string | null} lane Its failure lane; null: none.
 * @property {(failed: FailedJob) => import('../new_job.js').NewJob} build Its options from the definition of the
 *     failure lane, else the defaults; no failure lane of its own.
 */

/**
 * @typedef {{ added: import('../new_job.js').NewJob } | { notAdded: unknown, failureLane: string }} FailureJobResult
 */

/**
 * The result of the recovery of a stale job. `attempt`: the attempt of the run that stalled (1 for the first run).
 * @typedef {{ result: null } | { result: 'released', attempt: number }} StaleJobResult
 */

/**
 * @typedef {object} FailParams
 * @property {import('../error_json.js').ErrorJson} error
 * @property {FailureJobBuilder} failureJob
 * @property {boolean} attemptUsed False: a job past its `maxStalls`, failed at its claim, without a run.
 */

/**
 * The counts of a lane with jobs: `lanes.stats()` adds its pause.
 * @typedef {Omit<import('../types.js').LaneStats, 'pausedGlobally'>} LaneCounts
 */

/**
 * The store. Wherever a claim chooses a lane (the probe, the search of candidates, the claims, the heads of the keys,
 * the unblocks, `makeDue`), it skips the paused lanes (`<p>paused_lanes`, pauses.js); the sweep's scan of the keys
 * does not.
 * @typedef {StoreMethods & import('./pauses.js').PauseStore & { forgetPausedLanes: () => void }} Store The paused
 *     lanes of the last probe stand for the reads of the blocked jobs until `forgetPausedLanes()` (a resume: its delete
 *     may not have committed) or for `pausedSeenMs`.
 */

/**
 * @typedef {object} StoreMethods
 * @property {(lanes: string[] | null) => Promise<ProbeRow[]>} probe The next due time of each given lane with
 *     pending jobs, not paused; null: of each lane. It may give other lanes too.
 * @property {(lanes: string[]) => Promise<GroupProbeRow[]>} probeGroups The groups of each given lane with pending
 *     jobs, and the next due time of each. Needs `0011_fair_groups`.
 * @property {(limitsByLane: Map<string, number>, ratedLanes?: Set<string>) => Promise<FoundCandidates>} findCandidates
 *     Of lanes with global limits: their oldest due jobs, at most 500 per lane. `ratedLanes`: the lanes that may have
 *     jobs with rate keys (`findCandidates` below); none: each search has the rate keys.
 * @property {(params: ClaimParams) => Promise<ClaimResult>} claim In a queue transaction of its own.
 * @property {(params: ClaimDueParams) => Promise<ClaimDueResult>} claimDue Finds, chooses by share, claims and reads
 *     the due jobs of lanes without global limits, at once: one statement on PostgreSQL. It leaves the rows with
 *     limits. A lane requested more than once counts once, by its first request.
 * @property {(keys: string[]) => Promise<string[]>} unblock Makes the jobs blocked on the concurrency keys pending
 *     again, the oldest first, as many as each key has room for: their lanes. It leaves the rate keys.
 * @property {(keys: string[], floors?: Map<string, number>)
 *     => Promise<{ lanes: string[], waits: RateUnblockWait[] }>} unblockRates Makes the jobs blocked on the rate keys
 *     pending again, the oldest first, as many as the quota of each key allows now (at most 500), after the debt of
 *     `floors` at least (µs: the jobs that an earlier unblock made pending, not claimed yet). Their lanes; and, of each
 *     key with blocked jobs, the time of its next unblock: when the oldest job left may start; with none left, a check
 *     for a job blocked during the unblock (gcra.js, `nextUnblockMs`).
 * @property {(ids: string[]) => Promise<Map<string, unknown>>} readPayloads
 * @property {(jobs: OwnedJob[], leaseMs: number) => Promise<Set<string>>} renewLeases
 * @property {(job: OwnedJob) => Promise<boolean>} markTimedOut
 * @property {(jobs: FinishedJob[]) => Promise<number>} completeJobs In one transaction (one statement on PostgreSQL):
 *     the jobs that it completed.
 * @property {(job: OwnedJob, params: { delayMs: number, error: import('../error_json.js').ErrorJson })
 *     => Promise<boolean>} retryJob
 * @property {(job: OwnedJob, params: FailParams)
 *     => Promise<{ changed: boolean, failureResult: FailureJobResult | null }>} failJob
 * @property {(job: OwnedJob, params: { delayMs: number, lingerMs: number }) => Promise<boolean>} releaseJob
 * @property {(job: OwnedJob, params: RateLimitedParams) => Promise<RateLimitedResult>} rateLimited The handler threw a
 *     RateLimitedError on global rate keys of the job: their next start is `retryAfter` from now at the earliest, the
 *     job is blocked on the first of them, without an attempt used; its slots are freed.
 * @property {(limit: number, withFairGroups?: boolean) => Promise<RecoveryWork>} findRecoveryWork One read, with no
 *     lock (`withFairGroups`: the schema has `0011_fair_groups`, the stale jobs have their group): the stale jobs, and
 *     the parts of the sweep that have work.
 * @property {(id: string, params: { leaseMs: number }) => Promise<StaleJobResult>} recoverStaleJob One more stall:
 *     the job is pending again, its slots linger for one lease. Past its `maxStalls`, it keeps its due time, so it is
 *     due at once, in its place in line: its next claim fails it.
 * @property {(limit: number, parts?: SweepParts) => Promise<SweepResult>} sweepSlots Deletes the ended lingers and
 *     the orphan slots, then unblocks the jobs blocked on keys with room, and on rate keys whose next start is due:
 *     the `parts` only (default: all). No part: no transaction. A deadlock, a serialization failure or a 1020 runs it
 *     again at once, up to 3 times.
 * @property {(limit: number) => Promise<number>} deleteIdleRateKeys Deletes a batch of rows of rate keys whose tat
 *     passed: the same as no row. SKIP LOCKED.
 * @property {(limit: number) => Promise<number>} deleteExpiredJobs
 * @property {(lanes: string[]) => Promise<void>} makeDue For drain({ includeDelayed }).
 * @property {() => Promise<LaneCounts[]>} getStats The counts of each lane with jobs.
 * @property {(id: string) => Promise<import('../types.js').JobRecord | null>} getJob A plain read, no lock.
 * @property {(params: import('./job_reads.js').ListParams) => Promise<{ jobs: import('../types.js').JobRecord[],
 *     last: { enqueuedAtMs: number, id: string } | null }>} listJobs A plain read, no lock.
 * @property {(params: import('./key_stats.js').KeyStatsParams)
 *     => Promise<import('../types.js').KeyStatsPage>} keyStats One statement on the queue's pool, no lock.
 * @property {(schedules: { id: string, lane: string, spec: string }[], now: () => number)
 *     => Promise<ScheduleRead>} registerSchedules Inserts the missing rows (2 statements per 500), then reads them.
 * @property {(ids: string[] | null, now: () => number) => Promise<ScheduleRead>} readSchedules A plain read, no
 *     lock; null: every row.
 * @property {(params: import('./fire_slots.js').FireParams) => Promise<import('./fire_slots.js').FireResult>}
 *     fireSlots In a queue transaction of its own.
 */

/**
 * @typedef {{ clock: import('./fire_slots.js').ClockSample, rows: import('./fire_slots.js').ScheduleRow[] }}
 *     ScheduleRead
 */

/**
 * @typedef {object} RateLimitedParams
 * @property {import('../rate_keys.js').GlobalRateLimit[]} limits Rate keys of the job, sorted by key.
 * @property {number} retryAfterMs
 * @property {import('../error_json.js').ErrorJson} error
 */

/**
 * @typedef {object} RateLimitedResult
 * @property {boolean} changed False: the lease was lost; nothing changed.
 * @property {number} delayMs The time until the job may start on the key that it is blocked on.
 */

/**
 * The parts of the sweep of the slots to run.
 * @typedef {object} SweepParts
 * @property {boolean} lingers Ended lingers.
 * @property {boolean} orphans Slots without their running job.
 * @property {boolean} blocked Jobs blocked on a key: concurrency or rate.
 */

/**
 * The work of a stall recovery, as one read found it.
 * @typedef {SweepParts & { stale: { id: string, lane: string, fairGroup: string | null }[], idleRateKeys: boolean }}
 *     RecoveryWork stale: the
 *     running jobs whose lease ended, the oldest first. idleRateKeys: rows of rate keys whose tat passed.
 */

/**
 * @typedef {object} SweepResult
 * @property {number} lingers
 * @property {number} orphans
 * @property {number} unblocked The lanes of the jobs that it unblocked.
 * @property {RateWait[]} rateWaits The rate keys whose due jobs it unblocked, and that have blocked jobs left: their
 *     timer was lost (a process stopped), so the sweeping process takes it over.
 */

/**
 * @param {import('../types.js').Adapter<any>} adapter
 * @param {string} tablePrefix Checked.
 * @param {import('../types.js').Logger} [logger]
 * @param {{ pausedSeenMs?: number }} [options] `pausedSeenMs`: how long the paused lanes of a probe stand for the
 *     reads of the blocked jobs (MySQL and MariaDB). Default: 5 s, the default poll interval.
 * @returns {Store}
 */
export function createStore(adapter, tablePrefix, logger, { pausedSeenMs = 5000 } = {}) {
    const { sql, final, schedules } = {
        mysql: { sql: mysqlWorker, final: mysqlFinal, schedules: mysqlSchedules },
        mariadb: { sql: mariadbWorker, final: mariadbFinal, schedules: mariadbSchedules },
        postgres: { sql: postgresWorker, final: postgresFinal, schedules: postgresSchedules },
    }[adapter.dialect];
    /**
     * @template T
     * @param {(executor: import('../types.js').Executor) => Promise<T>} func
     * @returns {Promise<T>}
     */
    const inQueue = func => adapter.queueTransaction(func);
    /** The SQL of the reads of sqlane.jobs: MariaDB shares the JSON and the times of MySQL */
    const family = adapter.dialect === 'postgres' ? 'postgres' : 'mysql';
    const p = tablePrefix;
    // MariaDB: false once the server rejects `innodb_snapshot_isolation` (a version without it)
    let snapshotIsolationOff = true;
    /**
     * MySQL and MariaDB: the paused lanes that the last probe read, for the reads of the blocked jobs (`pausedFilter`).
     * Null until a probe, and `pausedSeenMs` after it, or after a resume in this process: the reads check in SQL. So a
     * process that no longer probes (closed, idle between drains, without a runner) does not use an old list.
     * @type {string[] | null}
     */
    let pausedSeen = null;
    let pausedSeenAt = 0;
    /** @returns {string[] | null} The paused lanes of a recent probe; null: none recent. */
    const pausedRecently = () => (Date.now() - pausedSeenAt <= pausedSeenMs ? pausedSeen : null);

    /**
     * The search of candidates has the rate keys only for a lane in `ratedLanes`: by its definition, or seen here. The
     * part of the rate keys costs every search: PostgreSQL plans the statement at each call (a custom plan), and the
     * rate CTEs double that planning; MySQL and MariaDB run them on every search. The other search also returns the
     * jobs of its window that have rate keys (from their enqueue options): their lanes join `ratedLanes`, and the
     * search runs again with them. Without such a job its result is the same: a job without rate keys is never full by
     * rate.
     * @param {typeof postgresWorker | typeof mysqlWorker | typeof mariadbWorker} worker
     * @param {Map<string, number>} limitsByLane
     * @param {Set<string>} [ratedLanes] Grows with the lanes seen with rate keys. None: each search has the rate keys.
     * @returns {Promise<FoundCandidates>}
     */
    async function findCandidates(worker, limitsByLane, ratedLanes) {
        const withRates = !ratedLanes || [...limitsByLane.keys()].some(lane => ratedLanes.has(lane));
        const found = await worker.findCandidates(adapter.queue, p, limitsByLane, {
            withRates,
            paused: pausedRecently(),
        });

        if (withRates || !found.ratedLanes.length) {
            return { startable: found.startable, full: found.full };
        }

        for (const lane of found.ratedLanes) {
            ratedLanes?.add(lane);
        }

        const again = await worker.findCandidates(adapter.queue, p, limitsByLane, {
            withRates: true,
            paused: pausedRecently(),
        });

        return { startable: again.startable, full: again.full };
    }

    /**
     * @param {ClaimDueParams} params
     * @returns {Promise<ClaimDueResult>}
     */
    async function claimDueMariadb(params) {
        const claimOnce = () => inQueue(executor => mariadbWorker.claimDue(executor, p, params, {
            snapshotIsolationOff,
        }));

        try {
            return await claimOnce();
        } catch (error) {
            if (!snapshotIsolationOff || !isUnknownSystemVariableError(error)) {
                throw error;
            }

            snapshotIsolationOff = false;
            logger?.debug({ error }, 'sqlane: the server has no innodb_snapshot_isolation, claims without it');

            return claimOnce();
        }
    }

    /**
     * The sweep in a transaction. Its locks meet those of the claims, releases and other sweeps of the same slots, in
     * other orders: a deadlock (or a serialization failure, a 1020) says nothing about the next try, so it runs again
     * at once, as a turn of the dispatcher. Not a lock wait timeout: the lock is likely still held.
     * @param {number} limit
     * @param {SweepParts} parts
     * @returns {Promise<SweepResult>}
     */
    async function sweepSlots(limit, parts) {
        if (!parts.lingers && !parts.orphans && !parts.blocked) {
            return { lingers: 0, orphans: 0, unblocked: 0, rateWaits: [] };
        }

        for (let retry = 1; ; retry++) {
            try {
                // oxlint-disable-next-line no-await-in-loop -- one try after the other
                return await inQueue(executor => final.sweepSlots(executor, p, limit, parts));
            } catch (error) {
                if (!isQuickRetryError(error) || retry > MAX_SWEEP_RETRIES) {
                    throw error;
                }

                logger?.debug({ error, operation: 'sweep_slots', retry },
                    'sqlane: the sweep of the slots failed with a transient error, retried at once');
                // oxlint-disable-next-line no-await-in-loop -- one try after the other
                await sleep(SWEEP_RETRY_MIN_MS + (Math.random() * SWEEP_RETRY_JITTER_MS));
            }
        }
    }

    /** @type {(params: ClaimDueParams) => Promise<ClaimDueResult>} */
    const claimDueInQueue = adapter.dialect === 'mariadb'
        ? claimDueMariadb
        : params => inQueue(executor => sql.claimDue(executor, p, params));

    return {
        probe: async (lanes) => {
            if (adapter.dialect === 'postgres') {
                return postgresWorker.probe(adapter.queue, p, lanes);
            }

            const { rows, paused } = await (adapter.dialect === 'mysql' ? mysqlWorker : mariadbWorker)
                .probePaused(adapter.queue, p, lanes);

            if (paused) {
                pausedSeen = paused;
                pausedSeenAt = Date.now();
            }

            return rows;
        },
        probeGroups: lanes => sql.probeGroups(adapter.queue, p, lanes),
        findCandidates: (limitsByLane, ratedLanes) => findCandidates(sql, limitsByLane, ratedLanes),
        claim: params => adapter.queueTransaction(executor => sql.claim(executor, tablePrefix, {
            ...params,
            pausedLanes: pausedRecently(),
        })),
        claimDue: (params) => {
            // Each lane once: MySQL and MariaDB lock the rows of each request, so a lane requested twice would claim
            // its jobs twice. The first request of a lane counts
            const lanes = new Set();
            const requests = params.requests.filter((request) => {
                const first = !lanes.has(request.name);

                lanes.add(request.name);

                return first;
            });
            const unique = requests.length === params.requests.length ? params : { ...params, requests };

            return adapter.dialect === 'postgres'
                // One statement: a transaction of its own
                ? postgresWorker.claimDue(adapter.queue, p, unique)
                : claimDueInQueue(unique);
        },
        readPayloads: ids => sql.readPayloads(adapter.queue, tablePrefix, ids),
        renewLeases: (jobs, leaseMs) => inQueue(executor => final.renewLeases(executor, p, jobs, leaseMs)),
        markTimedOut: job => final.markTimedOut(adapter.queue, p, job),
        completeJobs: jobs => (adapter.dialect === 'postgres'
            ? postgresFinal.completeJobs(adapter.queue, p, jobs)
            : inQueue(executor => final.completeJobs(executor, p, jobs))),
        retryJob: (job, params) => inQueue(executor => final.retryJob(executor, p, job, params)),
        failJob: (job, params) => inQueue(executor => final.failJob(executor, p, job, params)),
        releaseJob: (job, params) => inQueue(executor => final.releaseJob(executor, p, job, params)),
        rateLimited: (job, params) => inQueue(executor => final.rateLimited(executor, p, job, params)),
        findRecoveryWork: async (limit, withFairGroups = false) => {
            const rows = await final.readRecoveryWork(adapter.queue, p, limit, withFairGroups);
            const [parts] = rows;

            return {
                // No stale job: one row with null ids
                stale: rows.filter(row => row.id !== null)
                    .map(row => ({
                        id: String(row.id),
                        lane: String(row.lane),
                        fairGroup: (row.fair_group ?? null) === null ? null : String(row.fair_group),
                    })),
                lingers: Number(parts.lingers) > 0,
                orphans: Number(parts.orphans) > 0,
                blocked: Number(parts.blocked) > 0,
                idleRateKeys: Number(parts.idle_rate_keys) > 0,
            };
        },
        recoverStaleJob: (id, params) => inQueue(executor => final.recoverStaleJob(executor, p, id, params)),
        unblock: (keys) => {
            // A rate key has no slots: its room is its quota (unblockRates)
            const slotKeys = keys.filter(key => !isRateKey(key));

            if (!slotKeys.length) {
                return Promise.resolve([]);
            }

            // One statement on PostgreSQL; on MySQL and MariaDB, a read, then a transaction only when a key has room
            return adapter.dialect === 'postgres'
                ? postgresFinal.unblock(adapter.queue, p, slotKeys)
                : final.unblock(adapter.queue, p, slotKeys, { inTransaction: inQueue, paused: pausedRecently() });
        },
        unblockRates: async (keys, floors) => {
            if (!keys.length) {
                return { lanes: [], waits: [] };
            }

            // One statement on PostgreSQL; on MySQL and MariaDB, a read, then a transaction only when a job may start
            const { lanes, waits } = adapter.dialect === 'postgres'
                ? await postgresFinal.unblockRates(adapter.queue, p, keys, { floors })
                : await final.unblockRates(adapter.queue, p, keys, {
                        inTransaction: inQueue,
                        floors,
                        paused: pausedRecently(),
                    });

            return { lanes, waits: waits.map(({ key, delayMs, debtUs, left }) => ({ key, delayMs, debtUs, left })) };
        },
        sweepSlots: (limit, parts = ALL_SWEEP_PARTS) => sweepSlots(limit, parts),
        deleteIdleRateKeys: limit => inQueue(executor => final.deleteIdleRateKeys(executor, p, limit)),
        deleteExpiredJobs: limit => inQueue(executor => final.deleteExpiredJobs(executor, p, limit)),
        makeDue: lanes => inQueue(executor => final.makeDue(executor, p, lanes)),
        getStats: () => final.getStats(adapter.queue, p),
        getJob: id => getJob(adapter.queue, family, p, id),
        listJobs: params => listJobs(adapter.queue, family, p, params),
        keyStats: params => keyStats(adapter.queue, family, p, params),
        registerSchedules: (entries, now) => schedules.registerSchedules(adapter.queue, p, entries, now),
        readSchedules: (ids, now) => schedules.readSchedules(adapter.queue, p, ids, now),
        fireSlots: params => inQueue(executor => schedules.fireSlots(executor, p, params)),
        ...createPauseStore(adapter, p),
        forgetPausedLanes: () => {
            pausedSeen = null;
        },
    };
}
