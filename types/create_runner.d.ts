import { createRunner as createWorker } from './runner.js';
export type Runner = import('./sqlane.js').Runner;
export type Mount = import('./sqlane.js').Mount;
export type RunnerOptions = import('./types.js').RunnerOptions;
export type LaneRunStatus = import('./types.js').LaneRunStatus;
export type ScheduleRunStatus = import('./types.js').ScheduleRunStatus;
export type LegacyRunner = {
    /**
     * `lanes.add()`.
     */
    add: (lane: import('./types.js').LaneDefinition | string, handler: import('./types.js').Handler, options?: unknown) => void;
    schedule: (lane: import('./types.js').LaneDefinition | string, options: unknown) => void;
    start: () => Promise<void>;
    drain: (options?: import('./types.js').DrainOptions) => Promise<import('./types.js').DrainResult>;
    wake: () => void;
};
export type BuiltRunner = {
    attached: import('./sqlane_internals.js').AttachedRunner;
    mounts: import('./mounts.js').Mounts;
    worker: ReturnType<typeof createWorker>;
    registry: import('./registry.js').Registry;
    scheduler: import('./scheduler.js').Scheduler;
    start: () => Promise<void>;
    close: (options?: import('./types.js').CloseOptions) => Promise<void>;
    /**
     * A start() runs: its check of the server, its registration.
     */
    isStarting: () => boolean;
};
/**
 * The worker methods of the 9.x API, over the runner of a sqlane. Until 10.0.
 * @typedef {object} LegacyRunner
 * @property {(lane: import('./types.js').LaneDefinition | string, handler: import('./types.js').Handler,
 *     options?: unknown) => void} add `lanes.add()`.
 * @property {(lane: import('./types.js').LaneDefinition | string, options: unknown) => void} schedule
 * @property {() => Promise<void>} start
 * @property {(options?: import('./types.js').DrainOptions) => Promise<import('./types.js').DrainResult>} drain
 * @property {() => void} wake
 */
/**
 * @typedef {object} BuiltRunner
 * @property {import('./sqlane_internals.js').AttachedRunner} attached
 * @property {import('./mounts.js').Mounts} mounts
 * @property {ReturnType<typeof createWorker>} worker
 * @property {import('./registry.js').Registry} registry
 * @property {import('./scheduler.js').Scheduler} scheduler
 * @property {() => Promise<void>} start
 * @property {(options?: import('./types.js').CloseOptions) => Promise<void>} close
 * @property {() => boolean} isStarting A start() runs: its check of the server, its registration.
 */
/**
 * Builds the runner of a sqlane, and attaches it.
 * @param {import('./sqlane_internals.js').SqlaneInternals} core
 * @param {{ localMaxConcurrency: number, logger?: import('./types.js').Logger }} options
 * @returns {BuiltRunner}
 */
export declare function buildRunner(core: import('./sqlane_internals.js').SqlaneInternals, { localMaxConcurrency, logger }: {
    localMaxConcurrency: number;
    logger?: import('./types.js').Logger;
}): BuiltRunner;
/**
 * Creates the runner of this process over a sqlane: it runs the handlers and fires the schedules that it mounts, in
 * `start()` (production) or `drain()` (tests). One runner per sqlane. Its events go to the `onEvent` of the sqlane.
 * @param {import('./types.js').Sqlane<any>} sqlane The sqlane, from `createSqlane()`: its database, hint and events.
 * @param {RunnerOptions} [options] `localMaxConcurrency` (default 10), `logger` (default: the sqlane's).
 * @returns {Runner}
 */
export declare function createRunner(sqlane: import('./types.js').Sqlane<any>, options?: RunnerOptions): Runner;
