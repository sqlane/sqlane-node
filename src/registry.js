// The handlers of an instance, their caps, weights and concurrency groups, and the known definitions.
import { isConcurrencyGroup } from './define_concurrency_group.js';
import { parseDuration } from './duration.js';
import { ConfigError } from './errors.js';
import { checkDuration, checkInteger, checkObject, isPlainObject, JOB_NAME_REGEXP } from './validate.js';

/** @typedef {import('./types.js').JobDefinition} JobDefinition */

const HANDLE_OPTION_NAMES = ['maxConcurrency', 'concurrencyGroup', 'fairShareWeight', 'timeout'];
const MAX_WEIGHT = 1000;

/**
 * A concurrency group in this instance: its handlers that run.
 * @typedef {object} GroupState
 * @property {import('./types.js').ConcurrencyGroup} group
 * @property {number} running
 * @property {string[]} names Its handled names.
 */

/**
 * @typedef {object} HandlerEntry
 * @property {string} name
 * @property {number} index Its position in the order of the handle() calls: the order of the ties.
 * @property {JobDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {number | null} maxConcurrency Null: only the caps of its group and of the instance.
 * @property {number} weight Its fairShareWeight.
 * @property {number} running Its jobs that run in this instance.
 * @property {GroupState | null} group
 * @property {number | null} timeoutMs Resolved: the handle() options, else the definition, else the defaults.
 */

/**
 * @typedef {object} Registry
 * @property {(job: JobDefinition | string, handler: import('./types.js').Handler, options?: object) => void} handle
 * @property {(name: string) => HandlerEntry | undefined} getEntry
 * @property {() => HandlerEntry[]} entries In the order of the handle() calls.
 * @property {(name: string) => JobDefinition | null} findDefinition In `jobs`, else handled.
 * @property {() => string[]} namesWithKeys The handled names whose definition has mutex keys.
 * @property {(where: string) => void} validate Checks the handlers together: each failure job resolves and has none
 *     of its own, and no cap is above the instance's. `where`: `start()` or `drain()`, for the messages.
 */

/**
 * @param {object} params
 * @param {Map<string, JobDefinition>} params.jobsByName
 * @param {number} params.maxConcurrency The instance's cap.
 * @param {number | null} params.defaultTimeoutMs
 * @returns {Registry}
 */
