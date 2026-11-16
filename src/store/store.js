// The store: the SQL of one dialect, bound to an adapter and a table prefix.
import { setTimeout as sleep } from 'node:timers/promises';
import * as mariadbFinal from './mariadb_final.js';
import * as mariadbSchedules from './mariadb_schedules.js';
import * as mariadbWorker from './mariadb_worker.js';
import * as mysqlFinal from './mysql_final.js';
import * as mysqlSchedules from './mysql_schedules.js';
import * as mysqlWorker from './mysql_worker.js';
import * as postgresFinal from './postgres_final.js';
import * as postgresSchedules from './postgres_schedules.js';
import * as postgresWorker from './postgres_worker.js';
import { isRateKey } from '../rate_keys.js';
import { isQuickRetryError, isUnknownSystemVariableError } from '../transient_error.js';

/**
 * A sweep of the slots that fails with a deadlock-like error runs again at once this many times, after 5 to 30 ms, as a
 * turn of the dispatcher; then it rejects
 */
const MAX_SWEEP_RETRIES = 3;
const SWEEP_RETRY_MIN_MS = 5;
const SWEEP_RETRY_JITTER_MS = 25;

/**
 * @typedef {object} ProbeRow
 * @property {string} name A job name with pending jobs.
 * @property {number} delayMs Until its oldest pending job is due: 0 or less means due now.
 */

/**
 * @typedef {object} Candidate
 * @property {string} id
 * @property {string} name
 * @property {number} runAtMs
 */

/**
 * The due jobs of names with global limits: those whose keys have room, at most the asked number per name, and those
 * with a full key, which a claim blocks. A rate key is full for the jobs that its quota does not allow, after the older
 * jobs of the search, and for the jobs behind an older job blocked on it.
 * @typedef {{ startable: Candidate[], full: Candidate[] }} FoundCandidates
 */

/**
 * The candidates of a search, with the names of the returned jobs that have rate keys when it left them out.
 * @typedef {FoundCandidates & { ratedNames: string[] }} FoundCandidatesOf
 */

/**
 * A job that a claim locked, and then claimed: it runs.
 * @typedef {object} ClaimedJob
 * @property {string} id
 * @property {string} name
 * @property {import('../concurrency_keys.js').GlobalLimit[]} limits Its global limits, sorted by key.
 * @property {import('../rate_keys.js').GlobalRateLimit[]} rateLimits Its global rate limits, sorted by key.
 * @property {number} attempts The failed attempts so far.
 * @property {number} maxAttempts
 * @property {number} stalls
 * @property {number} maxStalls
 * @property {string | null} failureJob
 * @property {Date} enqueuedAt
 * @property {number} waitedMs Since it was due.
 * @property {string} lockToken
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
 * @property {boolean} [withRates] The candidates may have rate keys (their names are known to): PostgreSQL locks the
 *     rows of the rate keys in the statement that locks the jobs. Without, a statement of its own, if they have some.
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
 * @property {string[]} blockedNames The names of the blocked jobs.
 * @property {RateWait[]} rateWaits The rate keys on which the claim blocked the first jobs: when the oldest may start.
 */

/**
 * One request of a claim of due jobs: a job name without global limits, and what its share needs.
 * @typedef {object} DueRequest
 * @property {string} name
 * @property {number} maxJobs At most this many of its jobs: the minimum of the rooms of its local limits and the
 *     free slots.
 * @property {number} running Its jobs that run in this instance.
 * @property {number} weight Its fairShareWeight.
 * @property {number[]} limits Its local limits, as indexes in `limitRooms`.
 * @property {number} tie Its place in the order of the ties.
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
 */

/**
 * A claimed job with its payload.
 * @typedef {ClaimedJob & { payload: { found: boolean, payload: unknown } }} StartableJob
 */

/**
 * @typedef {object} ClaimDueResult
 * @property {StartableJob[]} jobs The claimed jobs, in the order of run_at.
 * @property {ProbeRow[] | null} next The next due time of the requested names with pending jobs that the claim did not
 *     take: zero or less, more of their jobs are due. It may give other names too. Null: the claim filled the free
 *     process slots and did not read them.
 * @property {string[]} [unpicked] PostgreSQL: the requested names with a locked row that the claim did not take, under
 *     any cap. The runner replays the choice with them, to move the tie pointer as the choice did.
 * @property {string[]} limited The requested names with a locked row with global limits (from its enqueue options):
 *     not taken, they need the claim of names with global limits.
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
 * @property {string} name
 * @property {unknown} payload Null: its payload is missing.
 * @property {number} attempt
 * @property {number} maxAttempts
 * @property {string} failureJob The name of its failure job.
 * @property {import('../error_json.js').ErrorJson} error
 */

