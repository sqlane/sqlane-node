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
 * The jobs are done: completed until their retention ends, without their payloads; their keys are freed. One
 * transaction for many jobs: one commit.
 * @param {Executor} executor
 * @param {string} p
 * @param {import('./store.js').FinishedJob[]} jobs
 * @returns {Promise<number>} The jobs that this call completed: the others lost their lease, or an earlier try
 *     committed.
 */
export declare function completeJobs(executor: Executor, p: string, jobs: import('./store.js').FinishedJob[]): Promise<number>;
/**
 * The attempt failed: pending again after the delay, one more attempt used; its slots are freed.
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
 * The job fails for good: failed until its retention ends, with its payload; its slots are freed; its failure job is
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
 * @param {{ delayMs: number, lingerMs: number }} params lingerMs: its slots stay held this long (its handler still
 *     runs); 0: they are freed.
 * @returns {Promise<boolean>} False: no change.
 */
export declare function releaseJob(executor: Executor, p: string, job: OwnedJob, { delayMs, lingerMs }: {
    delayMs: number;
    lingerMs: number;
}): Promise<boolean>;
/**
 * The handler threw a RateLimitedError on rate keys of the job: the tat of each moves to `now + retryAfter + τ` at the
 * least (its next start at `now + retryAfter`, then one per per / max), by the settings of the job; a missing row is
 * created. The job is blocked on the first key, without an attempt used, and its slots are freed. The order of the
 * locks of a claim: the job, the rows of the keys in their order, then the slots.
 * @param {Executor} executor
 * @param {string} p
 * @param {OwnedJob} job
 * @param {import('./store.js').RateLimitedParams} params
 * @returns {Promise<import('./store.js').RateLimitedResult>}
 */
export declare function rateLimited(executor: Executor, p: string, job: OwnedJob, { limits, retryAfterMs, error }: import('./store.js').RateLimitedParams): Promise<import('./store.js').RateLimitedResult>;
/**
 * The work of the stall recovery, in one read with no lock: the running jobs whose lease ended, the oldest first (a
 * row each, none: one row with null ids), and on each row whether there are ended lingers, orphan slots, blocked jobs
 * and rows of rate keys whose tat passed. So an idle recovery costs one statement: the parts with nothing to do do not
 * run. A part that the read misses (a row of a transaction that commits after it) runs at the next recovery.
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit Of the stale jobs.
 * @returns {Promise<readonly Record<string, unknown>[]>} id, lane, and the parts: lingers, orphans, blocked,
 *     idle_rate_keys (0 or 1).
 */
export declare function readRecoveryWork(executor: Executor, p: string, limit: number): Promise<readonly Record<string, unknown>[]>;
/**
 * A running job whose lease ended: one more stall, pending again after 30 s × 2^stalls (at most 1 h); after maxStalls,
 * it fails for good. Its slots linger for one lease: its old handler may still run.
 * @param {Executor} executor
 * @param {string} p
 * @param {string} id
 * @param {{ leaseMs: number, buildFailureJob: FailureJobBuilder }} params
 * @returns {Promise<import('./store.js').StaleJobResult>} `result` null: not stale (any more).
 */
export declare function recoverStaleJob(executor: Executor, p: string, id: string, { leaseMs, buildFailureJob }: {
    leaseMs: number;
    buildFailureJob: FailureJobBuilder;
}): Promise<import('./store.js').StaleJobResult>;
/**
 * Makes the jobs blocked on the keys pending again, the oldest first: on each key, as many as it has room for, by the
 * max of its oldest blocked job. A read first; the writes in a transaction, only when a key has room.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} keys
 * @param {<T>(func: (executor: Executor) => Promise<T>) => Promise<T>} [inTransaction] Runs the writes. Default: on
 *     `executor`, which is in a transaction already.
 * @returns {Promise<string[]>} The names of the jobs that it made pending.
 */
export declare function unblock(executor: Executor, p: string, keys: string[], inTransaction?: <T>(func: (executor: Executor) => Promise<T>) => Promise<T>): Promise<string[]>;
/**
 * Makes the jobs blocked on the rate keys pending again, the oldest first: on each key, as many as its quota allows
 * now, each job by its own settings (gcra.js, `admitQueue`), at most RATE_UNBLOCK_BATCH. It does not take the quota:
 * the claim does, and blocks again a job that another one got ahead of. A read of the oldest blocked job of each key,
 * with the debt of the key: by its settings, `most` jobs fit. Then, only when a job may start, a transaction: the
 * `most + 1` oldest jobs of the key, locked, and the update of the prefix that fits. So the reads are as long as the
 * prefix, not as the queue. A job of other settings after the first `most` waits for the next unblock, at once, like
 * the one after a full batch.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} keys
 * @param {import('./postgres_final.js').RateUnblockOptions} [options]
 * @returns {Promise<{ names: string[], waits: import('./postgres_final.js').RateUnblock[] }>} The names of the jobs
 *     that it made pending; the keys on which it found blocked jobs.
 */
export declare function unblockRates(executor: Executor, p: string, keys: string[], options?: import('./postgres_final.js').RateUnblockOptions): Promise<{
    names: string[];
    waits: import('./postgres_final.js').RateUnblock[];
}>;
/**
 * Deletes the ended lingers, and the slots without their running job (from a manual change, or old code). Then
 * unblocks the jobs blocked on keys with room: a release that ended in a linger, or a process that stopped before its
 * unblock; and the jobs blocked on rate keys whose next start is due: a process that stopped with its timer.
 * @param {Executor} executor
 * @param {string} p
 * @param {number} limit
 * @param {import('./store.js').SweepParts} parts The parts to run: those that the read of the recovery
 *     found work for (readRecoveryWork). A part left out counts 0.
 * @returns {Promise<import('./store.js').SweepResult>}
 */
export declare function sweepSlots(executor: Executor, p: string, limit: number, parts: import('./store.js').SweepParts): Promise<import('./store.js').SweepResult>;
/**
 * Deletes a batch of rows of rate keys whose tat passed: such a key has its full quota, as without a row. SKIP LOCKED:
 * a claim holds the rows of its keys.
 * @param {Executor} executor In a transaction.
 * @param {string} p
 * @param {number} limit
 * @returns {Promise<number>} The deleted rows.
 */
export declare function deleteIdleRateKeys(executor: Executor, p: string, limit: number): Promise<number>;
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
 * The counts per job name, for alerts such as "queue stuck". It reads every row kept, of every status.
 * @param {Executor} executor
 * @param {string} p
 * @returns {Promise<import('../types.js').JobStats[]>}
 */
export declare function getStats(executor: Executor, p: string): Promise<import('../types.js').JobStats[]>;
