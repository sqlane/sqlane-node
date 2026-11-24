// `sqlane.lanes.pauseGlobally()` / `resumeGlobally()`, `lanes.stats()`, and `sqlane.schedules.pauseGlobally()` /
// `resumeGlobally()` / `remove()`: the pauses of every process, stored in the database. A runner reads them in its
// claims (store/pauses.js) and its scheduler in the rows of the schedules. No runner needed. See docs/design.md ›
// Global pauses.
import { isScheduleDefinition, scheduleEntryOf } from './define_schedule.js';
import { ConfigError, InvalidOptionsError } from './errors.js';
import { isRateKey } from './rate_keys.js';
import { isSlotKey } from './schedule.js';
import { isMissingColumnError, isMissingTableError } from './transient_error.js';
import { checkedLaneName } from './lane_names.js';
import { checkObject, NAME_REGEXP } from './validate.js';

/**
 * The spec of a row that a pause created from an id: no timing reads it (`timingOfSpec`), so `schedules.list()` gives
 * no next slot; the first fire of the schedule writes its own spec.
 */
export const PLACEHOLDER_SPEC = 'unknown';

/**
 * A resume in the caller's transaction, whose commit the adapter cannot tell: the unblocks of its blocked jobs run
 * again at these times, when the commit can have happened
 */
const RESUME_RECHECKS_MS = [1000, 5000];

/**
 * @param {string} where
 * @param {unknown} error
 * @returns {unknown} A missing table or column (a migration not run, such as 0010_pause): a `ConfigError`. Another
 *     error: as it is.
 */
export function schemaErrorOf(where, error) {
    return isMissingTableError(error) || isMissingColumnError(error)
        ? new ConfigError(`${where}: the schema is not migrated: run schema.migrate()`, { cause: error })
        : error;
}

/**
 * @template T
 * @param {string} where
 * @param {() => Promise<T>} func
 * @returns {Promise<T>} A missing table or column: a `ConfigError` (schemaErrorOf).
 */
async function withSchemaError(where, func) {
    try {
        return await func();
    } catch (error) {
        throw schemaErrorOf(where, error);
    }
}

/**
 * @param {unknown} options
 * @param {string} where
 * @returns {unknown} The connection, if given.
 */
function connectionOf(options, where) {
    const { connection } = checkObject(options ?? {}, ['connection'], 'options', {
        where,
        ErrorClass: InvalidOptionsError,
    });

    return connection;
}

/**
 * A schedule given to a pause, a resume or a remove: a definition, or an id.
 * @param {unknown} schedule
 * @param {string} where
 * @param {{ keyless?: boolean }} [options] `keyless`: an id without a key, as the schedules of 9.x had.
 * @returns {{ id: string, lane: string, spec: string }} The spec of the definition; of an id, the placeholder.
 */
export function scheduleOf(schedule, where, { keyless = false } = {}) {
    if (isScheduleDefinition(schedule)) {
        const entry = scheduleEntryOf(schedule);

        return { id: entry.id, lane: entry.lane, spec: entry.spec };
    }

    if (typeof schedule === 'string') {
        const colon = schedule.indexOf(':');
        const lane = colon === -1 ? schedule : schedule.slice(0, colon);

        if (NAME_REGEXP.test(lane) && (colon === -1 ? keyless : isSlotKey(schedule.slice(colon + 1)))) {
            return { id: schedule, lane, spec: PLACEHOLDER_SPEC };
        }
    }

    throw new InvalidOptionsError(`${where}: the schedule must be a schedule definition, from defineSchedule(), or `
        + `an id \`<lane>:<key>\`${keyless ? ' (or `<lane>`, a schedule of 9.x)' : ''}`);
}

/**
 * @typedef {object} GlobalPausesParams
 * @property {import('./store/store.js').Store} store
 * @property {import('./types.js').Adapter<any>} adapter
 * @property {() => import('./sqlane_internals.js').AttachedRunner | null} attached The runner of this process.
 * @property {import('./hint_channel.js').HintChannel} hintChannel
 * @property {(keys: string[]) => Promise<void>} unblockKeys Never rejects.
 * @property {(operation: string, error: unknown) => void} reportError
 * @property {() => boolean} isClosed The sqlane is closed: no unblock after it.
 */

/**
 * @param {GlobalPausesParams} params
 * @returns {{
 *     lanes: Pick<import('./sqlane.js').SqlaneLanes, 'pauseGlobally' | 'resumeGlobally' | 'stats'>,
 *     schedules: Pick<import('./sqlane.js').SqlaneSchedules, 'pauseGlobally' | 'resumeGlobally' | 'remove'>,
 * }}
 */
