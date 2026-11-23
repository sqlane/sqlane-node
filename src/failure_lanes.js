// The failure job of a job that fails for good: its lane and its options from the definition of the job's lane in this
// process, inserted by the store in the transaction of the fail, then reported. See docs/design.md › Failure jobs.
import { buildNewJob } from './new_job.js';

/**
 * @typedef {object} FailureLanes
 * @property {(definition: import('./types.js').LaneDefinition | null) => import('./store/store.js').FailureJobBuilder}
 *     builderOf The failure job of a job of a lane with this definition in this process. Null: a lane added without a
 *     definition: the failure lane of the row, from its enqueue.
 * @property {(job: { id: string, lane: string, attempt: number },
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
    /**
     * @param {string | import('./types.js').LaneDefinition | undefined} failureLane Of a definition.
     * @returns {import('./types.js').LaneDefinition | null} The definition of the failure lane: a definition object
     *     itself, a name in `lanes` or added.
     */
    function definitionOf(failureLane) {
        return typeof failureLane === 'object' ? failureLane : registry.findDefinition(String(failureLane));
    }

    return {
        builderOf: (definition) => {
            const ownLane = definition?.failureLane;

            return {
                laneOf: (stored) => {
                    if (!definition) {
                        return stored;
                    }

                    return typeof ownLane === 'object' ? ownLane.name : ownLane ?? null;
                },
                build: (failed) => {
                    const newJob = buildNewJob({
                        lane: failed.failureLane,
                        definition: definition ? definitionOf(ownLane) : registry.findDefinition(failed.failureLane),
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
            };
        },
        report: (job, result) => {
            if (result && 'notAdded' in result) {
                reportError('failure_job', result.notAdded);
                emit({
                    type: 'failure_job_not_added',
                    jobId: job.id,
                    lane: job.lane,
                    attempt: job.attempt,
                    failureLane: result.failureLane,
                    error: result.notAdded,
                });
            } else if (result && 'added' in result) {
                onAdded(result.added.lane);
            }
        },
    };
}
