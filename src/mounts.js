// The mounts of a runner: the handlers and the schedules that this process runs, added and removed at runtime. A
// mount is checked whole, then added whole; its unmount removes it whole. A claim or a fire in flight completes with
// the parts it began with, and the jobs that run keep their handler.
import { isLaneHandler } from './define_handler.js';
import { isScheduleDefinition, scheduleEntryOf } from './define_schedule.js';
import { ConfigError } from './errors.js';

/** @typedef {import('./types.js').LaneDefinition} LaneDefinition */
/** @typedef {import('./registry.js').HandlerEntry} HandlerEntry */
/** @typedef {import('./schedule.js').ScheduleEntry} ScheduleEntry */
/**
 * The runner of the mounts: told of the lanes that it handles from now on, and of those that it no longer handles.
 * @typedef {{ added: (entries: readonly HandlerEntry[]) => void, removed: (entries: readonly HandlerEntry[]) => void }}
 *     MountTarget
 */

/**
 * @typedef {object} MountHandle
 * @property {() => void} unmount Sync, idempotent.
 * @property {readonly HandlerEntry[]} entries Its handlers.
 * @property {readonly ScheduleEntry[]} schedules Its schedules.
 */

/**
 * @typedef {object} Mounts
 * @property {(parts: unknown, where?: string) => MountHandle} mount
 * @property {(definitions: readonly LaneDefinition[], where: string) => void} checkDefinitions Throws a ConfigError
 *     when a definition has the name of another one that this process knows.
 * @property {(id: string) => boolean} hasSchedule A mounted schedule.
 */

/**
 * @param {object} params
 * @param {import('./registry.js').Registry} params.registry
 * @param {import('./scheduler.js').Scheduler} params.scheduler
 * @param {MountTarget} params.runner
 * @param {ReadonlyMap<string, LaneDefinition>} [params.known] Definitions known for the life of the process: the old
 *     `lanes` option.
 * @returns {Mounts}
 */
export function createMounts({ registry, scheduler, runner, known = new Map() }) {
    /** @type {Map<string, { definition: LaneDefinition, count: number }>} The definitions of the mounts, by name */
    const definitions = new Map();
    /** @type {Set<string>} The ids of the mounted schedules */
    const scheduleIds = new Set();

    /**
     * @param {string} name
     * @returns {LaneDefinition | null} The definition that this process knows by the name.
     */
    function knownDefinition(name) {
        return definitions.get(name)?.definition ?? known.get(name) ?? registry.getEntry(name)?.definition ?? null;
    }

    /** @type {Mounts['checkDefinitions']} */
    function checkDefinitions(given, where) {
        /** @type {Map<string, LaneDefinition>} */
        const seen = new Map();

        for (const definition of given) {
            const other = seen.get(definition.name) ?? knownDefinition(definition.name);

            if (other && other !== definition) {
                throw new ConfigError(`${where}: two different definitions of the lane "${definition.name}"`);
            }

            seen.set(definition.name, definition);
        }
    }

    /**
     * @param {readonly LaneDefinition[]} given
     * @param {1 | -1} step
     */
    function count(given, step) {
        for (const definition of given) {
            const held = definitions.get(definition.name) ?? { definition, count: 0 };

            held.count += step;

            if (held.count > 0) {
                definitions.set(definition.name, held);
            } else {
                definitions.delete(definition.name);
            }
        }
    }

    /** @type {Mounts['mount']} */
    function mount(parts, where = 'mount()') {
        if (!Array.isArray(parts)) {
            throw new ConfigError(`${where}: the parts must be an array of handlers and schedules`);
        }

        /** @type {import('./types.js').LaneHandler[]} */
        const handlers = [];
        /** @type {import('./types.js').ScheduleDefinition[]} */
        const schedules = [];

        for (const part of parts) {
            if (isLaneHandler(part)) {
                handlers.push(part);
            } else if (isScheduleDefinition(part)) {
                schedules.push(part);
            } else {
                throw new ConfigError(
                    `${where}: a part must be a handler from defineHandler() or a schedule from defineSchedule()`,
                );
            }
        }

        /** @type {Set<string>} */
        const ids = new Set();

        for (const { id } of schedules) {
            if (scheduler.has(id) || ids.has(id)) {
                throw new ConfigError(`${where}: the schedule "${id}" is mounted here already`);
            }

            ids.add(id);
        }

        /** @type {LaneDefinition[]} */
        const used = [];

        for (const { lane } of [...handlers, ...schedules]) {
            used.push(lane);

            const { failureLane } = lane;

            if (typeof failureLane === 'object') {
                if (failureLane.failureLane !== undefined) {
                    throw new ConfigError(
                        `${where}: the failure lane "${failureLane.name}" of "${lane.name}" has a failure lane of its own`,
                    );
                }

                used.push(failureLane);
            }
        }

        checkDefinitions(used, where);

        /** @type {import('./registry.js').EntrySpec[]} */
        const specs = handlers.map(({ lane, handler, ...settings }) => {
            const own = settings.fairShareWeight !== undefined || settings.localConcurrencyLimits !== undefined
                || settings.localRateLimits !== undefined;

            return {
                name: lane.name,
                definition: lane,
                handler,
                // Until 10.0, a definition may hold the local settings: they apply when the handler has none
                settings: own ? settings : lane,
                where: `${where}: the handler of "${lane.name}"`,
            };
        });

        registry.check(specs);

        const scheduleEntries = schedules.map((schedule) => {
            const entry = scheduleEntryOf(schedule);

            scheduler.check(entry, `${where}: the schedule "${entry.id}"`);

            return entry;
        });

        // Checked: added whole
        count(used, 1);

        const entries = registry.addEntries(specs);

        runner.added(entries);

        for (const entry of scheduleEntries) {
            scheduleIds.add(entry.id);
            scheduler.add(entry);
        }

        let mounted = true;

        return {
            entries,
            schedules: scheduleEntries,
            unmount: () => {
                if (!mounted) {
                    return;
                }

                mounted = false;
                registry.remove(entries);
                runner.removed(entries);

                for (const entry of scheduleEntries) {
                    scheduleIds.delete(entry.id);
                    scheduler.remove(entry);
                }

                count(used, -1);
            },
        };
    }

    return { mount, checkDefinitions, hasSchedule: id => scheduleIds.has(id) };
}
