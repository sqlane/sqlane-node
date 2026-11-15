// The handlers of an instance, their weights and local concurrency limits, and the known definitions.
import { parseDuration } from './duration.js';
import { ConfigError } from './errors.js';
import { isPlainObject, JOB_NAME_REGEXP } from './validate.js';

/** @typedef {import('./types.js').JobDefinition} JobDefinition */

/**
 * A local concurrency limit in this instance: its handlers that run.
 * @typedef {object} LimitState
 * @property {import('./types.js').ConcurrencyLimit} limit
 * @property {number} running
 * @property {string[]} names Its handled names.
 */

/**
 * @typedef {object} HandlerEntry
 * @property {string} name
 * @property {number} index Its position in the order of the handle() calls: the order of the ties.
 * @property {JobDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {number} weight Its fairShareWeight.
 * @property {number} running Its jobs that run in this instance.
 * @property {LimitState[]} limits Its local concurrency limits.
 * @property {number | null} timeoutMs Resolved: the definition, else the defaults.
 */

/**
 * @typedef {object} Registry
 * @property {(job: JobDefinition | string, handler: import('./types.js').Handler, options?: unknown) => void} handle
 * @property {(name: string) => HandlerEntry | undefined} getEntry
 * @property {() => HandlerEntry[]} entries In the order of the handle() calls.
 * @property {(name: string) => JobDefinition | null} findDefinition In `jobs`, else handled.
 * @property {() => string[]} namesWithKeys The handled names whose definition has mutex keys.
 * @property {() => void} validate Checks the handlers together: each failure job resolves and has none of its own.
 */

/**
 * @param {object} params
 * @param {Map<string, JobDefinition>} params.jobsByName
 * @param {number | null} params.defaultTimeoutMs
 * @returns {Registry}
 */
export function createRegistry({ jobsByName, defaultTimeoutMs }) {
    /** @type {Map<string, HandlerEntry>} */
    const entriesByName = new Map();
    /** @type {Map<string, LimitState>} */
    const limitStates = new Map();

    /** @type {Registry['findDefinition']} */
    function findDefinition(name) {
        return jobsByName.get(name) ?? entriesByName.get(name)?.definition ?? null;
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

            const state = known ?? { limit, running: 0, names: [] };

            limitStates.set(limit.name, state);

            return state;
        });
    }

    /** @type {Registry['handle']} */
    function handle(job, handler, options) {
        const name = isPlainObject(job) ? job.name : job;
        const where = `handle(${JSON.stringify(name)})`;

        if (typeof name !== 'string' || !JOB_NAME_REGEXP.test(name)) {
            throw new ConfigError(`${where}: the job must be a job definition or a job name`);
        }

        if (typeof handler !== 'function') {
            throw new ConfigError(`${where}: the handler must be a function`);
        }

        // The options of 5.x: an error that names where they went
        if (options !== undefined) {
            throw new ConfigError(`${where}: handle() takes no options since 6.0: set "timeout" and "fairShareWeight" `
                + 'in defineJob(), and replace "maxConcurrency" and "concurrencyGroup" with "localConcurrencyLimits"');
        }

        if (entriesByName.has(name)) {
            throw new ConfigError(`${where}: the job is handled already`);
        }

        const known = jobsByName.get(name);
        const definition = isPlainObject(job) ? /** @type {JobDefinition} */ (job) : known ?? null;

        if (known && definition !== known) {
            throw new ConfigError(`${where}: another definition of "${name}" is in "jobs"`);
        }

        const timeoutMs = parseDuration(definition?.timeout) ?? defaultTimeoutMs;

        if (definition?.mutexKeys && timeoutMs === null) {
            throw new ConfigError(`${where}: a job with mutex keys needs a timeout (in the definition or "defaults")`);
        }

        const limits = limitStatesOf(definition?.localConcurrencyLimits ?? [], where);

        for (const limit of limits) {
            limit.names.push(name);
        }

        entriesByName.set(name, {
            name,
            index: entriesByName.size,
            definition,
            handler,
            weight: definition?.fairShareWeight ?? 1,
            running: 0,
            limits,
            timeoutMs,
        });
    }

    /** @type {Registry['validate']} */
    function validate() {
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
