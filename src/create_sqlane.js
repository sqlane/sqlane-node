import { resolveDefaults } from './defaults.js';
import { createEnqueuer } from './enqueue.js';
import { createHintChannel } from './hint_channel.js';
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
 * The hint of an instance: the `hint` option, or the LISTEN/NOTIFY of a pg adapter with `notify`.
 * @param {import('./types.js').Adapter<any>} adapter
 * @param {unknown} hint
 * @returns {import('./types.js').Hint | null}
 */
function resolveHint(adapter, hint) {
    if (hint !== undefined && hint !== null) {
        if (!isPlainObject(hint) || typeof hint.publish !== 'function' || typeof hint.subscribe !== 'function') {
            throw new ConfigError('createSqlane: "hint" must be { publish(channel, message), subscribe(channel, onMessage) }');
        }

        if (adapter.notify) {
            throw new ConfigError('createSqlane: "hint" or pgAdapter(pool, { notify: true }), not both');
        }

        return /** @type {import('./types.js').Hint} */ (hint);
    }

    if (!adapter.notify || !adapter.listen) {
        return null;
    }

    const { listen } = adapter;

    return {
        publish: async (channel, message) => {
            await adapter.queue.query('SELECT pg_notify($1, $2)', [channel, message]);
        },
        subscribe: listen,
    };
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
    const hint = resolveHint(adapter, options.hint);
    /**
     * An error of an optimization (hints, wakes): logged as a warning, never thrown.
     * @param {string} operation
     * @param {unknown} error
     */
    const reportError = (operation, error) => {
        options.logger?.warn({ error, operation }, `sqlane: ${operation} failed`);
        options.onEvent?.({ type: 'error', operation, error });
    };
    const hintChannel = createHintChannel({ hint, channel: `${tablePrefix}ready`, reportError });
    // NOTIFY in the enqueue transaction: no publish after the enqueue
    const notifyChannel = adapter.notify ? `${tablePrefix}ready` : null;
    // Undocumented, for the tests of sqlane
    const testTimings = /** @type {{ timings?: object }} */ (options).timings;
    const store = createStore(adapter, tablePrefix);
    const runner = createRunner({
        store,
        registry,
        concurrency,
        defaults,
        cleanup,
        logger: options.logger,
        onEvent: options.onEvent,
        hintChannel,
        hintsAfterCommit: Boolean(adapter.notify),
        timings: { pollIntervalMs, ...testTimings },
    });
    const enqueuer = createEnqueuer({
        adapter,
        tablePrefix,
        findDefinition: registry.findDefinition,
        unknownJobs,
        defaults,
        maxPayloadBytes,
        notifyChannel,
    });
    /**
     * Wakes this process, sends the hint to the others.
     * @param {string} name
     * @param {boolean} committed False: the commit is to come.
     */
    const wakeFor = (name, committed) => {
        if (committed) {
            runner.onCommitted([name]);
        } else {
            runner.onEnqueued([name]);
        }

        // A process sends a hint only for the jobs that it cannot start itself
        if (!notifyChannel && !runner.canStartNow(name)) {
            hintChannel.publish(name);
        }
    };
    /**
     * After the commit when the adapter knows it, else at once.
     * @param {unknown} connection
     * @param {string} name
     */
    const onCreated = (connection, name) => {
        let hooked = false;

        try {
            hooked = adapter.afterCommit?.(/** @type {any} */ (connection), () => {
                try {
                    wakeFor(name, true);
                } catch (error) {
                    reportError('after_commit', error);
                }
            }) ?? false;
        } catch (error) {
            reportError('after_commit', error);
        }

        if (!hooked) {
            wakeFor(name, false);
        }
    };

    return {
        enqueue: async (connection, job, payload, enqueueOptions) => {
            const result = await enqueuer.enqueue(connection, job, payload, enqueueOptions);

            if (result.created) {
                onCreated(connection, typeof job === 'string' ? job : job.name);
            }

            return result;
        },
        enqueueMany: async (connection, job, items) => {
            const results = await enqueuer.enqueueMany(connection, job, items);

            if (results.some(result => result.created)) {
                onCreated(connection, typeof job === 'string' ? job : job.name);
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
        getStats: () => store.getStats(),
        wake: () => runner.wake(),
    };
}
