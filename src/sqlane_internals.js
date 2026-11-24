// The internals of a sqlane instance that its runner reaches: kept out of the instance, in a map of this module. A
// sqlane of another copy of the package is not in it.
import { ConfigError } from './errors.js';

/**
 * The runner attached to a sqlane, as the sqlane sees it: the wakes of its enqueues, its state, its close.
 * @typedef {object} AttachedRunner
 * @property {(lanes: string[]) => void} onEnqueued An enqueue in this process: its commit is to come.
 * @property {(lanes: string[]) => void} onCommitted An enqueue in this process committed.
 * @property {(lane: string) => boolean} canStartNow The lane is handled here, not paused, and has a free slot: no hint.
 * @property {(lanes: string[]) => void} wake Jobs of the lanes are due: an unblock.
 * @property {() => boolean} isBusy Started, starting, draining or closing: its queries run.
 * @property {(options?: import('./types.js').CloseOptions) => Promise<void>} close
 * @property {() => ReadonlyMap<string, import('./schedule.js').ScheduleEntry>} schedules Its schedules, by id.
 */

/**
 * @typedef {object} SqlaneInternals
 * @property {import('./types.js').Adapter<any>} adapter
 * @property {string} tablePrefix
 * @property {import('./store/store.js').Store} store
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {number} maxPayloadBytes
 * @property {number} pollIntervalMs
 * @property {boolean} cleanup
 * @property {Record<string, any>} testTimings Undocumented options, for the tests of sqlane.
 * @property {import('./types.js').Logger | undefined} logger
 * @property {((event: import('./types.js').SqlaneEvent) => void) | undefined} onEvent
 * @property {import('./hint_channel.js').HintChannel} hintChannel
 * @property {string | null} notifyChannel
 * @property {(lane: string, committed: boolean) => void} wakeFor Wakes this process, sends the hint to the others.
 * @property {(operation: string, error: unknown) => void} reportError An error of an optimization: a warning.
 * @property {(where: string) => Promise<void>} checkServerOnce
 * @property {() => boolean} isClosed
 * @property {(runner: AttachedRunner) => void} attach Throws a ConfigError when a runner is attached already.
 */

/** @type {WeakMap<object, SqlaneInternals>} */
const internalsByInstance = new WeakMap();

/**
 * @param {object} sqlane
 * @param {SqlaneInternals} internals
 */
export function setInternals(sqlane, internals) {
    internalsByInstance.set(sqlane, internals);
}

/**
 * @param {unknown} sqlane
 * @param {string} where For the error.
 * @returns {SqlaneInternals}
 */
export function internalsOf(sqlane, where) {
    const internals = typeof sqlane === 'object' && sqlane !== null ? internalsByInstance.get(sqlane) : undefined;

    if (!internals) {
        throw new ConfigError(`${where}: the sqlane must be an instance of createSqlane(), from this copy of `
            + '@sqlane/core (two copies of the package: one runs the runner, the other made the sqlane)');
    }

    return internals;
}
