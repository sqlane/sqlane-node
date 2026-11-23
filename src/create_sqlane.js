import { resolveDefaults } from './defaults.js';
import { createEnqueuer } from './enqueue.js';
import { createHintChannel } from './hint_channel.js';
import { ClosedError, ConfigError } from './errors.js';
import { dropTables, rollbackMigrations, runMigrations } from './migrations.js';
import { findSchemaProblems, getMigrationStatus } from './schema_status.js';
import { DEFAULT_MAX_PAYLOAD_BYTES } from './payload.js';
import { createRegistry } from './registry.js';
import { createRunner } from './runner.js';
import { checkSchedule } from './schedule.js';
import { createScheduler } from './scheduler.js';
import { checkServer } from './server_check.js';
import { createJobsApi } from './jobs_api.js';
import { createBulk } from './jobs_bulk.js';
import { createStore } from './store/store.js';
import { isMissingTableError } from './transient_error.js';
import { checkDuration, checkInteger, checkObject, checkTablePrefix, isPlainObject } from './validate.js';

const OPTION_NAMES = [
    'adapter', 'lanes', 'localMaxConcurrency', 'defaults', 'unknownLanes', 'hint', 'logger', 'onEvent', 'tablePrefix',
    'pollInterval', 'maxPayloadBytes', 'cleanup', 'timings', 'installedVersion',
];

/**
 * @param {unknown} lanes
 * @param {import('./validate.js').Scope} scope
 * @returns {Map<string, import('./types.js').LaneDefinition>} The definitions by name.
 */
