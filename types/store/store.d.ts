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
export type FoundCandidates = {
    startable: Candidate[];
    full: Candidate[];
};
export type FoundCandidatesOf = FoundCandidates & {
    ratedNames: string[];
};
export type ClaimedJob = {
    id: string;
    name: string;
    /**
     * Its global limits, sorted by key.
     */
    limits: import('../concurrency_keys.js').GlobalLimit[];
    /**
     * Its global rate limits, sorted by key.
     */
    rateLimits: import('../rate_keys.js').GlobalRateLimit[];
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
     * Due jobs with a full key: blocked, if a key is still full.
     */
    fullIds: string[];
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
     *     The jobs to take among the locked ones whose keys have room (in the order of run_at), given the held slots of
     *     their keys and the debts of their rate keys (µs, gcra.js): the free slots, fewer jobs on each key than its max,
     *     and the quota of each rate key, with the picked ones.
     */
    pick: (locked: ClaimedJob[], held: Map<string, number>, debts: Map<string, number>) => ClaimedJob[];
    /**
     * The candidates may have rate keys (their names are known to): PostgreSQL locks the
     * rows of the rate keys in the statement that locks the jobs. Without, a statement of its own, if they have some.
     */
    withRates?: boolean;
};
export type RateWait = import('../gcra.js').RateWait;
export type RateUnblockWait = RateWait & {
    debtUs: number | null;
    left: boolean;
};
export type ClaimResult = {
    /**
     * The claimed jobs, in the order of run_at.
     */
    jobs: ClaimedJob[];
    /**
     * The keys on which the claim blocked jobs, of both kinds.
     */
    blockedKeys: string[];
    /**
     * The names of the blocked jobs.
     */
    blockedNames: string[];
    /**
     * The rate keys on which the claim blocked the first jobs: when the oldest may start.
     */
    rateWaits: RateWait[];
};
export type DueRequest = {
    name: string;
    /**
     * At most this many of its jobs: the minimum of the rooms of its local limits and the
     * free slots.
     */
    maxJobs: number;
    /**
     * Its jobs that run in this instance.
     */
    running: number;
    /**
     * Its fairShareWeight.
     */
    weight: number;
    /**
     * Its local limits, as indexes in `limitRooms`.
     */
    limits: number[];
    /**
     * Its place in the order of the ties.
     */
    tie: number;
};
export type ClaimDueParams = {
    requests: DueRequest[];
    /**
     * The free slots of each local limit.
     */
    limitRooms: number[];
    /**
     * The free slots of the instance for this claim.
     */
    free: number;
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
     * MySQL and MariaDB: the jobs to take among the locked
     * ones (in the order of run_at), by share. PostgreSQL makes the same choice in SQL.
     */
    choose: (locked: StartableJob[]) => StartableJob[];
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
     * The next due time of the requested names with pending jobs that the claim did not
     * take: zero or less, more of their jobs are due. It may give other names too. Null: the claim filled the free
     * process slots and did not read them.
     */
    next: ProbeRow[] | null;
    /**
     * PostgreSQL: the requested names with a locked row that the claim did not take, under
     * any cap. The runner replays the choice with them, to move the tie pointer as the choice did.
     */
    unpicked?: string[];
    /**
     * The requested names with a locked row with global limits (from its enqueue options):
     * not taken, they need the claim of names with global limits.
     */
    limited: string[];
};
export type OwnedJob = {
    id: string;
    lockToken: string;
};
export type FinishedJob = OwnedJob & {
    limits?: readonly import('../concurrency_keys.js').GlobalLimit[];
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
    /**
     *     Of names with global limits: their oldest due jobs, at most 500 per name. `ratedNames`: the names that may have
     *     jobs with rate keys (`findCandidates` below); none: each search has the rate keys.
     */
    findCandidates: (limitsByName: Map<string, number>, ratedNames?: Set<string>) => Promise<FoundCandidates>;
    /**
     * In a queue transaction of its own.
     */
    claim: (params: ClaimParams) => Promise<ClaimResult>;
    /**
     * Finds, chooses by share, claims and reads
     * the due jobs of names without global limits, at once: one statement on PostgreSQL. It leaves the rows with
     * limits. A name requested more than once counts once, by its first request.
     */
    claimDue: (params: ClaimDueParams) => Promise<ClaimDueResult>;
    /**
     * Makes the jobs blocked on the concurrency keys pending
     * again, the oldest first, as many as each key has room for: their names. It leaves the rate keys.
     */
    unblock: (keys: string[]) => Promise<string[]>;
    /**
     * Makes the jobs blocked on the rate keys
     * pending again, the oldest first, as many as the quota of each key allows now (at most 500), after the debt of
     * `floors` at least (µs: the jobs that an earlier unblock made pending, not claimed yet). Their names; and, of each
     * key with blocked jobs, the time of its next unblock: when the oldest job left may start; with none left, a check
     * for a job blocked during the unblock (gcra.js, `nextUnblockMs`).
     */
    unblockRates: (keys: string[], floors?: Map<string, number>) => Promise<{
        names: string[];
        waits: RateUnblockWait[];
    }>;
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
    /**
     * The handler threw a
     * RateLimitedError on global rate keys of the job: their next start is `retryAfter` from now at the earliest, the
     * job is blocked on the first of them, without an attempt used; its slots are freed.
     */
    rateLimited: (job: OwnedJob, params: RateLimitedParams) => Promise<RateLimitedResult>;
    /**
     * One read, with no lock: the stale jobs, and
     * the parts of the sweep that have work.
     */
    findRecoveryWork: (limit: number) => Promise<RecoveryWork>;
    recoverStaleJob: (id: string, params: {
        leaseMs: number;
        buildFailureJob: FailureJobBuilder;
    }) => Promise<StaleJobResult>;
    /**
     * Deletes the ended lingers and
     * the orphan slots, then unblocks the jobs blocked on keys with room, and on rate keys whose next start is due:
     * the `parts` only (default: all). No part: no transaction. A deadlock, a serialization failure or a 1020 runs it
     * again at once, up to 3 times.
     */
    sweepSlots: (limit: number, parts?: SweepParts) => Promise<SweepResult>;
    /**
     * Deletes a batch of rows of rate keys whose tat
     * passed: the same as no row. SKIP LOCKED.
     */
    deleteIdleRateKeys: (limit: number) => Promise<number>;
    deleteExpiredJobs: (limit: number) => Promise<number>;
    /**
     * For drain({ includeDelayed }).
     */
    makeDue: (names: string[]) => Promise<void>;
    getStats: () => Promise<import('../types.js').JobStats[]>;
    /**
     * A plain read, no lock.
     */
    getJob: (id: string) => Promise<import('../types.js').JobRecord | null>;
    /**
     * A plain read, no lock.
     */
    listJobs: (params: import('./job_reads.js').ListParams) => Promise<{
        jobs: import('../types.js').JobRecord[];
        last: {
            enqueuedAtMs: number;
            id: string;
        } | null;
    }>;
    /**
     * Inserts the missing rows (2 statements per 500), then reads them.
     */
    registerSchedules: (schedules: {
        id: string;
        name: string;
        spec: string;
    }[], now: () => number) => Promise<ScheduleRead>;
    /**
     * A plain read, no
     * lock; null: every row.
     */
    readSchedules: (ids: string[] | null, now: () => number) => Promise<ScheduleRead>;
    /**
     * In a queue transaction of its own.
     */
    fireSlots: (params: import('./fire_slots.js').FireParams) => Promise<import('./fire_slots.js').FireResult>;
};
export type ScheduleRead = {
    clock: import('./fire_slots.js').ClockSample;
    rows: import('./fire_slots.js').ScheduleRow[];
};
export type RateLimitedParams = {
    /**
     * Rate keys of the job, sorted by key.
     */
    limits: import('../rate_keys.js').GlobalRateLimit[];
    retryAfterMs: number;
    error: import('../error_json.js').ErrorJson;
};
export type RateLimitedResult = {
    /**
     * False: the lease was lost; nothing changed.
     */
    changed: boolean;
    /**
     * The time until the job may start on the key that it is blocked on.
     */
    delayMs: number;
};
export type SweepParts = {
    /**
     * Ended lingers.
     */
    lingers: boolean;
    /**
     * Slots without their running job.
     */
    orphans: boolean;
    /**
     * Jobs blocked on a key: concurrency or rate.
     */
    blocked: boolean;
};
export type RecoveryWork = SweepParts & {
    stale: {
        id: string;
        name: string;
    }[];
    idleRateKeys: boolean;
};
export type SweepResult = {
    lingers: number;
    orphans: number;
    /**
     * The names of the jobs that it unblocked.
     */
    unblocked: number;
    /**
     * The rate keys whose due jobs it unblocked, and that have blocked jobs left: their
     * timer was lost (a process stopped), so the sweeping process takes it over.
     */
    rateWaits: RateWait[];
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
 * @property {(limit: number) => Promise<RecoveryWork>} findRecoveryWork One read, with no lock: the stale jobs, and
 *     the parts of the sweep that have work.
 * @property {(id: string, params: { leaseMs: number, buildFailureJob: FailureJobBuilder })
 *     => Promise<StaleJobResult>} recoverStaleJob
 * @property {(limit: number, parts?: SweepParts) => Promise<SweepResult>} sweepSlots Deletes the ended lingers and
 *     the orphan slots, then unblocks the jobs blocked on keys with room, and on rate keys whose next start is due:
 *     the `parts` only (default: all). No part: no transaction. A deadlock, a serialization failure or a 1020 runs it
 *     again at once, up to 3 times.
 * @property {(limit: number) => Promise<number>} deleteIdleRateKeys Deletes a batch of rows of rate keys whose tat
 *     passed: the same as no row. SKIP LOCKED.
 * @property {(limit: number) => Promise<number>} deleteExpiredJobs
 * @property {(names: string[]) => Promise<void>} makeDue For drain({ includeDelayed }).
 * @property {() => Promise<import('../types.js').JobStats[]>} getStats
 * @property {(id: string) => Promise<import('../types.js').JobRecord | null>} getJob A plain read, no lock.
 * @property {(params: import('./job_reads.js').ListParams) => Promise<{ jobs: import('../types.js').JobRecord[],
 *     last: { enqueuedAtMs: number, id: string } | null }>} listJobs A plain read, no lock.
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
 * The parts of the sweep of the slots to run.
 * @typedef {object} SweepParts
 * @property {boolean} lingers Ended lingers.
 * @property {boolean} orphans Slots without their running job.
 * @property {boolean} blocked Jobs blocked on a key: concurrency or rate.
 */
/**
 * The work of a stall recovery, as one read found it.
 * @typedef {SweepParts & { stale: { id: string, name: string }[], idleRateKeys: boolean }} RecoveryWork stale: the
 *     running jobs whose lease ended, the oldest first. idleRateKeys: rows of rate keys whose tat passed.
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
export declare function createStore(adapter: import('../types.js').Adapter<any>, tablePrefix: string, logger?: import('../types.js').Logger): Store;
