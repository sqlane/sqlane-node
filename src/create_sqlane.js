import { resolveDefaults } from './defaults.js';
import { createEnqueuer } from './enqueue.js';
import { createHintChannel } from './hint_channel.js';
import { ClosedError, ConfigError } from './errors.js';
import { runMigrations } from './migrations.js';
import { DEFAULT_MAX_PAYLOAD_BYTES } from './payload.js';
import { createRegistry } from './registry.js';
import { createRunner } from './runner.js';
import { checkSchedule } from './schedule.js';
import { createScheduler } from './scheduler.js';
import { createStore } from './store/store.js';
import { isMissingTableError } from './transient_error.js';
import { checkDuration, checkInteger, checkObject, checkTablePrefix, isPlainObject } from './validate.js';

const OPTION_NAMES = [
    'adapter', 'jobs', 'maxConcurrency', 'defaults', 'unknownJobs', 'hint', 'logger', 'onEvent', 'tablePrefix',
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
 * @param {import('./types.js').SqlaneOptions<C>} options
 * @returns {import('./types.js').Sqlane<C>}
 */
export function createSqlane(options) {
    const scope = { where: 'createSqlane', ErrorClass: ConfigError };

    // The options of 4.x: an error that names the new API
    const given = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (options));

    if (isPlainObject(given) && given.concurrency !== undefined) {
        throw new ConfigError('createSqlane: "concurrency" is now "maxConcurrency" (5.0)');
    }

    if (isPlainObject(given) && given.lanes !== undefined) {
        throw new ConfigError('createSqlane: "lanes" was removed in 5.0: define groups with defineConcurrencyGroup() '
            + 'and pass them to handle() as "concurrencyGroup"');
    }

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

    const { maxConcurrency = 10, cleanup = true } = options;

    checkInteger(maxConcurrency, '"maxConcurrency"', scope);

    if (typeof cleanup !== 'boolean') {
        throw new ConfigError('createSqlane: "cleanup" must be a boolean');
    }

    const pollIntervalMs = checkDuration(options.pollInterval ?? '5s', '"pollInterval"', scope, true);
    const jobsByName = indexJobs(options.jobs ?? [], scope);
    const defaults = resolveDefaults(options.defaults);
    const registry = createRegistry({
        jobsByName,
        maxConcurrency,
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
    const store = createStore(adapter, tablePrefix, options.logger);
    const runner = createRunner({
        store,
        registry,
        maxConcurrency,
        defaults,
        cleanup,
        logger: options.logger,
        onEvent: options.onEvent,
        hintChannel,
        hintsAfterCommit: Boolean(adapter.notify),
        timings: { pollIntervalMs, ...testTimings },
        // Undocumented, for the tests of sqlane: the random start of the tie pointer
        random: /** @type {{ random?: () => number }} */ (testTimings ?? {}).random ?? Math.random,
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

    const scheduler = createScheduler({
        store,
        defaults,
        maxPayloadBytes,
        findDefinition: registry.findDefinition,
        unknownJobs,
        notifyChannel,
        onCreated: name => wakeFor(name, true),
        emit: runner.emit,
        logger: options.logger,
        timings: /** @type {{ schedules?: object }} */ (testTimings ?? {}).schedules,
    });
    /** @type {Promise<void> | null} */
    let startPromise = null;
    /** @type {Promise<void> | null} */
    let closePromise = null;

    /**
     * Registers the schedules, then starts the runner and the scheduler. Nothing runs before the runner starts: a
     * rejected start leaves no half-started instance.
     * @returns {Promise<void>}
     */
    async function startOnce() {
        scheduler.prepare();

        /** @type {import('./store/store.js').ScheduleRead | null} */
        let read = null;

        if (scheduler.size() > 0) {
            try {
                read = await scheduler.register();
            } catch (error) {
                if (isMissingTableError(error)) {
                    throw new ConfigError(`start(): the table ${tablePrefix}schedules is missing: run migrate()`, {
                        cause: error,
                    });
                }

                // The database is down: start anyway, the registration retries
                scheduler.reportFailure(error);
            }
        }

        // close() ran during the registration
        if (runner.isClosed()) {
            return;
        }

        await runner.start();

        // close() ran during runner.start()
        if (!runner.isClosed()) {
            scheduler.start(read);
        }
    }

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

            if (!runner.isIdle()) {
                throw new ConfigError('handle() during drain(): register all the handlers before drain()');
            }

            registry.handle(job, handler, handleOptions);
        },
        schedule: (job, scheduleOptions) => {
            if (runner.isClosed()) {
                throw new ClosedError('schedule() after close()');
            }

            if (!runner.isIdle() || startPromise) {
                throw new ConfigError('schedule() after start(): add all the schedules before start()');
            }

            const entry = checkSchedule(job, scheduleOptions);

            entry.definition = isPlainObject(job) ? /** @type {import('./types.js').JobDefinition} */ (job) : null;
            scheduler.add(entry);
        },
        getSchedules: () => scheduler.list(),
        start: async () => {
            if (runner.isClosed()) {
                throw new ClosedError('start() after close()');
            }

            if (!startPromise && !runner.isIdle()) {
                return runner.start();
            }

            startPromise ??= (async () => {
                try {
                    await startOnce();
                } catch (error) {
                    startPromise = null;
                    throw error;
                }
            })();

            return startPromise;
        },
        drain: runner.drain,
        // The runner closes at once: handle() and start() then throw, and the deadline counts from the call. The
        // scheduler stops in parallel, and a pending registration of start() ends first.
        close: (closeOptions) => {
            closePromise ??= (async () => {
                const runnerClosed = runner.close(closeOptions);

                await Promise.all([scheduler.stop(), startPromise?.catch(() => {}), runnerClosed]);
            })();

            return closePromise;
        },
        migrate: async migrateOptions => ({
            applied: await runMigrations(adapter, tablePrefix, migrateOptions),
        }),
        getStats: () => store.getStats(),
        wake: () => runner.wake(),
    };
}
