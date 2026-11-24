export type Executor = import('../types.js').Executor;
/** @typedef {import('../types.js').Executor} Executor */
/**
 * The filter of the claims: the lane is not paused. A subquery, never a join: it reads the primary key of
 * `<p>paused_lanes`, at most one row; a lane given as a parameter makes it uncorrelated (run once per statement).
 * @param {string} p
 * @param {string} lane The SQL of the lane: a column, qualified, or a parameter.
 * @returns {string}
 */
export declare const notPaused: (p: string, lane: string) => string;
/** Above it, the paused lanes of a probe are checked with the subquery, not as parameters */
export declare const MAX_PAUSED_PARAMS = 50;
/**
 * MySQL and MariaDB: the filter of the paused lanes in a read of the blocked jobs (the head of a key, the jobs that an
 * unblock takes), by the paused lanes that the last probe of the process saw. No pause seen: no filter, so no subquery
 * to plan in the statement. None seen yet (no probe: a process without a runner): the subquery of `notPaused`. A pause
 * after the probe holds until the next probe: a blocked job of its lane can head a key for one turn.
 * @param {string} p
 * @param {string} lane The column of the lane, qualified.
 * @param {readonly string[] | null | undefined} paused The paused lanes of the last probe; null: no probe yet.
 * @returns {{ sql: string, params: string[] }} ` AND …`, or nothing; and its parameters.
 */
export declare function pausedFilter(p: string, lane: string, paused: readonly string[] | null | undefined): {
    sql: string;
    params: string[];
};
export type PauseSql = {
    /**
     * Keeps the time of the first pause.
     */
    pauseLane: (p: string) => string;
    resumeLane: (p: string) => string;
    readPausedLanes: (p: string) => string;
    blockedKeysOfLane: (p: string) => string;
    /**
     * No row: a paused one, with its cursor at the pause. A row: paused,
     * once; its cursor and spec kept.
     */
    pauseSchedule: (p: string) => string;
    /**
     * A paused row only: its cursor moves to now (no catch-up), unless
     * it is ahead.
     */
    resumeSchedule: (p: string) => string;
    removeSchedule: (p: string) => string;
};
export type PauseStore = {
    pauseLane: (lane: string, connection?: unknown) => Promise<void>;
    /**
     * True: the lane was paused.
     */
    resumeLane: (lane: string, connection?: unknown) => Promise<boolean>;
    /**
     * The paused lanes, in no order.
     */
    readPausedLanes: () => Promise<string[]>;
    /**
     * The keys of its blocked jobs, once each: they
     * scan the blocked jobs.
     */
    blockedKeysOfLane: (lane: string) => Promise<string[]>;
    pauseSchedule: (schedule: {
        id: string;
        lane: string;
        spec: string;
    }, connection?: unknown) => Promise<void>;
    /**
     * True: the row was paused.
     */
    resumeSchedule: (id: string, connection?: unknown) => Promise<boolean>;
    /**
     * True: the row was there.
     */
    removeSchedule: (id: string, connection?: unknown) => Promise<boolean>;
};
/**
 * @typedef {object} PauseStore
 * @property {(lane: string, connection?: unknown) => Promise<void>} pauseLane
 * @property {(lane: string, connection?: unknown) => Promise<boolean>} resumeLane True: the lane was paused.
 * @property {() => Promise<string[]>} readPausedLanes The paused lanes, in no order.
 * @property {(lane: string) => Promise<string[]>} blockedKeysOfLane The keys of its blocked jobs, once each: they
 *     scan the blocked jobs.
 * @property {(schedule: { id: string, lane: string, spec: string }, connection?: unknown) => Promise<void>}
 *     pauseSchedule
 * @property {(id: string, connection?: unknown) => Promise<boolean>} resumeSchedule True: the row was paused.
 * @property {(id: string, connection?: unknown) => Promise<boolean>} removeSchedule True: the row was there.
 */
/**
 * @param {import('../types.js').Adapter<any>} adapter
 * @param {string} p
 * @returns {PauseStore}
 */
export declare function createPauseStore(adapter: import('../types.js').Adapter<any>, p: string): PauseStore;
