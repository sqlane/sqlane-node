export type FailureJobs = {
    /**
     * The failure job of a failed job: its definition's
     * options (or the defaults), and no failure job of its own.
     */
    build: import('./store/store.js').FailureJobBuilder;
    /**
     * An added failure job wakes its name
     * here and in the other processes; one that the database refused is an error and a `failure_job_not_added` event.
     */
    report: (job: {
        id: string;
        name: string;
        attempt: number;
        failureJob: string | null;
    }, result: import('./store/store.js').FailureJobResult | null) => void;
};
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
export declare function createFailureJobs({ registry, defaults, emit, reportError, onAdded }: {
    registry: import('./registry.js').Registry;
    defaults: import('./defaults.js').ResolvedDefaults;
    emit: (event: import('./types.js').SqlaneEvent) => void;
    reportError: (operation: string, error: unknown) => void;
    onAdded: (name: string) => void;
}): FailureJobs;