/**
 * Builds the failure job: its options from its definition, else the defaults; no failure job of its own.
 * @typedef {(failed: FailedJob) => import('../new_job.js').NewJob} FailureJobBuilder
 */

/** @typedef {{ added: import('../new_job.js').NewJob } | { notAdded: unknown }} FailureJobResult */

/**
 * The result of the recovery of a stale job. `attempt` and `runMs` describe the run that stalled: its attempt (1 for
 * the first run), and the time since it started.
 * @typedef {{ result: null, failureJob: null }
 *     | { result: 'released' | 'failed', failureJob: FailureJobResult | null, attempt: number, runMs: number }}
 *     StaleJobResult
 */

/**
 * @typedef {object} Store
 * @property {(names: string[] | null) => Promise<ProbeRow[]>} probe The next due time of each given name with
 *     pending jobs; null: of each name. It may give other names too.
 * @property {(limitsByName: Map<string, number>, ratedNames?: Set<string>) => Promise<FoundCandidates>} findCandidates
 *     Of names with global limits: their oldest due jobs, at most 500 per name. `ratedNames`: the names that may have
 *     jobs with rate keys (`findCandidates` below); none: each search has the rate keys.
 * @property {(params: ClaimParams) => Promise<ClaimResult>} claim In a queue transaction of its own.
 * @property {(params: ClaimDueParams) => Promise<ClaimDueResult>} claimDue Finds, chooses by share, claims and reads
 *     the due jobs of names without global limits, at once: one statement on PostgreSQL. It leaves the rows with
 *     limits. A name requested more than once counts once, by its first request.
 * @property {(keys: string[]) => Promise<string[]>} unblock Makes the jobs blocked on the concurrency keys pending
 *     again, the oldest first, as many as each key has room for: their names. It leaves the rate keys.
 * @property {(keys: string[], floors?: Map<string, number>)
 *     => Promise<{ names: string[], waits: RateUnblockWait[] }>} unblockRates Makes the jobs blocked on the rate keys
 *     pending again, the oldest first, as many as the quota of each key allows now (at most 500), after the debt of
 *     `floors` at least (µs: the jobs that an earlier unblock made pending, not claimed yet). Their names; and, of each
 *     key with blocked jobs, the time of its next unblock: when the oldest job left may start; with none left, a check
 *     for a job blocked during the unblock (gcra.js, `nextUnblockMs`).
 * @property {(ids: string[]) => Promise<Map<string, unknown>>} readPayloads
 * @property {(jobs: OwnedJob[], leaseMs: number) => Promise<Set<string>>} renewLeases
 * @property {(job: OwnedJob) => Promise<boolean>} markTimedOut
 * @property {(jobs: FinishedJob[]) => Promise<number>} completeJobs In one transaction (one statement on PostgreSQL):
 *     the jobs that it completed.
 * @property {(job: OwnedJob, params: { delayMs: number, error: import('../error_json.js').ErrorJson })
 *     => Promise<boolean>} retryJob
 * @property {(
 *     job: OwnedJob,
 *     params: { error: import('../error_json.js').ErrorJson, buildFailureJob: FailureJobBuilder },
 * ) => Promise<{ changed: boolean, failureJob: FailureJobResult | null }>} failJob
 * @property {(job: OwnedJob, params: { delayMs: number, lingerMs: number }) => Promise<boolean>} releaseJob
 * @property {(job: OwnedJob, params: RateLimitedParams) => Promise<RateLimitedResult>} rateLimited The handler threw a
 *     RateLimitedError on global rate keys of the job: their next start is `retryAfter` from now at the earliest, the
 *     job is blocked on the first of them, without an attempt used; its slots are freed.
 * @property {(limit: number) => Promise<{ id: string, name: string }[]>} findStaleJobs
 * @property {(id: string, params: { leaseMs: number, buildFailureJob: FailureJobBuilder })
 *     => Promise<StaleJobResult>} recoverStaleJob
 * @property {(limit: number) => Promise<SweepResult>} sweepSlots Deletes the ended lingers and the orphan slots, then
 *     unblocks the jobs blocked on keys with room, and on rate keys whose next start is due. A deadlock, a
 *     serialization failure or a 1020 runs it again at once, up to 3 times.
 * @property {(limit: number) => Promise<number>} deleteIdleRateKeys Deletes a batch of rows of rate keys whose tat
 *     passed: the same as no row. SKIP LOCKED.
 * @property {(limit: number) => Promise<number>} deleteExpiredJobs
 * @property {(names: string[]) => Promise<void>} makeDue For drain({ includeDelayed }).
 * @property {() => Promise<import('../types.js').JobStats[]>} getStats
 * @property {(schedules: { id: string, name: string, spec: string }[], now: () => number)
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
 * @typedef {object} SweepResult
 * @property {number} lingers
 * @property {number} orphans
 * @property {number} unblocked The names of the jobs that it unblocked.
 * @property {RateWait[]} rateWaits The rate keys whose due jobs it unblocked, and that have blocked jobs left: their
 *     timer was lost (a process stopped), so the sweeping process takes it over.
 */

