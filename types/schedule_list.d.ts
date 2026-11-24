export type ScheduleEntry = import('./schedule.js').ScheduleEntry;
/** @typedef {import('./schedule.js').ScheduleEntry} ScheduleEntry */
/**
 * The timing of a stored spec: `cron <fields> <time zone>` or `every <ms>`.
 * @param {string} spec
 * @returns {import('./schedule.js').Timing | null} Null: a spec that this version cannot read.
 */
export declare function timingOfSpec(spec: string): import('./schedule.js').Timing | null;
/**
 * @param {object} params
 * @param {import('./store/store.js').Store} params.store
 * @param {ReadonlyMap<string, ScheduleEntry>} params.local The schedules of the runner of this process: those
 *     without a row yet are listed too, and their jitter gives `nextRunAt`.
 * @returns {Promise<import('./types.js').ScheduleInfo[]>}
 */
export declare function listSchedules({ store, local }: {
    store: import('./store/store.js').Store;
    local: ReadonlyMap<string, ScheduleEntry>;
}): Promise<import('./types.js').ScheduleInfo[]>;
