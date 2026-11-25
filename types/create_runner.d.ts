export type LaneDefinition = import('./types.js').LaneDefinition;
export type Runner = import('./sqlane.js').Runner;
export type Mount = import('./sqlane.js').Mount;
export type RunnerOptions = import('./types.js').RunnerOptions;
export type LaneRunStatus = import('./types.js').LaneRunStatus;
export type ScheduleRunStatus = import('./types.js').ScheduleRunStatus;
/**
 * Creates the runner of this process over a sqlane: it runs the handlers and fires the schedules that it mounts, in
 * `start()` (production) or `drain()` (tests). One runner per sqlane. Its events go to the `onEvent` of the sqlane.
 * @param {import('./types.js').Sqlane<any>} sqlane The sqlane, from `createSqlane()`: its database, hint and events.
 * @param {RunnerOptions} [options] `localMaxConcurrency` (default 10), `logger` (default: the sqlane's).
 * @returns {Runner}
 */
export declare function createRunner(sqlane: import('./types.js').Sqlane<any>, options?: RunnerOptions): Runner;
