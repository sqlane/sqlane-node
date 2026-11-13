export type JobDefinition = import('./types.js').JobDefinition;
export type GroupState = {
    group: import('./types.js').ConcurrencyGroup;
    running: number;
    /**
     * Its handled names.
     */
    names: string[];
};
export type HandlerEntry = {
    name: string;
    /**
     * Its position in the order of the handle() calls: the order of the ties.
     */
    index: number;
    definition: JobDefinition | null;
    handler: import('./types.js').Handler;
    /**
     * Null: only the caps of its group and of the instance.
     */
    maxConcurrency: number | null;
    /**
     * Its fairShareWeight.
     */
    weight: number;
    /**
     * Its jobs that run in this instance.
     */
    running: number;
    group: GroupState | null;
    /**
     * Resolved: the handle() options, else the definition, else the defaults.
     */
    timeoutMs: number | null;
};
export type Registry = {
    handle: (job: JobDefinition | string, handler: import('./types.js').Handler, options?: object) => void;
    getEntry: (name: string) => HandlerEntry | undefined;
    /**
     * In the order of the handle() calls.
     */
    entries: () => HandlerEntry[];
    /**
     * In `jobs`, else handled.
     */
    findDefinition: (name: string) => JobDefinition | null;
    /**
     * The handled names whose definition has mutex keys.
     */
    namesWithKeys: () => string[];
    /**
     * Checks the handlers together: each failure job resolves and has none
     * of its own, and no cap is above the instance's. `where`: `start()` or `drain()`, for the messages.
     */
    validate: (where: string) => void;
};
/**
 * A concurrency group in this instance: its handlers that run.
 * @typedef {object} GroupState
 * @property {import('./types.js').ConcurrencyGroup} group
 * @property {number} running
 * @property {string[]} names Its handled names.
 */
/**
 * @typedef {object} HandlerEntry
 * @property {string} name
 * @property {number} index Its position in the order of the handle() calls: the order of the ties.
 * @property {JobDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {number | null} maxConcurrency Null: only the caps of its group and of the instance.
 * @property {number} weight Its fairShareWeight.
 * @property {number} running Its jobs that run in this instance.
 * @property {GroupState | null} group
 * @property {number | null} timeoutMs Resolved: the handle() options, else the definition, else the defaults.
 */
/**
 * @typedef {object} Registry
 * @property {(job: JobDefinition | string, handler: import('./types.js').Handler, options?: object) => void} handle
 * @property {(name: string) => HandlerEntry | undefined} getEntry
 * @property {() => HandlerEntry[]} entries In the order of the handle() calls.
 * @property {(name: string) => JobDefinition | null} findDefinition In `jobs`, else handled.
 * @property {() => string[]} namesWithKeys The handled names whose definition has mutex keys.
 * @property {(where: string) => void} validate Checks the handlers together: each failure job resolves and has none
 *     of its own, and no cap is above the instance's. `where`: `start()` or `drain()`, for the messages.
 */
/**
 * @param {object} params
 * @param {Map<string, JobDefinition>} params.jobsByName
 * @param {number} params.maxConcurrency The instance's cap.
 * @param {number | null} params.defaultTimeoutMs
 * @returns {Registry}
 */
export declare function createRegistry({ jobsByName, maxConcurrency, defaultTimeoutMs }: {
    jobsByName: Map<string, JobDefinition>;
    maxConcurrency: number;
    defaultTimeoutMs: number | null;
}): Registry;
