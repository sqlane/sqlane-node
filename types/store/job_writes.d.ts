export type Executor = import('../types.js').Executor;
export type JobStatus = import('../types.js').JobStatus;
export type Db = {
    executor: Executor;
    /**
     * MariaDB runs the SQL of MySQL.
     */
    family: 'mysql' | 'postgres';
    /**
     * The table prefix.
     */
    p: string;
};
export type ReadJob = {
    id: string;
    status: JobStatus;
    /**
     * Its payload exists.
     */
    found: boolean;
};
export type LockedJob = {
    id: string;
    status: JobStatus;
    attempts: number;
    /**
     * The keys of its global limits, as stored.
     */
    keys: string[];
    name: string;
    /**
     * Its payload exists.
     */
    found: boolean;
};
export type Written = {
    /**
     * The jobs that it changed.
     */
    count: number;
    /**
     * Their exact ids on PostgreSQL; null on MySQL and MariaDB.
     */
    ids: string[] | null;
};
/**
 * The jobs of the ids, with their status and whether their payload exists. No lock.
 * @param {Db} db
 * @param {readonly string[]} ids
 * @returns {Promise<ReadJob[]>}
 */
export declare function readByIds({ executor, family, p }: Db, ids: readonly string[]): Promise<ReadJob[]>;
/**
 * The jobs of a name in the statuses, and whether their payload exists. No lock.
 * @param {Db} db
 * @param {{ jobName: string, statuses: readonly JobStatus[] }} filter
 * @returns {Promise<{ id: string, found: boolean }[]>}
 */
export declare function readByFilter({ executor, family, p }: Db, { jobName, statuses }: {
    jobName: string;
    statuses: readonly JobStatus[];
}): Promise<{
    id: string;
    found: boolean;
}[]>;
/**
 * The next batch of the jobs of a name in the statuses, in the order of `jobs.list`: after `after`, newest first. No
 * lock. It seeks in the index of 0008_job_list, as `jobs.list`.
 * @param {Db} db
 * @param {{ jobName: string, statuses: readonly JobStatus[], after: { ms: number, id: string } | null, limit: number }}
 *     params
 * @returns {Promise<{ id: string, ms: number }[]>}
 */
export declare function readBatch({ executor, family, p }: Db, { jobName, statuses, after, limit }: {
    jobName: string;
    statuses: readonly JobStatus[];
    after: {
        ms: number;
        id: string;
    } | null;
    limit: number;
}): Promise<{
    id: string;
    ms: number;
}[]>;
/**
 * Locks the jobs of the ids that are in the statuses, by primary key, in id order (the ids are sorted). In READ
 * COMMITTED, a row changed meanwhile is checked again; a row in another status is not locked.
 * @param {Db} db
 * @param {{ ids: readonly string[], statuses: readonly JobStatus[] }} target `ids` sorted.
 * @returns {Promise<LockedJob[]>}
 */
export declare function lockJobs({ executor, family, p }: Db, { ids, statuses }: {
    ids: readonly string[];
    statuses: readonly JobStatus[];
}): Promise<LockedJob[]>;
/**
 * Failed jobs back to pending: due now, or when the lingering slots of their earlier runs end. Guarded by the status.
 * @param {Db} db
 * @param {{ ids: readonly string[], budget: 'reset' | 'one_more' }} target
 * @returns {Promise<Written>}
 */
export declare function retryJobs({ executor, family, p }: Db, { ids, budget }: {
    ids: readonly string[];
    budget: 'reset' | 'one_more';
}): Promise<Written>;
/**
 * Pending and blocked jobs to failed, with the error of a cancel, from now for their failed retention. Guarded by the
 * status.
 * @param {Db} db
 * @param {{ ids: readonly string[], statuses: readonly JobStatus[], errorJson: string }} target `statuses`: pending,
 *     blocked or both. `errorJson`: the `last_error` of the jobs.
 * @returns {Promise<Written>}
 */
export declare function cancelJobs({ executor, family, p }: Db, { ids, statuses, errorJson }: {
    ids: readonly string[];
    statuses: readonly JobStatus[];
    errorJson: string;
}): Promise<Written>;
/**
 * Deletes the jobs in the statuses, and their payloads. Guarded by the status: a job claimed meanwhile keeps its row
 * and its payload. The slots are not touched: a linger stays until its time.
 * @param {Db} db
 * @param {{ ids: readonly string[], statuses: readonly JobStatus[] }} target
 * @returns {Promise<Written>}
 */
export declare function removeJobs({ executor, family, p }: Db, { ids, statuses }: {
    ids: readonly string[];
    statuses: readonly JobStatus[];
}): Promise<Written>;
/**
 * PostgreSQL with the `notify` option: the hint of the retried names, in the transaction (sent at its commit).
 * @param {Executor} executor
 * @param {string} channel
 * @param {readonly string[]} names
 * @returns {Promise<void>}
 */
export declare function notifyNames(executor: Executor, channel: string, names: readonly string[]): Promise<void>;
