export type FailureLanes = {
    /**
     * The failure job of a failed job: its definition's
     * options (or the defaults), and no failure lane of its own.
     */
    build: import('./store/store.js').FailureJobBuilder;
    /**
     * An added failure job wakes its lane
     * here and in the other processes; one that the database refused is an error and a `failure_job_not_added` event.
     */
    report: (job: {
        id: string;
        lane: string;
        attempt: number;
        failureLane: string | null;
    }, result: import('./store/store.js').FailureJobResult | null) => void;
};
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
export declare function createFailureLanes({ registry, defaults, emit, reportError, onAdded }: {
    registry: import('./registry.js').Registry;
    defaults: import('./defaults.js').ResolvedDefaults;
    emit: (event: import('./types.js').SqlaneEvent) => void;
    reportError: (operation: string, error: unknown) => void;
    onAdded: (lane: string) => void;
}): FailureLanes;
