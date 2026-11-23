export type LaneDefinition = import('./types.js').LaneDefinition;
export type RateState = import('./local_rates.js').RateState;
export type LimitState = {
    limit: import('./types.js').ConcurrencyLimit;
    running: number;
    /**
     * Its added lanes.
     */
    lanes: string[];
};
export type HandlerEntry = {
    name: string;
    /**
     * Its position in the order of the lanes.add() calls: the order of the ties.
     */
    index: number;
    definition: LaneDefinition | null;
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
    add: (lane: LaneDefinition | string, handler: import('./types.js').Handler, options?: unknown) => void;
    getEntry: (lane: string) => HandlerEntry | undefined;
    /**
     * In the order of the lanes.add() calls.
     */
    entries: () => HandlerEntry[];
    /**
     * In `lanes`, else added.
     */
    findDefinition: (lane: string) => LaneDefinition | null;
    /**
     * The added lanes whose definition has global limits, of concurrency or
     * of rate.
     */
    lanesWithLimits: () => string[];
    /**
     * The added lanes whose definition has global rate limits.
     */
    lanesWithRateLimits: () => string[];
    /**
     * Checks the lanes together: each failure lane resolves and has none of its own.
     */
    validate: () => void;
};
/** @typedef {import('./types.js').LaneDefinition} LaneDefinition */
/** @typedef {import('./local_rates.js').RateState} RateState */
/**
 * A local concurrency limit in this instance: its handlers that run.
 * @typedef {object} LimitState
 * @property {import('./types.js').ConcurrencyLimit} limit
 * @property {number} running
 * @property {string[]} lanes Its added lanes.
 */
/**
 * @typedef {object} HandlerEntry
 * @property {string} name
 * @property {number} index Its position in the order of the lanes.add() calls: the order of the ties.
 * @property {LaneDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {number} weight Its fairShareWeight.
 * @property {number} running Its jobs that run in this instance.
 * @property {LimitState[]} limits Its local concurrency limits.
 * @property {RateState[]} rates Its local rate limits.
 * @property {number | null} timeoutMs Resolved: the definition, else the defaults.
 */
/**
 * @typedef {object} Registry
 * @property {(lane: LaneDefinition | string, handler: import('./types.js').Handler, options?: unknown) => void} add
 * @property {(lane: string) => HandlerEntry | undefined} getEntry
 * @property {() => HandlerEntry[]} entries In the order of the lanes.add() calls.
 * @property {(lane: string) => LaneDefinition | null} findDefinition In `lanes`, else added.
 * @property {() => string[]} lanesWithLimits The added lanes whose definition has global limits, of concurrency or
 *     of rate.
 * @property {() => string[]} lanesWithRateLimits The added lanes whose definition has global rate limits.
 * @property {() => void} validate Checks the lanes together: each failure lane resolves and has none of its own.
 */
/**
 * @param {object} params
 * @param {Map<string, LaneDefinition>} params.lanesByName
 * @param {number | null} params.defaultTimeoutMs
 * @returns {Registry}
 */
export declare function createRegistry({ lanesByName, defaultTimeoutMs }: {
    lanesByName: Map<string, LaneDefinition>;
    defaultTimeoutMs: number | null;
}): Registry;
