/**
 * Inserts the jobs and their payloads. Call it in a transaction.
 * @param {import('../types.js').Executor} executor
 * @param {string} p The table prefix.
 * @param {import('../new_job.js').NewJob[]} jobs Their ids are distinct.
 * @param {string} enqueueToken
 * @returns {Promise<Set<string>>} The ids that this call created.
 */
export declare function insertJobsMariadb(executor: import('../types.js').Executor, p: string, jobs: import('../new_job.js').NewJob[], enqueueToken: string): Promise<Set<string>>;
