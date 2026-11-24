// The lanes handled in a process, their handlers, weights, local concurrency and rate limits, and the known
// definitions. Lanes come and go at runtime (mounts): the running count of a lane and the state of a local limit
// belong to their name, so the jobs that still run after an unmount count toward the handler mounted next.
import { parseDuration } from './duration.js';
import { ConfigError } from './errors.js';
import { hasLocalSettings } from './local_settings.js';
import { createRateState } from './local_rates.js';
import { isPlainObject, NAME_REGEXP } from './validate.js';

/** @typedef {import('./types.js').LaneDefinition} LaneDefinition */
/** @typedef {import('./local_rates.js').RateState} RateState */

/**
 * A local concurrency limit in this process: its handlers that run.
 * @typedef {object} LimitState
 * @property {import('./types.js').ConcurrencyLimit} limit
 * @property {number} running
 * @property {string[]} lanes Its handled lanes.
 */

/**
 * @typedef {object} HandlerEntry
 * @property {string} name
 * @property {number} index Its position in the order of the adds, never reused: the order of the ties.
 * @property {LaneDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {number} weight Its fairShareWeight.
 * @property {number} running The jobs of its lane that run in this process, by any handler of the lane.
 * @property {LimitState[]} limits Its local concurrency limits.
 * @property {RateState[]} rates Its local rate limits.
 * @property {number | null} timeoutMs Resolved: the definition, else the defaults.
 */

/**
 * A lane to add: its handler and its settings in this process.
 * @typedef {object} EntrySpec
 * @property {string} name
 * @property {LaneDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {Readonly<import('./types.js').HandlerOptions>} settings The settings of the handler: none, or those of
 *     the definition (until 10.0, a definition may hold them too; not both).
 * @property {string} where For the errors.
 */

/**
 * @typedef {object} Registry
 * @property {(lane: LaneDefinition | string, handler: import('./types.js').Handler, options?: unknown) => void} add
 *     The old `lanes.add()`.
 * @property {(specs: EntrySpec[]) => void} check Throws a ConfigError for a spec that `addEntries` would refuse; adds
 *     nothing.
 * @property {(specs: EntrySpec[]) => HandlerEntry[]} addEntries Checks the specs together, then adds them all.
 * @property {(entries: readonly HandlerEntry[]) => void} remove Removes the entries that are still the handlers of
 *     their lane. Their jobs that run keep them.
 * @property {(lane: string) => HandlerEntry | undefined} getEntry
 * @property {() => HandlerEntry[]} entries In the order of the adds.
 * @property {() => number} span The indexes given so far: the span of the tie order. Never shrinks.
 * @property {(lane: string) => number} runningOf The jobs of the lane that run in this process.
 * @property {(lane: string) => LaneDefinition | null} findDefinition In `lanes`, else handled.
 * @property {() => string[]} lanesWithLimits The handled lanes whose definition has global limits, of concurrency or
 *     of rate.
 * @property {() => string[]} lanesWithRateLimits The handled lanes whose definition has global rate limits.
 * @property {() => void} validate Checks the lanes together: each failure lane resolves and has none of its own.
 */

/**
 * @param {object} params
 * @param {Map<string, LaneDefinition>} params.lanesByName
 * @param {number | null} params.defaultTimeoutMs
 * @returns {Registry}
 */
