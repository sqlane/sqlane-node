import { resolveDefaults } from './defaults.js';
import { createEnqueuer } from './enqueue.js';
import { createHintChannel } from './hint_channel.js';
import { ClosedError, ConfigError } from './errors.js';
import { createGlobalPauses } from './global_pauses.js';
import { dropTables, rollbackMigrations, runMigrations } from './migrations.js';
import { findSchemaProblems, getMigrationStatus } from './schema_status.js';
import { DEFAULT_MAX_PAYLOAD_BYTES } from './payload.js';
import { createRunSlot } from './run_slot.js';
import { listSchedules } from './schedule_list.js';
import { checkServer } from './server_check.js';
import { createJobsApi } from './jobs_api.js';
import { createBulk } from './jobs_bulk.js';
import { setInternals } from './sqlane_internals.js';
import { createStore } from './store/store.js';
import { checkDuration, checkInteger, checkObject, checkTablePrefix, isPlainObject } from './validate.js';

const OPTION_NAMES = [
    'adapter', 'defaults', 'hint', 'logger', 'onEvent', 'tablePrefix', 'pollInterval', 'maxPayloadBytes', 'cleanup',
    'timings', 'installedVersion',
];

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
 * Creates a sqlane: the database side, for every process. It connects, migrates and starts nothing. A process that
 * runs jobs adds a runner over it: `createRunner()`.
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

    const { adapter, tablePrefix = 'sqlane_', maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES, cleanup = true } = options;

    checkTablePrefix(tablePrefix, scope);
    checkInteger(maxPayloadBytes, '"maxPayloadBytes"', scope);

    if (typeof cleanup !== 'boolean') {
        throw new ConfigError('createSqlane: "cleanup" must be a boolean');
    }

    const pollIntervalMs = checkDuration(options.pollInterval ?? '5s', '"pollInterval"', scope, true);
    const defaults = resolveDefaults(options.defaults);
    const hint = resolveHint(adapter, options.hint);
    const { logger, onEvent } = options;
    /**
     * An error of an optimization (hints, wakes): logged as a warning, never thrown.
     * @param {string} operation
     * @param {unknown} error
     */
    const reportError = (operation, error) => {
        logger?.warn({ error, operation }, `sqlane: ${operation} failed`);
        onEvent?.({ type: 'error', operation, error });
    };
    /**
     * Calls `onEvent`; logs what it throws.
     * @param {import('./types.js').SqlaneEvent} event
     */
    const emit = (event) => {
        try {
            onEvent?.(event);
        } catch (error) {
            logger?.error({ error }, 'sqlane: onEvent threw');
        }
    };
    const hintChannel = createHintChannel({ hint, channel: `${tablePrefix}ready`, reportError });
    // NOTIFY in the enqueue transaction: no publish after the enqueue
    const notifyChannel = adapter.notify ? `${tablePrefix}ready` : null;
    // Undocumented, for the tests of sqlane
    const testTimings = /** @type {{ timings?: Record<string, any> }} */ (options).timings ?? {};
    // Undocumented, for the tests of sqlane: in place of the version of package.json
    const { installedVersion } = /** @type {{ installedVersion?: string }} */ (options);
    const store = createStore(adapter, tablePrefix, logger, { pausedSeenMs: pollIntervalMs });
    /** @type {import('./sqlane_internals.js').AttachedRunner | null} The runner of this process, if any */
    let attached = null;
    let closed = false;
    /** @type {Promise<void> | null} */
    let closePromise = null;
    const enqueuer = createEnqueuer({
        adapter,
        tablePrefix,
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
            attached?.onCommitted([lane]);
        } else {
            attached?.onEnqueued([lane]);
        }

        // A process sends a hint only for the jobs that it cannot start itself
        if (!notifyChannel && !attached?.canStartNow(lane)) {
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

    /**
     * Makes pending the jobs blocked on the concurrency keys, as far as the keys have room, and wakes their lanes here
     * and in the other processes. Never rejects: an error is reported.
     * @param {string[]} keys
     * @returns {Promise<void>}
     */
    async function unblockKeys(keys) {
        try {
            const lanes = await store.unblock([...new Set(keys)]);

            if (lanes.length) {
                attached?.wake(lanes);

                for (const lane of lanes) {
                    hintChannel.publish(lane);
                }
            }
        } catch (error) {
            logger?.error({ error, operation: 'unblock' }, 'sqlane: unblock failed');
            emit({ type: 'error', operation: 'unblock', error });
        }
    }

    const pauses = createGlobalPauses({
        store,
        adapter,
        attached: () => attached,
        hintChannel,
        unblockKeys,
        reportError,
        isClosed: () => closed,
    });
    const runSlot = createRunSlot({
        enqueuer,
        defaults,
        maxPayloadBytes,
        // No connection: committed on the queue's pool
        onCreated: (connection, lane) => (connection === undefined ? wakeFor(lane, true) : onCreated(connection, lane)),
    });

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
                await checkServer(adapter, where, logger);
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
        if (closed) {
            throw new ClosedError(`${where} after close()`);
        }

        if (attached?.isBusy()) {
            throw new ConfigError(`${where} while started or draining: run it on an instance that is not started`);
        }
    }

    /** @type {import('./sqlane_internals.js').SqlaneInternals} */
    const internals = {
        adapter,
        tablePrefix,
        store,
        defaults,
        maxPayloadBytes,
        pollIntervalMs,
        cleanup,
        testTimings,
        logger,
        onEvent,
        hintChannel,
        notifyChannel,
        wakeFor,
        reportError,
        checkServerOnce,
        isClosed: () => closed,
        attach: (runner) => {
            if (attached) {
                throw new ConfigError('createRunner(): this sqlane has a runner already: one runner per sqlane');
            }

            attached = runner;
        },
    };

    /** @type {import('./types.js').Sqlane<C>} */
    const sqlane = {
        enqueue: async (connection, lane, payload, enqueueOptions) => {
            const result = await enqueuer.enqueue(connection, lane, payload, enqueueOptions);

            if (result.created) {
                onCreated(connection, lane.name);
            }

            return result;
        },
        enqueueMany: async (connection, lane, items) => {
            const results = await enqueuer.enqueueMany(connection, lane, items);

            if (results.some(result => result.created)) {
                onCreated(connection, lane.name);
            }

            return results;
        },
        lanes: Object.freeze({ ...pauses.lanes }),
        // The runner closes at once: its mounts and start() then throw, and the deadline counts from the call. Then
        // the hint stops.
        close: (closeOptions) => {
            closed = true;
            closePromise ??= (async () => {
                await attached?.close(closeOptions);
                await hintChannel.stop();
            })();

            return closePromise;
        },
        schema: {
            migrate: async (migrateOptions) => {
                if (closed) {
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
            unblockKeys,
            emit,
            reportError,
            notifyChannel,
        })),
        schedules: Object.freeze({
            list: () => listSchedules({ store, local: attached?.schedules() ?? new Map() }),
            runSlot,
            ...pauses.schedules,
        }),
    };

    setInternals(sqlane, internals);

    return sqlane;
}