export function createRegistry({ jobsByName, maxConcurrency, defaultTimeoutMs }) {
    /** @type {Map<string, HandlerEntry>} */
    const entriesByName = new Map();
    /** @type {Map<import('./types.js').ConcurrencyGroup, GroupState>} */
    const groupStates = new Map();
    /** @type {Map<string, import('./types.js').ConcurrencyGroup>} */
    const groupsByName = new Map();

    /** @type {Registry['findDefinition']} */
    function findDefinition(name) {
        return jobsByName.get(name) ?? entriesByName.get(name)?.definition ?? null;
    }

    /**
     * @param {unknown} value
     * @param {string} where
     * @returns {GroupState | null}
     */
    function groupStateOf(value, where) {
        if (value === undefined) {
            return null;
        }

        if (!isConcurrencyGroup(value)) {
            throw new ConfigError(`${where}: "concurrencyGroup" must be a group from defineConcurrencyGroup()`);
        }

        const known = groupsByName.get(value.name);

        if (known && known !== value) {
            throw new ConfigError(`${where}: another concurrency group is named ${JSON.stringify(value.name)}`);
        }

        groupsByName.set(value.name, value);

        let state = groupStates.get(value);

        if (!state) {
            state = { group: value, running: 0, names: [] };
            groupStates.set(value, state);
        }

        return state;
    }

    /** @type {Registry['handle']} */
    function handle(job, handler, options = {}) {
        const name = isPlainObject(job) ? job.name : job;
        const where = `handle(${JSON.stringify(name)})`;
        const handleScope = { where, ErrorClass: ConfigError };

        if (typeof name !== 'string' || !JOB_NAME_REGEXP.test(name)) {
            throw new ConfigError(`${where}: the job must be a job definition or a job name`);
        }

        if (typeof handler !== 'function') {
            throw new ConfigError(`${where}: the handler must be a function`);
        }

        // The options of 4.x: an error that names the new one
        if (isPlainObject(options) && options.concurrency !== undefined) {
            throw new ConfigError(`${where}: "concurrency" is now "maxConcurrency" (5.0)`);
        }

        if (isPlainObject(options) && options.lane !== undefined) {
            throw new ConfigError(`${where}: "lane" was removed in 5.0: use "concurrencyGroup"`);
        }

        const handleOptions = checkObject(options, HANDLE_OPTION_NAMES, 'options', handleScope);

        if (entriesByName.has(name)) {
            throw new ConfigError(`${where}: the job is handled already`);
        }

        const known = jobsByName.get(name);
        const definition = isPlainObject(job) ? /** @type {JobDefinition} */ (job) : known ?? null;

        if (known && definition !== known) {
            throw new ConfigError(`${where}: another definition of "${name}" is in "jobs"`);
        }

        if (handleOptions.maxConcurrency !== undefined) {
            checkInteger(handleOptions.maxConcurrency, '"maxConcurrency"', handleScope);
        }

        const weight = handleOptions.fairShareWeight === undefined ? 1 : handleOptions.fairShareWeight;

        if (!Number.isSafeInteger(weight) || Number(weight) < 1 || Number(weight) > MAX_WEIGHT) {
            throw new ConfigError(`${where}: "fairShareWeight" must be an integer from 1 to ${MAX_WEIGHT}`);
        }

        const group = groupStateOf(handleOptions.concurrencyGroup, where);

        if (handleOptions.timeout !== undefined) {
            checkDuration(handleOptions.timeout, '"timeout"', handleScope, true);
        }

        const timeoutMs = parseDuration(handleOptions.timeout ?? definition?.timeout) ?? defaultTimeoutMs;

        if (definition?.mutexKeys && timeoutMs === null) {
            throw new ConfigError(
                `${where}: a job with mutex keys needs a timeout (in handle(), the definition or "defaults")`,
            );
        }

        group?.names.push(name);
        entriesByName.set(name, {
            name,
            index: entriesByName.size,
            definition,
            handler,
            maxConcurrency: handleOptions.maxConcurrency === undefined ? null : Number(handleOptions.maxConcurrency),
            weight: Number(weight),
            running: 0,
            group,
            timeoutMs,
        });
    }

    /** @type {Registry['validate']} */
    function validate(where) {
        for (const entry of entriesByName.values()) {
            const failureJob = entry.definition?.failureJob;

            if (failureJob === undefined) {
                continue;
            }

            const handleWhere = `handle(${JSON.stringify(entry.name)})`;
            const known = typeof failureJob !== 'string' || jobsByName.has(failureJob) || entriesByName.has(failureJob);

            if (!known) {
                throw new ConfigError(`${handleWhere}: the failure job "${failureJob}" is not in "jobs" and not handled`);
            }

            // Handled by name only: no definition, so no failure job of its own
            const failureDefinition = typeof failureJob === 'string' ? findDefinition(failureJob) : failureJob;

            if (failureDefinition?.failureJob !== undefined) {
                throw new ConfigError(
                    `${handleWhere}: the failure job "${failureDefinition?.name}" has a failure job of its own`,
                );
            }
        }

        for (const entry of entriesByName.values()) {
            if (entry.maxConcurrency !== null && entry.maxConcurrency > maxConcurrency) {
                throw new ConfigError(`${where}: the maxConcurrency of handle(${JSON.stringify(entry.name)}) `
                    + `(${entry.maxConcurrency}) is above the instance's maxConcurrency (${maxConcurrency})`);
            }
        }

        for (const { group } of groupStates.values()) {
            if (group.maxConcurrency > maxConcurrency) {
                throw new ConfigError(`${where}: the maxConcurrency of the concurrency group ${JSON.stringify(group.name)} `
                    + `(${group.maxConcurrency}) is above the instance's maxConcurrency (${maxConcurrency})`);
            }
        }
    }

    return {
        handle,
        getEntry: name => entriesByName.get(name),
        entries: () => [...entriesByName.values()],
        findDefinition,
        namesWithKeys: () => [...entriesByName.values()]
            .filter(entry => entry.definition?.mutexKeys)
            .map(entry => entry.name),
        validate,
    };
}