export function createRegistry({ lanesByName, defaultTimeoutMs }) {
    /** @type {Map<string, HandlerEntry>} */
    const entriesByName = new Map();
    /** @type {Map<string, LimitState>} One per limit name, for the life of the process: one max */
    const limitStates = new Map();
    /** @type {Map<string, RateState>} One per rate limit name, for the life of the process: one setting */
    const rateStates = new Map();
    /** @type {Map<string, { running: number }>} The running jobs of each lane name, by any of its handlers */
    const laneCounts = new Map();
    let nextIndex = 0;

    /** @type {Registry['findDefinition']} */
    function findDefinition(name) {
        return lanesByName.get(name) ?? entriesByName.get(name)?.definition ?? null;
    }

    /**
     * @param {string} name
     * @returns {{ running: number }}
     */
    function countOf(name) {
        let count = laneCounts.get(name);

        if (!count) {
            count = { running: 0 };
            laneCounts.set(name, count);
        }

        return count;
    }

    /**
     * The local limits of the specs, against those of this process and those of the specs before them.
     * @param {EntrySpec[]} specs
     */
    function checkLimits(specs) {
        /** @type {Map<string, import('./types.js').ConcurrencyLimit>} */
        const maxes = new Map([...limitStates].map(([name, state]) => [name, state.limit]));
        /** @type {Map<string, import('./types.js').RateLimit>} */
        const rates = new Map([...rateStates].map(([name, state]) => [name, state.limit]));

        for (const { settings, where } of specs) {
            for (const limit of settings.localConcurrencyLimits ?? []) {
                const known = maxes.get(limit.name);

                if (known && known.max !== limit.max) {
                    throw new ConfigError(`${where}: the concurrency limit ${JSON.stringify(limit.name)} has the max `
                        + `${limit.max} here and ${known.max} in another definition`);
                }

                maxes.set(limit.name, known ?? limit);
            }

            for (const limit of settings.localRateLimits ?? []) {
                const known = rates.get(limit.name);

                if (known && describeRate(known) !== describeRate(limit)) {
                    throw new ConfigError(`${where}: the rate limit ${JSON.stringify(limit.name)} has `
                        + `${describeRate(limit)} here and ${describeRate(known)} in another definition`);
                }

                rates.set(limit.name, known ?? limit);
            }
        }
    }

    /** @type {Registry['check']} */
    function check(specs) {
        /** @type {Set<string>} */
        const names = new Set();

        for (const { name, definition, settings, where } of specs) {
            if (entriesByName.has(name) || names.has(name)) {
                throw new ConfigError(`${where}: the lane "${name}" is handled here already`);
            }

            names.add(name);

            if (definition && hasLocalSettings(definition) && settings !== definition && hasLocalSettings(settings)) {
                throw new ConfigError(`${where}: the local settings of the lane "${name}" are in its definition and `
                    + 'in its handler: set them in the handler only');
            }

            if (definition?.globalConcurrencyLimits && timeoutOf(definition) === null) {
                throw new ConfigError(
                    `${where}: a lane with global concurrency limits needs a timeout (in the definition or "defaults")`,
                );
            }
        }

        checkLimits(specs);
    }

    /**
     * @param {LaneDefinition | null} definition
     * @returns {number | null}
     */
    function timeoutOf(definition) {
        return parseDuration(definition?.timeout) ?? defaultTimeoutMs;
    }

    /**
     * Adds a checked spec.
     * @param {EntrySpec} spec
     * @returns {HandlerEntry}
     */
    function addChecked({ name, definition, handler, settings }) {
        const limits = (settings.localConcurrencyLimits ?? []).map((limit) => {
            const state = limitStates.get(limit.name) ?? { limit, running: 0, lanes: [] };

            limitStates.set(limit.name, state);

            return state;
        });
        const rates = (settings.localRateLimits ?? []).map((limit) => {
            const state = rateStates.get(limit.name) ?? createRateState(limit);

            rateStates.set(limit.name, state);

            return state;
        });

        for (const limit of [...limits, ...rates]) {
            limit.lanes.push(name);
        }

        const count = countOf(name);
        /** @type {HandlerEntry} */
        const entry = {
            name,
            index: nextIndex++,
            definition,
            handler,
            weight: settings.fairShareWeight ?? 1,
            // Of the lane name: the jobs of an earlier handler that still run count too
            get running() {
                return count.running;
            },
            set running(value) {
                count.running = value;
            },
            limits,
            rates,
            timeoutMs: timeoutOf(definition),
        };

        entriesByName.set(name, entry);

        return entry;
    }

    /** @type {Registry['add']} */
    function add(lane, handler, options) {
        const name = isPlainObject(lane) ? lane.name : lane;
        const where = `lanes.add(${JSON.stringify(name)})`;

        if (typeof name !== 'string' || !NAME_REGEXP.test(name)) {
            throw new ConfigError(`${where}: the lane must be a lane definition or a lane name`);
        }

        if (typeof handler !== 'function') {
            throw new ConfigError(`${where}: the handler must be a function`);
        }

        if (options !== undefined) {
            throw new ConfigError(`${where}: lanes.add() takes no options`);
        }

        if (entriesByName.has(name)) {
            throw new ConfigError(`${where}: the lane is added already`);
        }

        const known = lanesByName.get(name);
        const definition = isPlainObject(lane) ? /** @type {LaneDefinition} */ (lane) : known ?? null;

        if (known && definition !== known) {
            throw new ConfigError(`${where}: another definition of "${name}" is in "lanes"`);
        }

        const spec = { name, definition, handler, settings: definition ?? {}, where };

        check([spec]);
        addChecked(spec);
    }

    /** @type {Registry['validate']} */
    function validate() {
        for (const entry of entriesByName.values()) {
            const failureLane = entry.definition?.failureLane;

            if (failureLane === undefined) {
                continue;
            }

            const addWhere = `lanes.add(${JSON.stringify(entry.name)})`;
            const known = typeof failureLane !== 'string' || lanesByName.has(failureLane) || entriesByName.has(failureLane);

            if (!known) {
                throw new ConfigError(`${addWhere}: the failure lane "${failureLane}" is not in "lanes" and not added`);
            }

            // Added by name only: no definition, so no failure lane of its own
            const failureDefinition = typeof failureLane === 'string' ? findDefinition(failureLane) : failureLane;

            if (failureDefinition?.failureLane !== undefined) {
                throw new ConfigError(
                    `${addWhere}: the failure lane "${failureDefinition?.name}" has a failure lane of its own`,
                );
            }
        }
    }

    return {
        add,
        check,
        addEntries: (specs) => {
            check(specs);

            return specs.map(addChecked);
        },
        remove: (entries) => {
            for (const entry of entries) {
                if (entriesByName.get(entry.name) !== entry) {
                    continue;
                }

                entriesByName.delete(entry.name);

                for (const limit of [...entry.limits, ...entry.rates]) {
                    limit.lanes = limit.lanes.filter(lane => lane !== entry.name);
                }
            }
        },
        getEntry: name => entriesByName.get(name),
        entries: () => [...entriesByName.values()],
        span: () => nextIndex,
        runningOf: name => laneCounts.get(name)?.running ?? 0,
        findDefinition,
        lanesWithLimits: () => [...entriesByName.values()]
            .filter(entry => entry.definition?.globalConcurrencyLimits || entry.definition?.globalRateLimits)
            .map(entry => entry.name),
        lanesWithRateLimits: () => [...entriesByName.values()]
            .filter(entry => entry.definition?.globalRateLimits)
            .map(entry => entry.name),
        validate,
    };
}

/**
 * @param {import('./types.js').RateLimit} limit
 * @returns {string} Its settings, for a comparison and the error message.
 */
function describeRate({ max, per, burst }) {
    return `max ${max} per ${per} ms, burst ${burst}`;
}
