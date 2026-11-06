import { resolveDefaults } from './defaults.js';
import { createEnqueuer } from './enqueue.js';
import { ConfigError } from './errors.js';
import { runMigrations } from './migrations.js';
import { DEFAULT_MAX_PAYLOAD_BYTES } from './payload.js';
import { checkInteger, checkObject, checkTablePrefix, isPlainObject } from './validate.js';

const OPTION_NAMES = [
    'adapter', 'jobs', 'concurrency', 'lanes', 'defaults', 'unknownJobs', 'hint', 'logger', 'onEvent', 'tablePrefix',
    'pollInterval', 'maxPayloadBytes', 'cleanup',
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

    const jobsByName = indexJobs(options.jobs ?? [], scope);
    const { enqueue, enqueueMany } = createEnqueuer({
        adapter,
        tablePrefix,
        findDefinition: name => jobsByName.get(name) ?? null,
        unknownJobs,
        defaults: resolveDefaults(options.defaults),
        maxPayloadBytes,
    });

    return {
        enqueue,
        enqueueMany,
        handle: () => notImplemented('handle'),
        start: () => notImplemented('start'),
        drain: () => notImplemented('drain'),
        close: () => notImplemented('close'),
        migrate: async migrateOptions => ({
            applied: await runMigrations(adapter, tablePrefix, migrateOptions),
        }),
        getStats: () => notImplemented('getStats'),
        wake: () => notImplemented('wake'),
    };
}
