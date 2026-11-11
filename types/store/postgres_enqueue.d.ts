/**
 * Inserts the jobs and their payloads. With a notify channel, a NOTIFY of the job name when it created a job, in the
 * same statement.
 * @param {import('../types.js').Executor} executor
 * @param {string} p The table prefix.
 * @param {import('../new_job.js').NewJob[]} jobs Their ids are distinct, of one name.
 * @param {{ enqueueToken: string, notifyChannel?: string | null }} options
 * @returns {Promise<Set<string>>} The ids that this call created.
 */
export declare function insertJobsPostgres(executor: import('../types.js').Executor, p: string, jobs: import('../new_job.js').NewJob[], { enqueueToken, notifyChannel }: {
    enqueueToken: string;
    notifyChannel?: string | null;
}): Promise<Set<string>>;
