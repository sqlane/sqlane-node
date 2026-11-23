// The lanes of an instance, their handlers, weights, local concurrency and rate limits, and the known definitions.
import { parseDuration } from './duration.js';
import { ConfigError } from './errors.js';
import { createRateState } from './local_rates.js';
import { isPlainObject, NAME_REGEXP } from './validate.js';

/** @typedef {import('./types.js').LaneDefinition} LaneDefinition */
/** @typedef {import('./local_rates.js').RateState} RateState */

/**
 * A local concurrency limit in this instance: its handlers that run.
 * @typedef {object} LimitState
 * @property {import('./types.js').ConcurrencyLimit} limit
 * @property {number} running
 * @property {string[]} lanes Its added lanes.
 */

/**
 * @typedef {object} HandlerEntry
 * @property {string} name
 * @property {number} index Its position in the order of the lanes.add() calls: the order of the ties.
 * @property {LaneDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {number} weight Its fairShareWeight.
 * @property {number} running Its jobs that run in this instance.
 * @property {LimitState[]} limits Its local concurrency limits.
 * @property {RateState[]} rates Its local rate limits.
 * @property {number | null} timeoutMs Resolved: the definition, else the defaults.
 */

/**
 * @typedef {object} Registry
 * @property {(lane: LaneDefinition | string, handler: import('./types.js').Handler, options?: unknown) => void} add
 * @property {(lane: string) => HandlerEntry | undefined} getEntry
 * @property {() => HandlerEntry[]} entries In the order of the lanes.add() calls.
 * @property {(lane: string) => LaneDefinition | null} findDefinition In `lanes`, else added.
 * @property {() => string[]} lanesWithLimits The added lanes whose definition has global limits, of concurrency or
 *     of rate.
 * @property {() => string[]} lanesWithRateLimits The added lanes whose definition has global rate limits.
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
    /** @type {Map<string, LimitState>} */
    const limitStates = new Map();
    /** @type {Map<string, RateState>} */
    const rateStates = new Map();

    /** @type {Registry['findDefinition']} */
    function findDefinition(name) {
        return lanesByName.get(name) ?? entriesByName.get(name)?.definition ?? null;
    }

    /**
     * @param {readonly import('./types.js').ConcurrencyLimit[]} limits
     * @param {string} where
     * @returns {LimitState[]} One state per limit name in this instance.
     */
    function limitStatesOf(limits, where) {
        return limits.map((limit) => {
            const known = limitStates.get(limit.name);

            if (known && known.limit.max !== limit.max) {
                throw new ConfigError(`${where}: the concurrency limit ${JSON.stringify(limit.name)} has the max `
                    + `${limit.max} here and ${known.limit.max} in another definition`);
            }

            const state = known ?? { limit, running: 0, lanes: [] };

            limitStates.set(limit.name, state);

            return state;
        });
    }

    /**
     * @param {readonly import('./types.js').RateLimit[]} limits
     * @param {string} where
     * @returns {RateState[]} One state per rate limit name in this instance.
     */
    function rateStatesOf(limits, where) {
        return limits.map((limit) => {
            const known = rateStates.get(limit.name);

            if (known && describeRate(known.limit) !== describeRate(limit)) {
                throw new ConfigError(`${where}: the rate limit ${JSON.stringify(limit.name)} has ${describeRate(limit)} `
                    + `here and ${describeRate(known.limit)} in another definition`);
            }

            const state = known ?? createRateState(limit);

            rateStates.set(limit.name, state);

            return state;
        });
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

        const timeoutMs = parseDuration(definition?.timeout) ?? defaultTimeoutMs;

        if (definition?.globalConcurrencyLimits && timeoutMs === null) {
            throw new ConfigError(
                `${where}: a lane with global concurrency limits needs a timeout (in the definition or "defaults")`,
            );
        }

        const limits = limitStatesOf(definition?.localConcurrencyLimits ?? [], where);
        const rates = rateStatesOf(definition?.localRateLimits ?? [], where);

        for (const limit of [...limits, ...rates]) {
            limit.lanes.push(name);
        }

        entriesByName.set(name, {
            name,
            index: entriesByName.size,
            definition,
            handler,
            weight: definition?.fairShareWeight ?? 1,
            running: 0,
            limits,
            rates,
            timeoutMs,
        });
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
        getEntry: name => entriesByName.get(name),
        entries: () => [...entriesByName.values()],
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