function indexLanes(lanes, scope) {
    if (!Array.isArray(lanes)) {
        throw new ConfigError(`${scope.where}: "lanes" must be an array of lane definitions`);
    }

    /** @type {Map<string, import('./types.js').LaneDefinition>} */
    const byName = new Map();

    for (const lane of lanes) {
        if (!isPlainObject(lane) || typeof lane.name !== 'string') {
            throw new ConfigError(`${scope.where}: "lanes" must be an array of lane definitions`);
        }

        const known = byName.get(lane.name);

        if (known && known !== lane) {
            throw new ConfigError(`${scope.where}: two different definitions of "${lane.name}" in "lanes"`);
        }

        byName.set(lane.name, /** @type {import('./types.js').LaneDefinition} */ (lane));
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

    checkObject(options, OPTION_NAMES, 'options', scope);

    if (!options.adapter) {
        throw new ConfigError('createSqlane: "adapter" is required');
    }

    const {
        adapter,
        tablePrefix = 'sqlane_',
        unknownLanes = 'allow',
        maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
    } = options;

    checkTablePrefix(tablePrefix, scope);
    checkInteger(maxPayloadBytes, '"maxPayloadBytes"', scope);

    if (unknownLanes !== 'allow' && unknownLanes !== 'reject') {
        throw new ConfigError(`createSqlane: "unknownLanes" must be 'allow' or 'reject'`);
    }

    const { localMaxConcurrency = 10, cleanup = true } = options;

    checkInteger(localMaxConcurrency, '"localMaxConcurrency"', scope);

    if (typeof cleanup !== 'boolean') {
        throw new ConfigError('createSqlane: "cleanup" must be a boolean');
    }

    const pollIntervalMs = checkDuration(options.pollInterval ?? '5s', '"pollInterval"', scope, true);
    const lanesByName = indexLanes(options.lanes ?? [], scope);
    const defaults = resolveDefaults(options.defaults);
    const registry = createRegistry({
        lanesByName,
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
    // Undocumented, for the tests of sqlane: in place of the version of package.json
    const { installedVersion } = /** @type {{ installedVersion?: string }} */ (options);
    const store = createStore(adapter, tablePrefix, options.logger);
    const runner = createRunner({
        store,
        registry,
        localMaxConcurrency,
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
        unknownLanes,
        defaults,
        maxPayloadBytes,
        notifyChannel,
    });
    /**
     * Wakes this process, sends the hint to the others.
     * @param {string} lane
     * @param {boolean} committed False: the commit is to come.
     */
    const wakeFor = (lane, committed) => {
        if (committed) {
            runner.onCommitted([lane]);
        } else {
            runner.onEnqueued([lane]);
        }

        // A process sends a hint only for the jobs that it cannot start itself
        if (!notifyChannel && !runner.canStartNow(lane)) {
            hintChannel.publish(lane);
        }
    };
    /**
     * After the commit when the adapter knows it, else at once.
     * @param {unknown} connection
     * @param {string} lane
     */
    const onCreated = (connection, lane) => {
        let hooked = false;

        try {
            hooked = adapter.afterCommit?.(/** @type {any} */ (connection), () => {
                try {
                    wakeFor(lane, true);
                } catch (error) {
                    reportError('after_commit', error);
                }
            }) ?? false;
        } catch (error) {
            reportError('after_commit', error);
        }

        if (!hooked) {
            wakeFor(lane, false);
        }
    };

    const scheduler = createScheduler({
        store,
        defaults,
        maxPayloadBytes,
        findDefinition: registry.findDefinition,
        unknownLanes,
        notifyChannel,
        onCreated: lane => wakeFor(lane, true),
        emit: runner.emit,
        logger: options.logger,
        timings: /** @type {{ schedules?: object }} */ (testTimings ?? {}).schedules,
    });
    /** @type {Promise<void> | null} */
    let startPromise = null;
    /** @type {Promise<void> | null} */
    let closePromise = null;
    /** @type {Promise<void> | null} The check of the server: once per instance, again after a failure */
    let serverChecked = null;

    /**
     * Checks the server once: the first `start()` or `schema.migrate()`, then their calls share the result.
     * @param {string} where The caller, for the errors.
     * @returns {Promise<void>}
     */
    function checkServerOnce(where) {
        serverChecked ??= (async () => {
            try {
                await checkServer(adapter, where, options.logger);
            } catch (error) {
                serverChecked = null;
                throw error;
            }
        })();

        return serverChecked;
    }

    /**
     * `schema.rollback()` and `schema.drop()`: on an instance that is not started, closed or draining. Their DDL would
     * wait behind the queries of this instance.
     * @param {string} where The caller, for the errors.
     */
    function checkSchemaChange(where) {
        if (runner.isClosed()) {
            throw new ClosedError(`${where} after close()`);
        }

        if (!runner.isIdle() || startPromise) {
            throw new ConfigError(`${where} while started or draining: run it on an instance that is not started`);
        }
    }

    /**
     * Registers the schedules, then starts the runner and the scheduler. Nothing runs before the runner starts: a
     * rejected start leaves no half-started instance.
     * @returns {Promise<void>}
     */
    async function startOnce() {
        scheduler.prepare();

        /** @type {(() => Promise<void>) | null} */
        let serverCheck = null;

        try {
            await checkServerOnce('start()');
        } catch (error) {
            if (error instanceof ConfigError) {
                throw error;
            }

            // The database is down: start anyway. The dispatcher checks again before its first turn, and claims
            // nothing before the check passes; the schedules register once it passes
            reportError('server_check', error);
            serverCheck = () => checkServerOnce('start()');
        }

        /** @type {import('./store/store.js').ScheduleRead | null} */
        let read = null;

        // After a failed check, the schedules wait for it: their registration and their fires write too, and a wrong
        // server gets none of them
        if (scheduler.size() > 0 && !serverCheck) {
            try {
                read = await scheduler.register();
            } catch (error) {
                if (isMissingTableError(error)) {
                    throw new ConfigError(
                        `start(): the table ${tablePrefix}schedules is missing: run schema.migrate()`,
                        { cause: error },
                    );
                }

                // The database is down: start anyway, the registration retries
                scheduler.reportFailure(error);
            }
        }

        // close() ran during the registration
        if (runner.isClosed()) {
            return;
        }

        if (serverCheck) {
            const check = serverCheck;

            // The dispatcher runs it before its first turn, again until it passes; never after a ConfigError
            await runner.start({
                serverCheck: async () => {
                    await check();

                    if (!runner.isClosed()) {
                        scheduler.startRegistering();
                    }
                },
            });

            return;
        }

        await runner.start();

        // close() ran during runner.start()
        if (!runner.isClosed()) {
            scheduler.start(read);
        }
    }

    return {
        enqueue: async (connection, lane, payload, enqueueOptions) => {
            const result = await enqueuer.enqueue(connection, lane, payload, enqueueOptions);

            if (result.created) {
                onCreated(connection, typeof lane === 'string' ? lane : lane.name);
            }

            return result;
        },
        enqueueMany: async (connection, lane, items) => {
            const results = await enqueuer.enqueueMany(connection, lane, items);

            if (results.some(result => result.created)) {
                onCreated(connection, typeof lane === 'string' ? lane : lane.name);
            }

            return results;
        },
        lanes: Object.freeze({
            /**
             * @param {import('./types.js').LaneDefinition | string} lane
             * @param {import('./types.js').Handler} handler
             * @param {unknown} [addOptions] None: the registry rejects any.
             */
            add(lane, handler, addOptions) {
                if (runner.isClosed()) {
                    throw new ClosedError('lanes.add() after close()');
                }

                if (runner.isStarted()) {
                    throw new ConfigError('lanes.add() after start(): add all the lanes before start()');
                }

                if (!runner.isIdle()) {
                    throw new ConfigError('lanes.add() during drain(): add all the lanes before drain()');
                }

                registry.add(lane, handler, addOptions);
            },
            stats: () => store.getStats(),
        }),
        schedule: (lane, scheduleOptions) => {
            if (runner.isClosed()) {
                throw new ClosedError('schedule() after close()');
            }

            if (!runner.isIdle() || startPromise) {
                throw new ConfigError('schedule() after start(): add all the schedules before start()');
            }

            const entry = checkSchedule(lane, scheduleOptions);

            entry.definition = isPlainObject(lane) ? /** @type {import('./types.js').LaneDefinition} */ (lane) : null;
            scheduler.add(entry);
        },
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
        // The runner closes at once: lanes.add() and start() then throw, and the deadline counts from the call. The
        // scheduler stops in parallel, and a pending registration of start() ends first.
        close: (closeOptions) => {
            closePromise ??= (async () => {
                const runnerClosed = runner.close(closeOptions);

                await Promise.all([scheduler.stop(), startPromise?.catch(() => {}), runnerClosed]);
            })();

            return closePromise;
        },
        schema: {
            migrate: async (migrateOptions) => {
                if (runner.isClosed()) {
                    throw new ClosedError('schema.migrate() after close()');
                }

                return {
                    applied: await runMigrations(adapter, tablePrefix, migrateOptions, {
                        checkServer: () => checkServerOnce('schema.migrate()'),
                        installedVersion,
                    }),
                };
            },
            rollback: async (rollbackOptions) => {
                checkSchemaChange('schema.rollback()');

                return {
                    reverted: await rollbackMigrations(adapter, tablePrefix, rollbackOptions, {
                        checkServer: () => checkServerOnce('schema.rollback()'),
                        installedVersion,
                    }),
                };
            },
            drop: async (dropOptions) => {
                checkSchemaChange('schema.drop()');

                return {
                    dropped: await dropTables(adapter, tablePrefix, dropOptions, {
                        checkServer: () => checkServerOnce('schema.drop()'),
                    }),
                };
            },
            getMigrationStatus: () => getMigrationStatus(adapter, tablePrefix, { installedVersion }),
            findSchemaProblems: () => findSchemaProblems(adapter, tablePrefix, { installedVersion }),
        },
        jobs: createJobsApi(store, createBulk({
            store,
            adapter,
            tablePrefix,
            wakeFor,
            unblockKeys: runner.unblockKeys,
            emit: runner.emit,
            reportError,
            notifyChannel,
        })),
        schedules: Object.freeze({ list: () => scheduler.list() }),
        wake: () => runner.wake(),
    };
}
