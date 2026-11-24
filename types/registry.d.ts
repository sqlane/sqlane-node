export type LaneDefinition = import('./types.js').LaneDefinition;
export type RateState = import('./local_rates.js').RateState;
export type LimitState = {
    limit: import('./types.js').ConcurrencyLimit;
    running: number;
    /**
     * Its handled lanes.
     */
    lanes: string[];
};
export type HandlerEntry = {
    name: string;
    /**
     * Its position in the order of the adds, never reused: the order of the ties.
     */
    index: number;
    definition: LaneDefinition | null;
    handler: import('./types.js').Handler;
    /**
     * Its fairShareWeight.
     */
    weight: number;
    /**
     * The jobs of its lane that run in this process, by any handler of the lane.
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
export type EntrySpec = {
    name: string;
    definition: LaneDefinition | null;
    handler: import('./types.js').Handler;
    /**
     * The settings of the handler: none, or those of
     * the definition (until 10.0, a definition may hold them too; not both).
     */
    settings: Readonly<import('./types.js').HandlerOptions>;
    /**
     * For the errors.
     */
    where: string;
};
export type Registry = {
    /**
     *     The old `lanes.add()`.
     */
    add: (lane: LaneDefinition | string, handler: import('./types.js').Handler, options?: unknown) => void;
    /**
     * Throws a ConfigError for a spec that `addEntries` would refuse; adds
     * nothing.
     */
    check: (specs: EntrySpec[]) => void;
    /**
     * Checks the specs together, then adds them all.
     */
    addEntries: (specs: EntrySpec[]) => HandlerEntry[];
    /**
     * Removes the entries that are still the handlers of
     * their lane. Their jobs that run keep them.
     */
    remove: (entries: readonly HandlerEntry[]) => void;
    getEntry: (lane: string) => HandlerEntry | undefined;
    /**
     * In the order of the adds.
     */
    entries: () => HandlerEntry[];
    /**
     * The indexes given so far: the span of the tie order. Never shrinks.
     */
    span: () => number;
    /**
     * The jobs of the lane that run in this process.
     */
    runningOf: (lane: string) => number;
    /**
     * In `lanes`, else handled.
     */
    findDefinition: (lane: string) => LaneDefinition | null;
    /**
     * The handled lanes whose definition has global limits, of concurrency or
     * of rate.
     */
    lanesWithLimits: () => string[];
    /**
     * The handled lanes whose definition has global rate limits.
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
 * A local concurrency limit in this process: its handlers that run.
 * @typedef {object} LimitState
 * @property {import('./types.js').ConcurrencyLimit} limit
 * @property {number} running
 * @property {string[]} lanes Its handled lanes.
 */
/**
 * @typedef {object} HandlerEntry
 * @property {string} name
 * @property {number} index Its position in the order of the adds, never reused: the order of the ties.
 * @property {LaneDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {number} weight Its fairShareWeight.
 * @property {number} running The jobs of its lane that run in this process, by any handler of the lane.
 * @property {LimitState[]} limits Its local concurrency limits.
 * @property {RateState[]} rates Its local rate limits.
 * @property {number | null} timeoutMs Resolved: the definition, else the defaults.
 */
/**
 * A lane to add: its handler and its settings in this process.
 * @typedef {object} EntrySpec
 * @property {string} name
 * @property {LaneDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {Readonly<import('./types.js').HandlerOptions>} settings The settings of the handler: none, or those of
 *     the definition (until 10.0, a definition may hold them too; not both).
 * @property {string} where For the errors.
 */
/**
 * @typedef {object} Registry
 * @property {(lane: LaneDefinition | string, handler: import('./types.js').Handler, options?: unknown) => void} add
 *     The old `lanes.add()`.
 * @property {(specs: EntrySpec[]) => void} check Throws a ConfigError for a spec that `addEntries` would refuse; adds
 *     nothing.
 * @property {(specs: EntrySpec[]) => HandlerEntry[]} addEntries Checks the specs together, then adds them all.
 * @property {(entries: readonly HandlerEntry[]) => void} remove Removes the entries that are still the handlers of
 *     their lane. Their jobs that run keep them.
 * @property {(lane: string) => HandlerEntry | undefined} getEntry
 * @property {() => HandlerEntry[]} entries In the order of the adds.
 * @property {() => number} span The indexes given so far: the span of the tie order. Never shrinks.
 * @property {(lane: string) => number} runningOf The jobs of the lane that run in this process.
 * @property {(lane: string) => LaneDefinition | null} findDefinition In `lanes`, else handled.
 * @property {() => string[]} lanesWithLimits The handled lanes whose definition has global limits, of concurrency or
 *     of rate.
 * @property {() => string[]} lanesWithRateLimits The handled lanes whose definition has global rate limits.
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
