export type JobDefinition = import('./types.js').JobDefinition;
export type Lane = {
    name: string;
    concurrency: number;
    running: number;
};
export type HandlerEntry = {
    name: string;
    definition: JobDefinition | null;
    handler: import('./types.js').Handler;
    lane: Lane;
    /**
     * Resolved: the handle() options, else the definition, else the defaults.
     */
    timeoutMs: number | null;
};
export type Registry = {
    handle: (job: JobDefinition | string, handler: import('./types.js').Handler, options?: object) => void;
    getEntry: (name: string) => HandlerEntry | undefined;
    entries: () => HandlerEntry[];
    /**
     * In `jobs`, else handled.
     */
    findDefinition: (name: string) => JobDefinition | null;
    /**
     * The handled names whose definition has mutex keys.
     */
    keyedNames: () => string[];
    /**
     * Checks the handlers together: each failure job resolves and has none of its own.
     */
    validate: () => void;
};
/** @typedef {import('./types.js').JobDefinition} JobDefinition */
/**
 * A concurrency limit in this process.
 * @typedef {object} Lane
 * @property {string} name
 * @property {number} concurrency
 * @property {number} running
 */
/**
 * @typedef {object} HandlerEntry
 * @property {string} name
 * @property {JobDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {Lane} lane
 * @property {number | null} timeoutMs Resolved: the handle() options, else the definition, else the defaults.
 */
/**
 * @typedef {object} Registry
 * @property {(job: JobDefinition | string, handler: import('./types.js').Handler, options?: object) => void} handle
 * @property {(name: string) => HandlerEntry | undefined} getEntry
 * @property {() => HandlerEntry[]} entries
 * @property {(name: string) => JobDefinition | null} findDefinition In `jobs`, else handled.
 * @property {() => string[]} keyedNames The handled names whose definition has mutex keys.
 * @property {() => void} validate Checks the handlers together: each failure job resolves and has none of its own.
 */
/**
 * @param {object} params
 * @param {Map<string, JobDefinition>} params.jobsByName
 * @param {unknown} params.lanes The `lanes` option.
 * @param {number} params.concurrency The process concurrency.
 * @param {number | null} params.defaultTimeoutMs
 * @returns {Registry}
 */
export declare function createRegistry({ jobsByName, lanes, concurrency, defaultTimeoutMs }: {
    jobsByName: Map<string, JobDefinition>;
    lanes: unknown;
    concurrency: number;
    defaultTimeoutMs: number | null;
}): Registry;
