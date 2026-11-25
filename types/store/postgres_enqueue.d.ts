/**
 * A job as the input of the insert: a row of `jsonb_to_recordset`. Shared with the insert of the schedules.
 * @param {import('../new_job.js').NewJob} job
 * @returns {Record<string, unknown>}
 */
export declare function toJobInput(job: import('../new_job.js').NewJob): Record<string, unknown>;
/**
 * The column of the fair group in the insert, only when a job has a group: an insert without groups runs on a schema
 * without `0011_fair_groups`.
 * @param {import('../new_job.js').NewJob[]} jobs
 * @returns {string} `, fair_group`, for the column list of the INSERT and of its SELECT; or '': the statement of 10.0,
 *     unchanged (its prepared statement too).
 */
export declare function fairGroupColumn(jobs: import('../new_job.js').NewJob[]): string;
/**
 * Inserts the jobs and their payloads. With a notify channel, a NOTIFY of the lane when it created a job, in the
 * same statement.
 * @param {import('../types.js').Executor} executor
 * @param {string} p The table prefix.
 * @param {import('../new_job.js').NewJob[]} jobs Their ids are distinct, of one lane.
 * @param {{ enqueueToken: string, notifyChannel?: string | null }} options
 * @returns {Promise<Set<string>>} The ids that this call created.
 */
export declare function insertJobsPostgres(executor: import('../types.js').Executor, p: string, jobs: import('../new_job.js').NewJob[], { enqueueToken, notifyChannel }: {
    enqueueToken: string;
    notifyChannel?: string | null;
}): Promise<Set<string>>;
