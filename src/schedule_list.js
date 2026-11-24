// `sqlane.schedules.list()`: the rows of the schedules, with their next slot by their stored spec. Pure but for the
// read: it needs no runner, and lists the database only.
import { parseCron } from './cron.js';
import { schemaErrorOf } from './global_pauses.js';
import { dueOf, nextSlot, pendingSlots } from './schedule.js';
import { isMissingTableError } from './transient_error.js';

/** @typedef {import('./schedule.js').ScheduleEntry} ScheduleEntry */

/**
 * The timing of a stored spec: `cron <fields> <time zone>` or `every <ms>`.
 * @param {string} spec
 * @returns {import('./schedule.js').Timing | null} Null: a spec that this version cannot read.
 */
export function timingOfSpec(spec) {
    const every = /^every (\d+)$/.exec(spec);

    if (every) {
        const ms = Number(every[1]);

        return ms > 0 ? { kind: 'every', ms } : null;
    }

    const cron = /^cron (.+) (\S+)$/.exec(spec);

    if (!cron) {
        return null;
    }

    try {
        return { kind: 'cron', cron: parseCron(cron[1]), timeZone: cron[2] };
    } catch {
        return null;
    }
}

/**
 * The next slot of a schedule, as a process that fires it tracks it: with its jitter, the first slot whose due time is
 * ahead.
 * @param {Pick<ScheduleEntry, 'id' | 'timing' | 'jitterMs' | 'dueCache'>} entry
 * @param {number} nowMs Database time.
 * @returns {{ nextAt: number, nextRunAt: number } | null}
 */
function nextOf(entry, nowMs) {
    const slotEntry = /** @type {ScheduleEntry} */ (entry);
    const nextAt = entry.jitterMs ? pendingSlots(slotEntry, nowMs).nextAt : nextSlot(slotEntry, nowMs);

    return nextAt === null ? null : { nextAt, nextRunAt: dueOf(slotEntry, nextAt) };
}

/**
 * @param {object} params
 * @param {import('./store/store.js').Store} params.store
 * @param {ReadonlyMap<string, ScheduleEntry>} params.local The schedules of the runner of this process: their jitter
 *     gives `nextRunAt`, for a row of their spec. The jitter is not stored: without it, `nextRunAt` is `nextAt`.
 * @returns {Promise<import('./types.js').ScheduleInfo[]>}
 */
export async function listSchedules({ store, local }) {
    /** @type {import('./store/fire_slots.js').ScheduleRow[]} */
    let rows = [];
    let nowMs = Date.now();

    try {
        const read = await store.readSchedules(null, Date.now);

        ({ rows } = read);
        nowMs = read.clock.dbNowMs;
    } catch (error) {
        // No table yet: no rows. The table without the pause of 0010: a ConfigError
        if (!isMissingTableError(error)) {
            throw schemaErrorOf('schedules.list()', error);
        }
    }

    return rows.toSorted((a, b) => (a.id < b.id ? -1 : 1)).map((row) => {
        const { id, spec } = row;
        const entry = local.get(id);
        // The jitter is not stored: known for a schedule of this process only, of the stored spec
        const same = entry !== undefined && entry.spec === spec;
        const pausedGlobally = (row.pausedAtMs ?? null) !== null;
        const timing = same ? entry.timing : timingOfSpec(spec);
        // Paused: no next slot until the resume
        const next = !pausedGlobally && timing
            && nextOf({ id, timing, jitterMs: same ? entry.jitterMs : 0, dueCache: null }, nowMs);

        return {
            id,
            lane: row.lane,
            spec,
            nextAt: next ? new Date(next.nextAt) : null,
            nextRunAt: next ? new Date(next.nextRunAt) : null,
            lastSlotAt: new Date(row.lastSlotMs),
            lastJobId: row.lastJobId,
            pausedGlobally,
        };
    });
}
