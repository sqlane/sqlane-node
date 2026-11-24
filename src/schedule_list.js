// `sqlane.schedules.list()`: the rows of the schedules, with their next slot by their stored spec. Pure but for the
// read: it needs no runner.
import { parseCron } from './cron.js';
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
 * @param {ReadonlyMap<string, ScheduleEntry>} params.local The schedules of the runner of this process: those
 *     without a row yet are listed too, and their jitter gives `nextRunAt`.
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
        // No table yet: no rows
        if (!isMissingTableError(error)) {
            throw error;
        }
    }

    const rowsById = new Map(rows.map(row => [row.id, row]));
    const ids = [...new Set([...rowsById.keys(), ...local.keys()])].toSorted();

    return ids.map((id) => {
        const row = rowsById.get(id);
        const entry = local.get(id);
        const spec = row?.spec ?? /** @type {ScheduleEntry} */ (entry).spec;
        // The jitter is not stored: known for a schedule of this process only, of the stored spec
        const same = entry !== undefined && entry.spec === spec;
        const timing = same ? entry.timing : timingOfSpec(spec);
        const next = timing && nextOf({ id, timing, jitterMs: same ? entry.jitterMs : 0, dueCache: null }, nowMs);

        return {
            id,
            lane: row?.lane ?? /** @type {ScheduleEntry} */ (entry).lane,
            spec,
            registered: Boolean(entry),
            nextAt: next ? new Date(next.nextAt) : null,
            nextRunAt: next ? new Date(next.nextRunAt) : null,
            lastSlotAt: row ? new Date(row.lastSlotMs) : null,
            lastJobId: row?.lastJobId ?? null,
        };
    });
}
