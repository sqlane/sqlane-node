export type ProbeRow = {
    /**
     * A job name with pending jobs.
     */
    name: string;
    /**
     * Until its oldest pending job is due: 0 or less means due now.
     */
    delayMs: number;
};
export type Candidate = {
    id: string;
    name: string;
    runAtMs: number;
};
export type ClaimedJob = {
    id: string;
    name: string;
    mutexKeys: string[];
    /**
     * The failed attempts so far.
     */
    attempts: number;
    maxAttempts: number;
    stalls: number;
    maxStalls: number;
    failureJob: string | null;
    enqueuedAt: Date;
    /**
     * Since it was due.
     */
    waitedMs: number;
    lockToken: string;
};
export type ClaimParams = {
    candidateIds: string[];
    /**
     * Of this claim.
     */
    lockToken: string;
    /**
     * The process.
     */
    lockedBy: string;
    leaseMs: number;
    /**
     * The jobs to take among the locked
     * ones (in the order of run_at): the free slots, the free keys. The keys of the picked jobs must be distinct.
     */
    pick: (locked: ClaimedJob[], busyKeys: Set<string>) => ClaimedJob[];
};
export type DueRequest = {
    name: string;
    /**
     * At most this many of its jobs: the free slots of its lane.
     */
    maxJobs: number;
    /**
     * The index of its lane in `laneFree`.
     */
    lane: number;
};
export type ClaimDueParams = {
    requests: DueRequest[];
    /**
     * The free slots of each lane.
     */
    laneFree: number[];
    /**
     * The free slots of the process.
     */
    processMax: number;
    /**
     * Of this claim.
     */
    lockToken: string;
    /**
     * The process.
     */
    lockedBy: string;
    leaseMs: number;
};
export type StartableJob = ClaimedJob & {
    payload: {
        found: boolean;
        payload: unknown;
    };
};
export type ClaimDueResult = {
    /**
     * The claimed jobs, in the order of run_at.
     */
    jobs: StartableJob[];
    /**
     * The next due time of the requested names with pending jobs that the claim did not take:
     * zero or less, more of their jobs are due. It may give other names too.
     */
    next: ProbeRow[];
};
export type OwnedJob = {
    id: string;
    lockToken: string;
};
export type FinishedJob = OwnedJob & {
    mutexKeys: readonly string[];
};
export type FailedJob = {
    id: string;
    name: string;
    /**
     * Null: its payload is missing.
     */
    payload: unknown;
    attempt: number;
    maxAttempts: number;
    /**
     * The name of its failure job.
     */
    failureJob: string;
    error: import('../error_json.js').ErrorJson;
};
export type FailureJobBuilder = (failed: FailedJob) => import('../new_job.js').NewJob;
export type FailureJobResult = {
    added: import('../new_job.js').NewJob;
} | {
    notAdded: unknown;
};
export type StaleJobResult = {
    result: null;
    failureJob: null;
} | {
    result: 'released' | 'failed';
    failureJob: FailureJobResult | null;
    attempt: number;
    runMs: number;
};
export type Store = {
    /**
     * The next due time of each given name with
     * pending jobs; null: of each name. It may give other names too.
     */
    probe: (names: string[] | null) => Promise<ProbeRow[]>;
    findCandidates: (limitsByName: Map<string, number>, namesWithKeys: string[]) => Promise<Candidate[]>;
    /**
     * The names whose jobs may
     * start after a release of the keys: of the oldest due job of each key, among the names with mutex keys.
     */
    namesWaitingFor: (keys: string[], namesWithKeys: string[]) => Promise<string[]>;
    /**
     * In a queue transaction of its own.
     */
    claim: (params: ClaimParams) => Promise<ClaimedJob[]>;
    /**
     * Finds, claims and reads the due jobs of
     * names without mutex keys, at once: one statement on PostgreSQL. The keys of their rows are not taken: the
     * definition of this process decides.
     */
    claimDue: (params: ClaimDueParams) => Promise<ClaimDueResult>;
    readPayloads: (ids: string[]) => Promise<Map<string, unknown>>;
    renewLeases: (jobs: OwnedJob[], leaseMs: number) => Promise<Set<string>>;
    markTimedOut: (job: OwnedJob) => Promise<boolean>;
    /**
     * In one transaction (one statement on PostgreSQL):
     * the jobs that it completed.
     */
    completeJobs: (jobs: FinishedJob[]) => Promise<number>;
    retryJob: (job: OwnedJob, params: {
        delayMs: number;
        error: import('../error_json.js').ErrorJson;
    }) => Promise<boolean>;
    failJob: (job: OwnedJob, params: {
        error: import('../error_json.js').ErrorJson;
        buildFailureJob: FailureJobBuilder;
    }) => Promise<{
        changed: boolean;
        failureJob: FailureJobResult | null;
    }>;
    releaseJob: (job: OwnedJob, params: {
        delayMs: number;
        lingerMs: number;
    }) => Promise<boolean>;
    findStaleJobs: (limit: number) => Promise<{
        id: string;
        name: string;
    }[]>;
    recoverStaleJob: (id: string, params: {
        leaseMs: number;
        buildFailureJob: FailureJobBuilder;
    }) => Promise<StaleJobResult>;
    sweepMutexes: (limit: number) => Promise<{
        lingers: number;
        orphans: number;
    }>;
    deleteExpiredJobs: (limit: number) => Promise<number>;
    /**
     * For drain({ includeDelayed }).
     */
    makeDue: (names: string[]) => Promise<void>;
    getStats: () => Promise<import('../types.js').JobStats[]>;
};
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
 * @typedef {object} ClaimDueResult
 * @property {StartableJob[]} jobs The claimed jobs, in the order of run_at.
 * @property {ProbeRow[]} next The next due time of the requested names with pending jobs that the claim did not take:
 *     zero or less, more of their jobs are due. It may give other names too.
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
 * @property {(limitsByName: Map<string, number>, namesWithKeys: string[]) => Promise<Candidate[]>} findCandidates
 * @property {(keys: string[], namesWithKeys: string[]) => Promise<string[]>} namesWaitingFor The names whose jobs may
 *     start after a release of the keys: of the oldest due job of each key, among the names with mutex keys.
 * @property {(params: ClaimParams) => Promise<ClaimedJob[]>} claim In a queue transaction of its own.
 * @property {(params: ClaimDueParams) => Promise<ClaimDueResult>} claimDue Finds, claims and reads the due jobs of
 *     names without mutex keys, at once: one statement on PostgreSQL. The keys of their rows are not taken: the
 *     definition of this process decides.
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
export declare function createStore(adapter: import('../types.js').Adapter<any>, tablePrefix: string): Store;
