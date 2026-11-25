export type FailureLanes = {
    /**
     * The failure job of a job of a lane with this definition in this process. None without a
     * `failureLane`.
     */
    builderOf: (definition: import('./types.js').LaneDefinition) => import('./store/store.js').FailureJobBuilder;
    /**
     * An added failure job wakes its lane
     * here and in the other processes; one that the database refused is an error and a `failure_job_not_added` event.
     */
    report: (job: {
        id: string;
        lane: string;
        attempt: number;
        fairGroup: string | null;
    }, result: import('./store/store.js').FailureJobResult | null) => void;
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
export declare function withoutGroupUnless(ready: boolean, job: import('./new_job.js').NewJob): import('./new_job.js').NewJob;
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
export declare function createFailureLanes({ defaults, emit, reportError, onAdded, fairGroupsReady }: {
    defaults: import('./defaults.js').ResolvedDefaults;
    emit: (event: import('./types.js').SqlaneEvent) => void;
    reportError: (operation: string, error: unknown) => void;
    onAdded: (lane: string) => void;
    fairGroupsReady?: () => boolean;
}): FailureLanes;