/**
 * @param {import('../types.js').Adapter<any>} adapter
 * @param {string} tablePrefix Checked.
 * @param {import('../types.js').Logger} [logger]
 * @returns {Store}
 */
export function createStore(adapter, tablePrefix, logger) {
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
    const p = tablePrefix;
    // MariaDB: false once the server rejects `innodb_snapshot_isolation` (a version without it)
    let snapshotIsolationOff = true;

    /**
     * The search of candidates has the rate keys only for a name in `ratedNames`: by its definition, or seen here. The
     * part of the rate keys costs every search: PostgreSQL plans the statement at each call (a custom plan), and the
     * rate CTEs double that planning; MySQL and MariaDB run them on every search. The other search also returns the
     * jobs of its window that have rate keys (from their enqueue options): their names join `ratedNames`, and the
     * search runs again with them. Without such a job its result is the same: a job without rate keys is never full by
     * rate.
     * @param {typeof postgresWorker | typeof mysqlWorker | typeof mariadbWorker} worker
     * @param {Map<string, number>} limitsByName
     * @param {Set<string>} [ratedNames] Grows with the names seen with rate keys. None: each search has the rate keys.
     * @returns {Promise<FoundCandidates>}
     */
    async function findCandidates(worker, limitsByName, ratedNames) {
        const withRates = !ratedNames || [...limitsByName.keys()].some(name => ratedNames.has(name));
        const found = await worker.findCandidates(adapter.queue, p, limitsByName, withRates);

        if (withRates || !found.ratedNames.length) {
            return { startable: found.startable, full: found.full };
        }

        for (const name of found.ratedNames) {
            ratedNames?.add(name);
        }

        const again = await worker.findCandidates(adapter.queue, p, limitsByName, true);

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
     * @returns {Promise<SweepResult>}
     */
    async function sweepSlots(limit) {
        for (let retry = 1; ; retry++) {
            try {
                // oxlint-disable-next-line no-await-in-loop -- one try after the other
                return await inQueue(executor => final.sweepSlots(executor, p, limit));
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
        probe: names => sql.probe(adapter.queue, tablePrefix, names),
        findCandidates: (limitsByName, ratedNames) => findCandidates(sql, limitsByName, ratedNames),
        claim: params => adapter.queueTransaction(executor => sql.claim(executor, tablePrefix, params)),
        claimDue: (params) => {
            // Each name once: MySQL and MariaDB lock the rows of each request, so a name requested twice would claim
            // its jobs twice. The first request of a name counts
            const names = new Set();
            const requests = params.requests.filter((request) => {
                const first = !names.has(request.name);

                names.add(request.name);

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
        findStaleJobs: limit => final.findStaleJobs(adapter.queue, p, limit),
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
                : final.unblock(adapter.queue, p, slotKeys, inQueue);
        },
        unblockRates: async (keys, floors) => {
            if (!keys.length) {
                return { names: [], waits: [] };
            }

            // One statement on PostgreSQL; on MySQL and MariaDB, a read, then a transaction only when a job may start
            const { names, waits } = adapter.dialect === 'postgres'
                ? await postgresFinal.unblockRates(adapter.queue, p, keys, { floors })
                : await final.unblockRates(adapter.queue, p, keys, { inTransaction: inQueue, floors });

            return { names, waits: waits.map(({ key, delayMs, debtUs, left }) => ({ key, delayMs, debtUs, left })) };
        },
        sweepSlots,
        deleteIdleRateKeys: limit => inQueue(executor => final.deleteIdleRateKeys(executor, p, limit)),
        deleteExpiredJobs: limit => inQueue(executor => final.deleteExpiredJobs(executor, p, limit)),
        makeDue: names => inQueue(executor => final.makeDue(executor, p, names)),
        getStats: () => final.getStats(adapter.queue, p),
        registerSchedules: (entries, now) => schedules.registerSchedules(adapter.queue, p, entries, now),
        readSchedules: (ids, now) => schedules.readSchedules(adapter.queue, p, ids, now),
        fireSlots: params => inQueue(executor => schedules.fireSlots(executor, p, params)),
    };
}
