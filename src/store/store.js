// The store: the SQL of one dialect, bound to an adapter and a table prefix.
import * as mariadbFinal from './mariadb_final.js';
import * as mariadbSchedules from './mariadb_schedules.js';
import * as mariadbWorker from './mariadb_worker.js';
import * as mysqlFinal from './mysql_final.js';
import * as mysqlSchedules from './mysql_schedules.js';
import * as mysqlWorker from './mysql_worker.js';
import * as postgresFinal from './postgres_final.js';
import * as postgresSchedules from './postgres_schedules.js';
import * as postgresWorker from './postgres_worker.js';
import { isUnknownSystemVariableError } from '../transient_error.js';

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
 * with a full key, which a claim blocks.
 * @typedef {{ startable: Candidate[], full: Candidate[] }} FoundCandidates
 */

/**
 * A job that a claim locked, and then claimed: it runs.
 * @typedef {object} ClaimedJob
 * @property {string} id
 * @property {string} name
 * @property {import('../concurrency_keys.js').GlobalLimit[]} limits Its global limits, sorted by key.
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
 * @property {(locked: ClaimedJob[], held: Map<string, number>) => ClaimedJob[]} pick The jobs to take among the
 *     locked ones whose keys have room (in the order of run_at), given the held slots of their keys: the free slots,
 *     and fewer jobs on each key than its max, with the picked ones.
 */

/**
 * @typedef {object} ClaimResult
 * @property {ClaimedJob[]} jobs The claimed jobs, in the order of run_at.
 * @property {string[]} blockedKeys The keys on which the claim blocked jobs.
 * @property {string[]} blockedNames The names of the blocked jobs.
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
 * @property {(limitsByName: Map<string, number>) => Promise<FoundCandidates>} findCandidates Of names with global
 *     limits: their oldest due jobs, at most 500 per name.
 * @property {(params: ClaimParams) => Promise<ClaimResult>} claim In a queue transaction of its own.
 * @property {(params: ClaimDueParams) => Promise<ClaimDueResult>} claimDue Finds, chooses by share, claims and reads
 *     the due jobs of names without global limits, at once: one statement on PostgreSQL. It leaves the rows with
 *     limits.
 * @property {(keys: string[]) => Promise<string[]>} unblock Makes the jobs blocked on the keys pending again, the
 *     oldest first, as many as each key has room for: their names.
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
 * @property {(limit: number) => Promise<{ id: string, name: string }[]>} findStaleJobs
 * @property {(id: string, params: { leaseMs: number, buildFailureJob: FailureJobBuilder })
 *     => Promise<StaleJobResult>} recoverStaleJob
 * @property {(limit: number) => Promise<{ lingers: number, orphans: number, unblocked: number }>} sweepSlots Deletes
 *     the ended lingers and the orphan slots, then unblocks the jobs blocked on keys with room.
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

    /** @type {(params: ClaimDueParams) => Promise<ClaimDueResult>} */
    const claimDueInQueue = adapter.dialect === 'mariadb'
        ? claimDueMariadb
        : params => inQueue(executor => sql.claimDue(executor, p, params));

    return {
        probe: names => sql.probe(adapter.queue, tablePrefix, names),
        findCandidates: limitsByName => sql.findCandidates(adapter.queue, tablePrefix, limitsByName),
        claim: params => adapter.queueTransaction(executor => sql.claim(executor, tablePrefix, params)),
        claimDue: params => (adapter.dialect === 'postgres'
            // One statement: a transaction of its own
            ? postgresWorker.claimDue(adapter.queue, p, params)
            : claimDueInQueue(params)),
        readPayloads: ids => sql.readPayloads(adapter.queue, tablePrefix, ids),
        renewLeases: (jobs, leaseMs) => inQueue(executor => final.renewLeases(executor, p, jobs, leaseMs)),
        markTimedOut: job => final.markTimedOut(adapter.queue, p, job),
        completeJobs: jobs => (adapter.dialect === 'postgres'
            ? postgresFinal.completeJobs(adapter.queue, p, jobs)
            : inQueue(executor => final.completeJobs(executor, p, jobs))),
        retryJob: (job, params) => inQueue(executor => final.retryJob(executor, p, job, params)),
        failJob: (job, params) => inQueue(executor => final.failJob(executor, p, job, params)),
        releaseJob: (job, params) => inQueue(executor => final.releaseJob(executor, p, job, params)),
        findStaleJobs: limit => final.findStaleJobs(adapter.queue, p, limit),
        recoverStaleJob: (id, params) => inQueue(executor => final.recoverStaleJob(executor, p, id, params)),
        unblock: (keys) => {
            if (!keys.length) {
                return Promise.resolve([]);
            }

            // One statement on PostgreSQL; on MySQL and MariaDB, a read, then a transaction only when a key has room
            return adapter.dialect === 'postgres'
                ? postgresFinal.unblock(adapter.queue, p, keys)
                : final.unblock(adapter.queue, p, keys, inQueue);
        },
        sweepSlots: limit => inQueue(executor => final.sweepSlots(executor, p, limit)),
        deleteExpiredJobs: limit => inQueue(executor => final.deleteExpiredJobs(executor, p, limit)),
        makeDue: names => inQueue(executor => final.makeDue(executor, p, names)),
        getStats: () => final.getStats(adapter.queue, p),
        registerSchedules: (entries, now) => schedules.registerSchedules(adapter.queue, p, entries, now),
        readSchedules: (ids, now) => schedules.readSchedules(adapter.queue, p, ids, now),
        fireSlots: params => inQueue(executor => schedules.fireSlots(executor, p, params)),
    };
}
