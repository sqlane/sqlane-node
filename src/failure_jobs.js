// The failure job of a job that fails for good: built from its definition in this process, inserted by the store in
// the transaction of the fail, then reported. See docs/design.md › Failure jobs.
import { buildNewJob } from './new_job.js';

/**
 * @typedef {object} FailureJobs
 * @property {import('./store/store.js').FailureJobBuilder} build The failure job of a failed job: its definition's
 *     options (or the defaults), and no failure job of its own.
 * @property {(job: { id: string, name: string, attempt: number, failureJob: string | null },
 *     result: import('./store/store.js').FailureJobResult | null) => void} report An added failure job wakes its name
 *     here and in the other processes; one that the database refused is an error and a `failure_job_not_added` event.
 */

/**
 * @param {object} params
 * @param {import('./registry.js').Registry} params.registry
 * @param {import('./defaults.js').ResolvedDefaults} params.defaults
 * @param {(event: import('./types.js').SqlaneEvent) => void} params.emit
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @param {(name: string) => void} params.onAdded A failure job of the name was added: its commit is to come.
 * @returns {FailureJobs}
 */
export function createFailureJobs({ registry, defaults, emit, reportError, onAdded }) {
    return {
        build: (failed) => {
            const newJob = buildNewJob({
                name: failed.failureJob,
                definition: registry.findDefinition(failed.failureJob),
                defaults,
                payload: {
                    job: {
                        id: failed.id,
                        name: failed.name,
                        payload: failed.payload,
                        attempt: failed.attempt,
                        maxAttempts: failed.maxAttempts,
                    },
                    error: failed.error,
                },
                options: undefined,
                maxPayloadBytes: Infinity,
            });

            return { ...newJob, failureJob: null };
        },
        report: (job, result) => {
            if (result && 'notAdded' in result) {
                reportError('failure_job', result.notAdded);
                emit({
                    type: 'failure_job_not_added',
                    jobId: job.id,
                    jobName: job.name,
                    attempt: job.attempt,
                    failureJob: String(job.failureJob),
                    error: result.notAdded,
                });
            } else if (result && 'added' in result) {
                onAdded(result.added.name);
            }
        },
    };
}
