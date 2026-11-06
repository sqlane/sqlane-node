import { resolveDefaults } from './defaults.js';
import { createEnqueuer } from './enqueue.js';
import { ClosedError, ConfigError } from './errors.js';
import { runMigrations } from './migrations.js';
import { DEFAULT_MAX_PAYLOAD_BYTES } from './payload.js';
import { createRegistry } from './registry.js';
import { createRunner } from './runner.js';
import { createStore } from './store/store.js';
import { checkDuration, checkInteger, checkObject, checkTablePrefix, isPlainObject } from './validate.js';

const OPTION_NAMES = [
    'adapter', 'jobs', 'concurrency', 'lanes', 'defaults', 'unknownJobs', 'hint', 'logger', 'onEvent', 'tablePrefix',
    'pollInterval', 'maxPayloadBytes', 'cleanup', 'timings',
];

/**
 * @param {string} method
 * @returns {never}
 */
function notImplemented(method) {
    throw new Error(`sqlane: ${method}() is not implemented yet`);
}

/**
 * @param {unknown} jobs
 * @param {import('./validate.js').Scope} scope
 * @returns {Map<string, import('./types.js').JobDefinition>} The definitions by name.
 */
function indexJobs(jobs, scope) {
    if (!Array.isArray(jobs)) {
        throw new ConfigError(`${scope.where}: "jobs" must be an array of job definitions`);
    }

    /** @type {Map<string, import('./types.js').JobDefinition>} */
    const byName = new Map();

    for (const job of jobs) {
        if (!isPlainObject(job) || typeof job.name !== 'string') {
            throw new ConfigError(`${scope.where}: "jobs" must be an array of job definitions`);
        }

        const known = byName.get(job.name);

        if (known && known !== job) {
            throw new ConfigError(`${scope.where}: two different definitions of "${job.name}" in "jobs"`);
        }

        byName.set(job.name, /** @type {import('./types.js').JobDefinition} */ (job));
    }

    return byName;
}

/**
 * Creates a sqlane instance. It connects, migrates and starts nothing.
 * @template C The connections that `enqueue` accepts, from the adapter.
 * @template {string} [L=never] The lane names, from `lanes`.
 * @param {import('./types.js').SqlaneOptions<C, L>} options
 * @returns {import('./types.js').Sqlane<C, L>}
 */
export function createSqlane(options) {
    const scope = { where: 'createSqlane', ErrorClass: ConfigError };

    checkObject(options, OPTION_NAMES, 'options', scope);

    if (!options.adapter) {
        throw new ConfigError('createSqlane: "adapter" is required');
    }

    const {
        adapter,
        tablePrefix = 'sqlane_',
        unknownJobs = 'allow',
        maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
    } = options;

    checkTablePrefix(tablePrefix, scope);
    checkInteger(maxPayloadBytes, '"maxPayloadBytes"', scope);

    if (unknownJobs !== 'allow' && unknownJobs !== 'reject') {
        throw new ConfigError(`createSqlane: "unknownJobs" must be 'allow' or 'reject'`);
    }

    const { concurrency = 10, cleanup = true } = options;

    checkInteger(concurrency, '"concurrency"', scope);

    if (typeof cleanup !== 'boolean') {
        throw new ConfigError('createSqlane: "cleanup" must be a boolean');
    }

    const pollIntervalMs = checkDuration(options.pollInterval ?? '5s', '"pollInterval"', scope, true);
    const jobsByName = indexJobs(options.jobs ?? [], scope);
    const defaults = resolveDefaults(options.defaults);
    const registry = createRegistry({
        jobsByName,
        lanes: options.lanes,
        concurrency,
        defaultTimeoutMs: defaults.timeoutMs,
    });
    // Undocumented, for the tests of sqlane
    const testTimings = /** @type {{ timings?: object }} */ (options).timings;
    const runner = createRunner({
        store: createStore(adapter, tablePrefix),
        registry,
        concurrency,
        defaults,
        cleanup,
        logger: options.logger,
        onEvent: options.onEvent,
        timings: { pollIntervalMs, ...testTimings },
    });
    const enqueuer = createEnqueuer({
        adapter,
        tablePrefix,
        findDefinition: registry.findDefinition,
        unknownJobs,
        defaults,
        maxPayloadBytes,
    });

    return {
        enqueue: async (connection, job, payload, enqueueOptions) => {
            const result = await enqueuer.enqueue(connection, job, payload, enqueueOptions);

            if (result.created) {
                runner.onEnqueued([typeof job === 'string' ? job : job.name]);
            }

            return result;
        },
        enqueueMany: async (connection, job, items) => {
            const results = await enqueuer.enqueueMany(connection, job, items);

            if (results.some(result => result.created)) {
                runner.onEnqueued([typeof job === 'string' ? job : job.name]);
            }

            return results;
        },
        handle: (job, handler, handleOptions) => {
            if (runner.isClosed()) {
                throw new ClosedError('handle() after close()');
            }

            if (runner.isStarted()) {
                throw new ConfigError('handle() after start(): register all the handlers before start()');
            }

            registry.handle(job, handler, handleOptions);
        },
        start: runner.start,
        drain: runner.drain,
        close: runner.close,
        migrate: async migrateOptions => ({
            applied: await runMigrations(adapter, tablePrefix, migrateOptions),
        }),
        getStats: () => notImplemented('getStats'),
        wake: name => runner.wake(name),
    };
}
