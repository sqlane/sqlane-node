// `sqlane.schedules.runSlot()`: a slot of a schedule, enqueued by hand as the scheduler would enqueue it. No runner:
// it reads and moves no cursor.
import { isScheduleDefinition, scheduleEntryOf } from './define_schedule.js';
import { InvalidOptionsError } from './errors.js';
import { buildNewJob } from './new_job.js';
import { isSlotTime, latestSlot } from './schedule.js';
import { checkObject } from './validate.js';

const WHERE = 'schedules.runSlot()';

/**
 * @template C
 * @param {object} params
 * @param {import('./enqueue.js').Enqueuer<C>} params.enqueuer
 * @param {import('./defaults.js').ResolvedDefaults} params.defaults
 * @param {number} params.maxPayloadBytes
 * @param {(connection: C | undefined, lane: string) => void} params.onCreated The wakes of a created job.
 * @returns {(schedule: import('./types.js').ScheduleDefinition, options?: import('./types.js').RunSlotOptions<C>)
 *     => Promise<import('./types.js').EnqueueResult>}
 */
export function createRunSlot({ enqueuer, defaults, maxPayloadBytes, onCreated }) {
    return async (schedule, options = {}) => {
        if (!isScheduleDefinition(schedule)) {
            throw new InvalidOptionsError(`${WHERE}: the schedule must be a schedule definition, from defineSchedule()`);
        }

        const { at, connection } = checkObject(options, ['at', 'connection'], 'options', {
            where: WHERE,
            ErrorClass: InvalidOptionsError,
        });
        const entry = scheduleEntryOf(schedule);
        const nowMs = Date.now();
        let slotMs;

        if (at === undefined) {
            slotMs = latestSlot(entry, nowMs);

            if (slotMs === null) {
                throw new InvalidOptionsError(`${WHERE}: the schedule "${entry.id}" has no slot before now`);
            }
        } else {
            if (!(at instanceof Date) || !isSlotTime(at.getTime())) {
                throw new InvalidOptionsError(`${WHERE}: "at" must be a valid Date in the years 1970 to 9999`);
            }

            slotMs = at.getTime();

            if (slotMs > nowMs) {
                throw new InvalidOptionsError(`${WHERE}: the slot ${at.toISOString()} is in the future`);
            }

            if (latestSlot(entry, slotMs) !== slotMs) {
                throw new InvalidOptionsError(
                    `${WHERE}: ${at.toISOString()} is not a slot of the schedule "${entry.id}" (${entry.spec})`,
                );
            }
        }

        // Due now: no jitter, no overlap check, no cursor
        const newJob = buildNewJob({
            lane: entry.lane,
            definition: schedule.lane,
            defaults,
            payload: entry.payload,
            options: undefined,
            maxPayloadBytes,
            slot: { at: slotMs, key: entry.key },
        });
        const result = await enqueuer.insertOne(/** @type {any} */ (connection), newJob);

        if (result.created) {
            onCreated(/** @type {any} */ (connection), entry.lane);
        }

        return result;
    };
}
