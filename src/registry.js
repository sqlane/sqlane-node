// The handlers of an instance, their lanes and the known definitions.
import { parseDuration } from './duration.js';
import { ConfigError } from './errors.js';
import { checkDuration, checkInteger, checkObject, isPlainObject, JOB_NAME_REGEXP } from './validate.js';

/** @typedef {import('./types.js').JobDefinition} JobDefinition */

/**
 * A concurrency limit in this process.
 * @typedef {object} Lane
 * @property {string} name
 * @property {number} concurrency
 * @property {number} running
 */

/**
 * @typedef {object} HandlerEntry
 * @property {string} name
 * @property {JobDefinition | null} definition
 * @property {import('./types.js').Handler} handler
 * @property {Lane} lane
 * @property {number | null} timeoutMs Resolved: the handle() options, else the definition, else the defaults.
 */

/**
 * @typedef {object} Registry
 * @property {(job: JobDefinition | string, handler: import('./types.js').Handler, options?: object) => void} handle
 * @property {(name: string) => HandlerEntry | undefined} getEntry
 * @property {() => HandlerEntry[]} entries
 * @property {(name: string) => JobDefinition | null} findDefinition In `jobs`, else handled.
 * @property {() => string[]} namesWithKeys The handled names whose definition has mutex keys.
 * @property {() => void} validate Checks the handlers together: each failure job resolves and has none of its own.
 */

/**
 * @param {object} params
 * @param {Map<string, JobDefinition>} params.jobsByName
 * @param {unknown} params.lanes The `lanes` option.
 * @param {number} params.concurrency The process concurrency.
 * @param {number | null} params.defaultTimeoutMs
 * @returns {Registry}
 */
export function createRegistry({ jobsByName, lanes, concurrency, defaultTimeoutMs }) {
    const scope = { where: 'createSqlane', ErrorClass: ConfigError };
    /** @type {Map<string, Lane>} */
    const namedLanes = new Map();
    /** The handlers without a lane: the process concurrency only */
    const defaultLane = { name: '', concurrency, running: 0 };
    /** @type {Map<string, HandlerEntry>} */
    const entriesByName = new Map();

    if (lanes !== undefined && !isPlainObject(lanes)) {
        throw new ConfigError('createSqlane: "lanes" must be an object of lane options');
    }

    for (const [name, options] of Object.entries(lanes ?? {})) {
        const laneOptions = checkObject(options, ['concurrency'], `lane "${name}" options`, scope);

        checkInteger(laneOptions.concurrency, `lane "${name}" concurrency`, scope);
        namedLanes.set(name, { name, concurrency: Math.min(Number(laneOptions.concurrency), concurrency), running: 0 });
    }

    /** @type {Registry['findDefinition']} */
    function findDefinition(name) {
        return jobsByName.get(name) ?? entriesByName.get(name)?.definition ?? null;
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

        const handleOptions = checkObject(options, ['concurrency', 'lane', 'timeout'], 'options', handleScope);

        if (entriesByName.has(name)) {
            throw new ConfigError(`${where}: the job is handled already`);
        }

        const known = jobsByName.get(name);
        const definition = isPlainObject(job) ? /** @type {JobDefinition} */ (job) : known ?? null;

        if (known && definition !== known) {
            throw new ConfigError(`${where}: another definition of "${name}" is in "jobs"`);
        }

        if (handleOptions.lane !== undefined && handleOptions.concurrency !== undefined) {
            throw new ConfigError(`${where}: "lane" or "concurrency", not both`);
        }

        /** @type {Lane} */
        let lane = defaultLane;

        if (handleOptions.lane !== undefined) {
            const named = namedLanes.get(String(handleOptions.lane));

            if (!named) {
                throw new ConfigError(`${where}: unknown lane ${JSON.stringify(handleOptions.lane)}`);
            }

            lane = named;
        } else if (handleOptions.concurrency !== undefined) {
            checkInteger(handleOptions.concurrency, '"concurrency"', handleScope);
            lane = {
                name: `handler:${name}`,
                concurrency: Math.min(Number(handleOptions.concurrency), concurrency),
                running: 0,
            };
        }

        if (handleOptions.timeout !== undefined) {
            checkDuration(handleOptions.timeout, '"timeout"', handleScope, true);
        }

        const timeoutMs = parseDuration(handleOptions.timeout ?? definition?.timeout) ?? defaultTimeoutMs;

        if (definition?.mutexKeys && timeoutMs === null) {
            throw new ConfigError(
                `${where}: a job with mutex keys needs a timeout (in handle(), the definition or "defaults")`,
            );
        }

        entriesByName.set(name, { name, definition, handler, lane, timeoutMs });
    }

    /** @type {Registry['validate']} */
    function validate() {
        for (const entry of entriesByName.values()) {
            const failureJob = entry.definition?.failureJob;

            if (failureJob === undefined) {
                continue;
            }

            const where = `handle(${JSON.stringify(entry.name)})`;
            const known = typeof failureJob !== 'string' || jobsByName.has(failureJob) || entriesByName.has(failureJob);

            if (!known) {
                throw new ConfigError(`${where}: the failure job "${failureJob}" is not in "jobs" and not handled`);
            }

            // Handled by name only: no definition, so no failure job of its own
            const failureDefinition = typeof failureJob === 'string' ? findDefinition(failureJob) : failureJob;

            if (failureDefinition?.failureJob !== undefined) {
                throw new ConfigError(`${where}: the failure job "${failureDefinition?.name}" has a failure job of its own`);
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
