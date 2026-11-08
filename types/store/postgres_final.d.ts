export type Executor = import('../types.js').Executor;
export type OwnedJob = import('./store.js').OwnedJob;
export type FailureJobBuilder = import('./store.js').FailureJobBuilder;
export type FailureJobResult = import('./store.js').FailureJobResult;
/**
 * Renews the leases of the jobs that the process runs. A row locked by another transaction is skipped: it does not
 * block the others.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob[]} jobs
 * @param {number} leaseMs
 * @returns {Promise<Set<string>>} The ids whose lease was renewed.
 */
export declare function renewLeases(executor: Executor, p: string, jobs: OwnedJob[], leaseMs: number): Promise<Set<string>>;
/**
 * Marks a timeout: the job stays running until its handler settles (`stuck` in the stats).
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @returns {Promise<boolean>} False: the lease was lost.
 */
export declare function markTimedOut(executor: Executor, p: string, job: OwnedJob): Promise<boolean>;
/**
 * The job is done: completed until its retention ends, without its payload; its keys are freed.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @returns {Promise<boolean>} False: no change (the lease was lost, or an earlier try committed).
 */
export declare function completeJob(executor: Executor, p: string, job: OwnedJob): Promise<boolean>;
/**
 * The attempt failed: pending again after the delay, one more attempt used; its keys are freed.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @param {{ delayMs: number, error: import('../error_json.js').ErrorJson }} params
 * @returns {Promise<boolean>} False: no change.
 */
export declare function retryJob(executor: Executor, p: string, job: OwnedJob, { delayMs, error }: {
    delayMs: number;
    error: import('../error_json.js').ErrorJson;
}): Promise<boolean>;
/**
 * The job fails for good: failed until its retention ends, with its payload; its keys are freed; its failure job is
 * added in the same transaction.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @param {{ error: import('../error_json.js').ErrorJson, buildFailureJob: FailureJobBuilder }} params
 * @returns {Promise<{ changed: boolean, failureJob: FailureJobResult | null }>}
 */
export declare function failJob(executor: Executor, p: string, job: OwnedJob, { error, buildFailureJob }: {
    error: import('../error_json.js').ErrorJson;
    buildFailureJob: FailureJobBuilder;
}): Promise<{
    changed: boolean;
    failureJob: FailureJobResult | null;
}>;
/**
 * The job is released, without an attempt used: pending again after the delay.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @param {{ delayMs: number, lingerMs: number }} params lingerMs: its keys stay held this long (its handler still
 *     runs); 0: they are freed.
 * @returns {Promise<boolean>} False: no change.
 */
export declare function releaseJob(executor: Executor, p: string, job: OwnedJob, { delayMs, lingerMs }: {
    delayMs: number;
    lingerMs: number;
}): Promise<boolean>;
/**
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<{ id: string, name: string }[]>} The running jobs whose lease ended, the oldest first.
 */
export declare function findStaleJobs(executor: Executor, p: string, limit: number): Promise<{
    id: string;
    name: string;
}[]>;
/**
 * A running job whose lease ended: one more stall, pending again after 30 s × 2^stalls (at most 1 h); after maxStalls,
 * it fails for good. Its keys linger for one lease: its old handler may still run.
 * @param {Executor} executor
 * @param {string} p
 * @param {string} id
 * @param {{ leaseMs: number, buildFailureJob: FailureJobBuilder }} params
 * @returns {Promise<{ result: 'released' | 'failed' | null, failureJob: FailureJobResult | null }>} null: not stale
 *     (any more).
 */
export declare function recoverStaleJob(executor: Executor, p: string, id: string, { leaseMs, buildFailureJob }: {
    leaseMs: number;
    buildFailureJob: FailureJobBuilder;
}): Promise<{
    result: 'released' | 'failed' | null;
    failureJob: FailureJobResult | null;
}>;
/**
 * Deletes the ended lingers, and the holds without their running job (from a manual change, or old code).
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<{ lingers: number, orphans: number }>}
 */
export declare function sweepMutexes(executor: Executor, p: string, limit: number): Promise<{
    lingers: number;
    orphans: number;
}>;
/**
 * Deletes a batch of completed and failed jobs whose retention ended, with their payloads. SKIP LOCKED: processes
 * share the work.
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<number>} The deleted jobs.
 */
export declare function deleteExpiredJobs(executor: Executor, p: string, limit: number): Promise<number>;
/**
 * For drain({ includeDelayed }): the pending jobs of the names are due now.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} names
 * @returns {Promise<void>}
 */
export declare function makeDue(executor: Executor, p: string, names: string[]): Promise<void>;
/**
 * The counts per job name, for alerts such as "queue stuck".
 * @param {Executor} executor
 * @param {string} p
 * @returns {Promise<import('../types.js').JobStats[]>}
 */
export declare function getStats(executor: Executor, p: string): Promise<import('../types.js').JobStats[]>;
