// The store: the SQL of one dialect, bound to an adapter and a table prefix.
import * as mysqlFinal from './mysql_final.js';
import * as mysqlWorker from './mysql_worker.js';
import * as postgresFinal from './postgres_final.js';
import * as postgresWorker from './postgres_worker.js';

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
 * A job that a claim locked, and then claimed: it runs.
 * @typedef {object} ClaimedJob
 * @property {string} id
 * @property {string} name
 * @property {string[]} mutexKeys
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
 * @property {string} lockToken Of this claim.
 * @property {string} lockedBy The process.
 * @property {number} leaseMs
 * @property {(locked: ClaimedJob[], busyKeys: Set<string>) => ClaimedJob[]} pick The jobs to take among the locked
 *     ones (in the order of run_at): the free slots, the free keys. The keys of the picked jobs must be distinct.
 */

/**
 * One request of a claim of due jobs: a job name without mutex keys, and the lane of its handler.
 * @typedef {object} DueRequest
 * @property {string} name
 * @property {number} maxJobs At most this many of its jobs: the free slots of its lane.
 * @property {number} lane The index of its lane in `laneFree`.
 */

/**
 * @typedef {object} ClaimDueParams
 * @property {DueRequest[]} requests
 * @property {number[]} laneFree The free slots of each lane.
 * @property {number} processMax The free slots of the process.
 * @property {string} lockToken Of this claim.
 * @property {string} lockedBy The process.
 * @property {number} leaseMs
 */

/**
 * A claimed job with its payload.
 * @typedef {ClaimedJob & { payload: { found: boolean, payload: unknown } }} StartableJob
 */

/**
 * A job that this process claimed: every write of it checks the lock token.
 * @typedef {object} OwnedJob
 * @property {string} id
 * @property {string} lockToken
 */

/**
 * A job that this process ran, with its keys.
 * @typedef {OwnedJob & { mutexKeys: readonly string[] }} FinishedJob
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
 * @typedef {object} Store
 * @property {() => Promise<ProbeRow[]>} probe
 * @property {(limitsByName: Map<string, number>, keyedNames: string[]) => Promise<Candidate[]>} findCandidates
 * @property {(params: ClaimParams) => Promise<ClaimedJob[]>} claim In a queue transaction of its own.
 * @property {(params: ClaimDueParams) => Promise<StartableJob[]>} claimDue Finds, claims and reads the due jobs of
 *     names without mutex keys, at once: one statement on PostgreSQL. The keys of their rows are not taken: the
 *     definition of this process decides.
 * @property {(ids: string[]) => Promise<Map<string, unknown>>} readPayloads
 * @property {(jobs: OwnedJob[], leaseMs: number) => Promise<Set<string>>} renewLeases
 * @property {(job: OwnedJob) => Promise<boolean>} markTimedOut
 * @property {(jobs: FinishedJob[]) => Promise<number>} completeJobs In one transaction: the jobs that it completed.
 * @property {(job: OwnedJob, params: { delayMs: number, error: import('../error_json.js').ErrorJson })
 *     => Promise<boolean>} retryJob
 * @property {(
 *     job: OwnedJob,
 *     params: { error: import('../error_json.js').ErrorJson, buildFailureJob: FailureJobBuilder },
 * ) => Promise<{ changed: boolean, failureJob: FailureJobResult | null }>} failJob
 * @property {(job: OwnedJob, params: { delayMs: number, lingerMs: number }) => Promise<boolean>} releaseJob
 * @property {(limit: number) => Promise<{ id: string, name: string }[]>} findStaleJobs
 * @property {(id: string, params: { leaseMs: number, buildFailureJob: FailureJobBuilder })
 *     => Promise<{ result: 'released' | 'failed' | null, failureJob: FailureJobResult | null }>} recoverStaleJob
 * @property {(limit: number) => Promise<{ lingers: number, orphans: number }>} sweepMutexes
 * @property {(limit: number) => Promise<number>} deleteExpiredJobs
 * @property {(names: string[]) => Promise<void>} makeDue For drain({ includeDelayed }).
 * @property {() => Promise<import('../types.js').JobStats[]>} getStats
 */

/**
 * @param {import('../types.js').Adapter<any>} adapter
 * @param {string} tablePrefix Checked.
 * @returns {Store}
 */
export function createStore(adapter, tablePrefix) {
    const sql = adapter.dialect === 'mysql' ? mysqlWorker : postgresWorker;
    const final = adapter.dialect === 'mysql' ? mysqlFinal : postgresFinal;
    /**
     * @template T
     * @param {(executor: import('../types.js').Executor) => Promise<T>} func
     * @returns {Promise<T>}
     */
    const inQueue = func => adapter.queueTransaction(func);
    const p = tablePrefix;

    return {
        probe: () => sql.probe(adapter.queue, tablePrefix),
        findCandidates: (limitsByName, keyedNames) => sql.findCandidates(
            adapter.queue,
            tablePrefix,
            limitsByName,
            keyedNames,
        ),
        claim: params => adapter.queueTransaction(executor => sql.claim(executor, tablePrefix, params)),
        claimDue: params => (adapter.dialect === 'mysql'
            ? inQueue(executor => mysqlWorker.claimDue(executor, p, params))
            // One statement: a transaction of its own
            : postgresWorker.claimDue(adapter.queue, p, params)),
        readPayloads: ids => sql.readPayloads(adapter.queue, tablePrefix, ids),
        renewLeases: (jobs, leaseMs) => inQueue(executor => final.renewLeases(executor, p, jobs, leaseMs)),
        markTimedOut: job => final.markTimedOut(adapter.queue, p, job),
        completeJobs: jobs => inQueue(executor => final.completeJobs(executor, p, jobs)),
        retryJob: (job, params) => inQueue(executor => final.retryJob(executor, p, job, params)),
        failJob: (job, params) => inQueue(executor => final.failJob(executor, p, job, params)),
        releaseJob: (job, params) => inQueue(executor => final.releaseJob(executor, p, job, params)),
        findStaleJobs: limit => final.findStaleJobs(adapter.queue, p, limit),
        recoverStaleJob: (id, params) => inQueue(executor => final.recoverStaleJob(executor, p, id, params)),
        sweepMutexes: limit => inQueue(executor => final.sweepMutexes(executor, p, limit)),
        deleteExpiredJobs: limit => inQueue(executor => final.deleteExpiredJobs(executor, p, limit)),
        makeDue: names => inQueue(executor => final.makeDue(executor, p, names)),
        getStats: () => final.getStats(adapter.queue, p),
    };
}