export function createGlobalPauses({ store, adapter, attached, hintChannel, unblockKeys, reportError, isClosed }) {
    /**
     * The blocked jobs of a resumed lane, whose keys may have room or quota now (a pause took no room and no quota).
     * @param {string} lane
     * @returns {Promise<void>} Never rejects: an error is reported.
     */
    async function unblockLane(lane) {
        // The paused lanes of the last probe of this process list it still: the reads check in SQL until the next probe
        // (the delete of its pause may not have committed yet)
        store.forgetPausedLanes();

        try {
            const keys = await store.blockedKeysOfLane(lane);
            const slotKeys = keys.filter(key => !isRateKey(key));
            const rateKeys = keys.filter(isRateKey);
            const runner = attached();

            if (slotKeys.length) {
                await unblockKeys(slotKeys);
            }

            if (rateKeys.length && runner?.isBusy()) {
                // Its timer: the unblock now, then the next ones while blocked jobs are left
                for (const key of rateKeys) {
                    runner.armRateWake(key, 0);
                }
            } else if (rateKeys.length) {
                // No runner that runs here: one unblock; the jobs left wait for the sweep of a runner
                await store.unblockRates(rateKeys);
            }
        } catch (error) {
            reportError('resume', error);
        }
    }

    /**
     * After a resume: its blocked jobs, then this process and the others claim the lane.
     * @param {string} lane
     * @param {boolean} committed False: the caller's commit is to come, and the adapter cannot tell when.
     * @returns {Promise<void>} Never rejects.
     */
    async function afterResume(lane, committed) {
        await unblockLane(lane);

        if (committed) {
            attached()?.wake([lane]);
        } else {
            // As an enqueue in a transaction: re-probes until the lane shows, and the unblocks once more, after the
            // commit can have happened
            attached()?.onEnqueued([lane]);
            for (const delayMs of RESUME_RECHECKS_MS) {
                setTimeout(() => {
                    if (!isClosed()) {
                        void unblockLane(lane);
                    }
                }, delayMs).unref();
            }
        }

        // Unconditional: this process may start the lane, the others too
        hintChannel.publish(lane);
    }

    /**
     * Runs the work of a resume after the commit of the connection when the adapter knows it, else at once.
     * @param {unknown} connection
     * @param {string} lane
     * @returns {Promise<void>} At once: when the work ends.
     */
    async function resumeAfterCommit(connection, lane) {
        let hooked = false;

        if (connection !== undefined) {
            try {
                hooked = adapter.afterCommit?.(/** @type {any} */ (connection), () => {
                    void afterResume(lane, true);
                }) ?? false;
            } catch (error) {
                reportError('after_commit', error);
            }
        }

        if (!hooked) {
            await afterResume(lane, connection === undefined);
        }
    }

    return {
        lanes: {
            pauseGlobally: async (lane, options) => {
                const where = 'lanes.pauseGlobally()';
                const name = checkedLaneName(lane, where);
                const connection = connectionOf(options, where);

                await withSchemaError(where, () => store.pauseLane(name, connection));
            },
            resumeGlobally: async (lane, options) => {
                const where = 'lanes.resumeGlobally()';
                const name = checkedLaneName(lane, where);
                const connection = connectionOf(options, where);

                // Not paused: nothing to unblock nor to wake
                if (await withSchemaError(where, () => store.resumeLane(name, connection))) {
                    await resumeAfterCommit(connection, name);
                }
            },
            stats: () => withSchemaError('lanes.stats()', async () => {
                const [stats, paused] = await Promise.all([store.getStats(), store.readPausedLanes()]);
                const pausedNames = new Set(paused);
                const listed = new Set(stats.map(row => row.name));
                const withPause = stats.map(row => Object.assign(row, { pausedGlobally: pausedNames.has(row.name) }));
                const withoutJobs = paused.filter(lane => !listed.has(lane)).map(lane => ({
                    name: lane,
                    pending: 0,
                    blocked: 0,
                    due: 0,
                    running: 0,
                    stuck: 0,
                    failed: 0,
                    completed: 0,
                    oldestDueAgeMs: null,
                    pausedGlobally: true,
                }));

                return [...withPause, ...withoutJobs].toSorted((a, b) => (a.name < b.name ? -1 : 1));
            }),
        },
        schedules: {
            pauseGlobally: async (schedule, options) => {
                const where = 'schedules.pauseGlobally()';
                const row = scheduleOf(schedule, where);
                const connection = connectionOf(options, where);

                await withSchemaError(where, () => store.pauseSchedule(row, connection));
            },
            resumeGlobally: async (schedule, options) => {
                const where = 'schedules.resumeGlobally()';
                const { id } = scheduleOf(schedule, where);
                const connection = connectionOf(options, where);

                await withSchemaError(where, () => store.resumeSchedule(id, connection));
            },
            remove: async (schedule, options) => {
                const where = 'schedules.remove()';
                const { id } = scheduleOf(schedule, where, { keyless: true });
                const connection = connectionOf(options, where);

                return { removed: await withSchemaError(where, () => store.removeSchedule(id, connection)) };
            },
        },
    };
}
