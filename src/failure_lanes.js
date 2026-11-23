// The failure job of a job that fails for good: built from its definition in this process, inserted by the store in
// the transaction of the fail, then reported. See docs/design.md › Failure jobs.
import { buildNewJob } from './new_job.js';

/**
 * @typedef {object} FailureLanes
 * @property {import('./store/store.js').FailureJobBuilder} build The failure job of a failed job: its definition's
 *     options (or the defaults), and no failure lane of its own.
 * @property {(job: { id: string, lane: string, attempt: number, failureLane: string | null },
 *     result: import('./store/store.js').FailureJobResult | null) => void} report An added failure job wakes its lane
 *     here and in the other processes; one that the database refused is an error and a `failure_job_not_added` event.
 */

/**
 * @param {object} params
 * @param {import('./registry.js').Registry} params.registry
 * @param {import('./defaults.js').ResolvedDefaults} params.defaults
 * @param {(event: import('./types.js').SqlaneEvent) => void} params.emit
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @param {(lane: string) => void} params.onAdded A failure job of the lane was added: its commit is to come.
 * @returns {FailureLanes}
 */
export function createFailureLanes({ registry, defaults, emit, reportError, onAdded }) {
    return {
        build: (failed) => {
            const newJob = buildNewJob({
                lane: failed.failureLane,
                definition: registry.findDefinition(failed.failureLane),
                defaults,
                payload: {
                    job: {
                        id: failed.id,
                        lane: failed.lane,
                        payload: failed.payload,
                        attempt: failed.attempt,
                        maxAttempts: failed.maxAttempts,
                    },
                    error: failed.error,
                },
                options: undefined,
                maxPayloadBytes: Infinity,
            });

            return { ...newJob, failureLane: null };
        },
        report: (job, result) => {
            if (result && 'notAdded' in result) {
                reportError('failure_job', result.notAdded);
                emit({
                    type: 'failure_job_not_added',
                    jobId: job.id,
                    lane: job.lane,
                    attempt: job.attempt,
                    failureLane: String(job.failureLane),
                    error: result.notAdded,
                });
            } else if (result && 'added' in result) {
                onAdded(result.added.lane);
            }
        },
    };
}
