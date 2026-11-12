import { insertJobsMysql } from './mysql_enqueue.js';
export type Executor = import('../types.js').Executor;
export type ScheduleRow = import('./fire_slots.js').ScheduleRow;
/**
 * Reads rows of schedules, without a lock, and the database clock: also when no row matches.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[] | null} ids Null: every row.
 * @param {() => number} now The clock of the process.
 * @returns {Promise<{ clock: import('./fire_slots.js').ClockSample, rows: ScheduleRow[] }>} Sorted by id.
 */
export declare function readSchedules(executor: Executor, p: string, ids: string[] | null, now: () => number): Promise<{
    clock: import('./fire_slots.js').ClockSample;
    rows: ScheduleRow[];
}>;
/**
 * Inserts the missing rows of the schedules, with the database time as their cursor, then reads them all.
 * @param {Executor} executor
 * @param {string} p
 * @param {{ id: string, name: string, spec: string }[]} schedules
 * @param {() => number} now
 * @returns {Promise<{ clock: import('./fire_slots.js').ClockSample, rows: ScheduleRow[] }>}
 */
export declare function registerSchedules(executor: Executor, p: string, schedules: {
    id: string;
    name: string;
    spec: string;
}[], now: () => number): Promise<{
    clock: import('./fire_slots.js').ClockSample;
    rows: ScheduleRow[];
}>;
export type FireSlots = (executor: Executor, p: string, params: import('./fire_slots.js').FireParams) => Promise<import('./fire_slots.js').FireResult>;
/**
 * @typedef {(executor: Executor, p: string, params: import('./fire_slots.js').FireParams)
 *     => Promise<import('./fire_slots.js').FireResult>} FireSlots Call it in a queue transaction.
 */
/**
 * The fire of the slots, with the insert of the jobs of a dialect.
 * @param {typeof insertJobsMysql} insertJobs
 * @returns {FireSlots}
 */
export declare function fireSlotsWith(insertJobs: typeof insertJobsMysql): FireSlots;
/** @type {FireSlots} */
export declare const fireSlots: FireSlots;
