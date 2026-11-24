/**
 * Defines a schedule: a cron or an interval that adds a job of the lane at each slot. A runner fires it while it is
 * mounted (`runner.mount([schedule])`); `sqlane.schedules.runSlot(schedule)` runs a slot by hand. It holds no handler
 * code: define it next to its lane.
 * @template {import('./types.js').LaneDefinition} J
 * @template P
 * @param {J} lane The lane definition, from `defineLane()`.
 * @param {import('./types.js').ScheduleSettings & import('./types.js').ScheduleTiming
 *     & import('./types.js').SchedulePayload<J, P>} options `key` (required), `cron` with an optional `timezone`, or
 *     `every`; `payload`, `missed`, `overlap` and `jitter`.
 * @returns {import('./types.js').ScheduleDefinition<import('./types.js').HandlerPayload<J>>} Frozen. Its id is
 *     `<lane>:<key>`.
 */
export declare function defineSchedule<J extends import('./types.js').LaneDefinition, P>(lane: J, options: import('./types.js').ScheduleSettings & import('./types.js').ScheduleTiming & import('./types.js').SchedulePayload<J, P>): import('./types.js').ScheduleDefinition<import('./types.js').HandlerPayload<J>>;
/**
 * @param {unknown} value
 * @returns {value is import('./types.js').ScheduleDefinition} A schedule as `defineSchedule()` makes it: frozen, with
 *     an id, a key and a lane definition.
 */
export declare function isScheduleDefinition(value: unknown): value is import('./types.js').ScheduleDefinition;
/**
 * A new entry of the scheduler for a schedule: each mount gets its own, with its slots in memory.
 * @param {import('./types.js').ScheduleDefinition} schedule
 * @returns {import('./schedule.js').ScheduleEntry}
 */
export declare function scheduleEntryOf(schedule: import('./types.js').ScheduleDefinition): import('./schedule.js').ScheduleEntry;
