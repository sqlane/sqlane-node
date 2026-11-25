// The failure job of a job that fails for good: its lane and its options from the definition of the job's lane in this
// process, inserted by the store in the transaction of the fail, then reported. See docs/design.md › Failure jobs.
import { buildNewJob } from './new_job.js';

/** @type {import('./store/store.js').FailureJobBuilder} A lane without a failure lane: the store adds no failure job */
const NO_FAILURE_JOB = {
    lane: null,
    build: () => {
        throw new Error('sqlane: a lane without a failure lane has no failure job');
    },
};

/**
 * @typedef {object} FailureLanes
 * @property {(definition: import('./types.js').LaneDefinition) => import('./store/store.js').FailureJobBuilder}
 *     builderOf The failure job of a job of a lane with this definition in this process. None without a
 *     `failureLane`.
 * @property {(job: { id: string, lane: string, attempt: number, fairGroup: string | null },
 *     result: import('./store/store.js').FailureJobResult | null) => void} report An added failure job wakes its lane
 *     here and in the other processes; one that the database refused is an error and a `failure_job_not_added` event.
 */

/**
 * A job that a runner adds itself (a failure job, the slot of a schedule), on a schema without `0011_fair_groups`: no
 * group, so its insert does not write the missing column.
 * @param {boolean} ready The schema has `0011_fair_groups`.
 * @param {import('./new_job.js').NewJob} job
 * @returns {import('./new_job.js').NewJob}
 */
export function withoutGroupUnless(ready, job) {
    return ready || job.fairGroup === null ? job : { ...job, fairGroup: null };
}

/**
 * @param {object} params
 * @param {import('./defaults.js').ResolvedDefaults} params.defaults
 * @param {(event: import('./types.js').SqlaneEvent) => void} params.emit
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @param {(lane: string) => void} params.onAdded A failure job of the lane was added: its commit is to come.
 * @param {() => boolean} [params.fairGroupsReady] The schema has `0011_fair_groups`. Without, a failure job gets no
 *     fair group (its insert has no column to write it). Default: it has.
 * @returns {FailureLanes}
 */
export function createFailureLanes({ defaults, emit, reportError, onAdded, fairGroupsReady = () => true }) {
    return {
        builderOf: ({ failureLane }) => {
            if (!failureLane) {
                return NO_FAILURE_JOB;
            }

            return {
                lane: failureLane.name,
                build: failed => withoutGroupUnless(fairGroupsReady(), buildNewJob({
                    lane: failureLane.name,
                    definition: failureLane,
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
                })),
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
                    fairGroup: job.fairGroup,
                    failureLane: result.failureLane,
                    error: result.notAdded,
                });
            } else if (result && 'added' in result) {
                onAdded(result.added.lane);
            }
        },
    };
}
