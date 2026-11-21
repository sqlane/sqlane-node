export type Executor = import('../types.js').Executor;
export type JobRecord = import('../types.js').JobRecord;
export type Family = 'mysql' | 'postgres';
export type FamilySql = {
    /**
     * A time as epoch ms, whatever the time zone of the session.
     */
    epochMs: (column: string) => string;
    /**
     * A JSON column as text.
     */
    json: (column: string) => string;
    /**
     * An array of keys or maxes as JSON text.
     */
    array: (column: string) => string;
    /**
     * A time parameter, typed as the column.
     */
    time: (ms: number, param: (value: unknown) => string) => string;
    placeholder: (index: number) => string;
};
/**
 * One job by its full id, with its payload. Null: no such job.
 * @param {Executor} executor
 * @param {Family} family
 * @param {string} p
 * @param {string} id
 * @returns {Promise<JobRecord | null>}
 */
export declare function getJob(executor: Executor, family: Family, p: string, id: string): Promise<JobRecord | null>;
export type ListParams = {
    jobName: string;
    /**
     * Null: every status.
     */
    statuses: readonly import('../types.js').JobStatus[] | null;
    limit: number;
    /**
     * The last job of the previous page.
     */
    after: {
        enqueuedAtMs: number;
        id: string;
    } | null;
    includePayload: boolean;
};
/**
 * @typedef {object} ListParams
 * @property {string} jobName
 * @property {readonly import('../types.js').JobStatus[] | null} statuses Null: every status.
 * @property {number} limit
 * @property {{ enqueuedAtMs: number, id: string } | null} after The last job of the previous page.
 * @property {boolean} includePayload
 */
/**
 * A page of the jobs of a name, newest first: by enqueue time, then by id. One row more than the limit tells whether
 * a next page exists. Both families seek in the index `(job_name, created_at, id)` of 0008_job_list: PostgreSQL with
 * a row comparison, which it does not do with an OR; MySQL and MariaDB with the OR, which they turn into ranges, and an
 * index hint, without which MariaDB 10.11 filters the rows of the name, and MySQL 8.4 and MariaDB 11.8 sort the rows of
 * a status.
 * @param {Executor} executor
 * @param {Family} family
 * @param {string} p
 * @param {ListParams} params
 * @returns {Promise<{ jobs: JobRecord[], last: { enqueuedAtMs: number, id: string } | null }>} `last`: the last job of
 *     the page, when a next page may exist.
 */
export declare function listJobs(executor: Executor, family: Family, p: string, { jobName, statuses, limit, after, includePayload }: ListParams): Promise<{
    jobs: JobRecord[];
    last: {
        enqueuedAtMs: number;
        id: string;
    } | null;
}>;
