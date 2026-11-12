export type Executor = import('../types.js').Executor;
export type ScheduleRow = import('./fire_slots.js').ScheduleRow;
/**
 * Inserts the jobs of slots of several names, in one statement, with one NOTIFY per name that got a job. The CTE of
 * `insertJobsPostgres` with another NOTIFY step: the enqueue statement stays as it is.
 * @param {Executor} executor
 * @param {string} p The table prefix.
 * @param {import('../new_job.js').NewJob[]} jobs Their ids are distinct.
 * @param {{ enqueueToken: string, notifyChannel: string | null }} options
 * @returns {Promise<Set<string>>} The ids that this call created.
 */
export declare function insertScheduledJobsPostgres(executor: Executor, p: string, jobs: import('../new_job.js').NewJob[], { enqueueToken, notifyChannel }: {
    enqueueToken: string;
    notifyChannel: string | null;
}): Promise<Set<string>>;
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
/**
 * @param {Executor} executor In a queue transaction.
 * @param {string} p
 * @param {import('./fire_slots.js').FireParams} params
 * @returns {Promise<import('./fire_slots.js').FireResult>}
 */
export declare function fireSlots(executor: Executor, p: string, params: import('./fire_slots.js').FireParams): Promise<import('./fire_slots.js').FireResult>;
