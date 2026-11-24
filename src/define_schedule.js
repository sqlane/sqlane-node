import { ConfigError } from './errors.js';
import { isLaneDefinition } from './local_settings.js';
import { serializePayload } from './payload.js';
import { checkSchedule } from './schedule.js';
import { isPlainObject } from './validate.js';

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
export function defineSchedule(lane, options) {
    const name = isLaneDefinition(lane) ? lane.name : '';
    const where = `defineSchedule(${JSON.stringify(name)})`;

    if (!isLaneDefinition(lane)) {
        throw new ConfigError(`${where}: the lane must be a lane definition, from defineLane()`);
    }

    if (isPlainObject(options) && options.key === undefined) {
        throw new ConfigError(`${where}: "key" is required: it tells the schedules of a lane apart, in their id`);
    }

    const entry = checkSchedule(lane, options, 'defineSchedule');
    const given = /** @type {Record<string, unknown>} */ (options);
    let payloadJson;

    try {
        payloadJson = serializePayload(entry.payload, Infinity, where);
    } catch (error) {
        throw new ConfigError(/** @type {Error} */ (error).message, { cause: error });
    }

    return /** @type {any} */ (Object.freeze({
        id: entry.id,
        lane,
        key: entry.key,
        ...(given.cron !== undefined && { cron: given.cron }),
        ...(given.timezone !== undefined && { timezone: given.timezone }),
        ...(given.every !== undefined && { every: given.every }),
        payload: deepFreeze(JSON.parse(payloadJson)),
        missed: entry.missed,
        overlap: entry.overlap,
        ...(given.jitter !== undefined && { jitter: given.jitter }),
    }));
}

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').ScheduleDefinition} A schedule as `defineSchedule()` makes it: frozen, with
 *     an id, a key and a lane definition.
 */
export function isScheduleDefinition(value) {
    return isPlainObject(value) && Object.isFrozen(value) && typeof value.id === 'string'
        && typeof value.key === 'string' && isLaneDefinition(value.lane);
}

/**
 * A new entry of the scheduler for a schedule: each mount gets its own, with its slots in memory.
 * @param {import('./types.js').ScheduleDefinition} schedule
 * @returns {import('./schedule.js').ScheduleEntry}
 */
export function scheduleEntryOf(schedule) {
    const { id: _id, lane, ...options } = schedule;
    const entry = checkSchedule(lane, options, 'defineSchedule');

    entry.definition = lane;

    return entry;
}

/**
 * @template T
 * @param {T} value A JSON value.
 * @returns {T} The same value, frozen to its leaves.
 */
function deepFreeze(value) {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }

        Object.freeze(value);
    }

    return value;
}
