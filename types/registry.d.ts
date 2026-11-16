export type JobDefinition = import('./types.js').JobDefinition;
export type RateState = import('./local_rates.js').RateState;
export type LimitState = {
    limit: import('./types.js').ConcurrencyLimit;
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
     * Its fairShareWeight.
     */
    weight: number;
    /**
     * Its jobs that run in this instance.
     */
    running: number;
    /**
     * Its local concurrency limits.
     */
    limits: LimitState[];
    /**
     * Its local rate limits.
     */
    rates: RateState[];
    /**
     * Resolved: the definition, else the defaults.
     */
    timeoutMs: number | null;
};
export type Registry = {
    handle: (job: JobDefinition | string, handler: import('./types.js').Handler, options?: unknown) => void;
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
     * The handled names whose definition has global limits, of
     * concurrency or of rate.
     */
    namesWithLimits: () => string[];
    /**
     * The handled names whose definition has global rate limits.
     */
    namesWithRateLimits: () => string[];
    /**
     * Checks the handlers together: each failure job resolves and has none of its own.
     */
    validate: () => void;
};
/** @typedef {import('./types.js').JobDefinition} JobDefinition */
/** @typedef {import('./local_rates.js').RateState} RateState */
/**
 * A local concurrency limit in this instance: its handlers that run.
 * @typedef {object} LimitState
 * @property {import('./types.js').ConcurrencyLimit} limit
 * @property {number} running
 * @property {string[]} names Its handled names.
 */
/**
 * @typedef {object} HandlerEntry
 * @property {string} name
 * @property {number} index Its position in the order of the handle() calls: the order of the ties.
 * @property {JobDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {number} weight Its fairShareWeight.
 * @property {number} running Its jobs that run in this instance.
 * @property {LimitState[]} limits Its local concurrency limits.
 * @property {RateState[]} rates Its local rate limits.
 * @property {number | null} timeoutMs Resolved: the definition, else the defaults.
 */
/**
 * @typedef {object} Registry
 * @property {(job: JobDefinition | string, handler: import('./types.js').Handler, options?: unknown) => void} handle
 * @property {(name: string) => HandlerEntry | undefined} getEntry
 * @property {() => HandlerEntry[]} entries In the order of the handle() calls.
 * @property {(name: string) => JobDefinition | null} findDefinition In `jobs`, else handled.
 * @property {() => string[]} namesWithLimits The handled names whose definition has global limits, of
 *     concurrency or of rate.
 * @property {() => string[]} namesWithRateLimits The handled names whose definition has global rate limits.
 * @property {() => void} validate Checks the handlers together: each failure job resolves and has none of its own.
 */
/**
 * @param {object} params
 * @param {Map<string, JobDefinition>} params.jobsByName
 * @param {number | null} params.defaultTimeoutMs
 * @returns {Registry}
 */
export declare function createRegistry({ jobsByName, defaultTimeoutMs }: {
    jobsByName: Map<string, JobDefinition>;
    defaultTimeoutMs: number | null;
}): Registry;
