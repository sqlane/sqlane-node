// The runner of a process: the handlers and schedules that it mounts, and start(), drain() and close(). It runs over a
// sqlane: its database, its hint and its events. See docs/design.md.
import { isScheduleDefinition } from './define_schedule.js';
import { ClosedError, ConfigError, InvalidOptionsError } from './errors.js';
import { createMounts } from './mounts.js';
import { createRegistry } from './registry.js';
import { createRunner as createWorker } from './runner.js';
import { checkSchedule } from './schedule.js';
import { createScheduler } from './scheduler.js';
import { internalsOf } from './sqlane_internals.js';
import { isMissingTableError } from './transient_error.js';
import { checkInteger, checkObject, isPlainObject, NAME_REGEXP } from './validate.js';

/** @typedef {import('./sqlane.js').Runner} Runner */
/** @typedef {import('./sqlane.js').Mount} Mount */
/** @typedef {import('./types.js').RunnerOptions} RunnerOptions */
/** @typedef {import('./types.js').LaneRunStatus} LaneRunStatus */
/** @typedef {import('./types.js').ScheduleRunStatus} ScheduleRunStatus */

const RUNNER_OPTION_NAMES = ['localMaxConcurrency', 'logger'];

/**
 * The worker methods of the 9.x API, over the runner of a sqlane. Until 10.0.
 * @typedef {object} LegacyRunner
 * @property {(lane: import('./types.js').LaneDefinition | string, handler: import('./types.js').Handler,
 *     options?: unknown) => void} add `lanes.add()`.
 * @property {(lane: import('./types.js').LaneDefinition | string, options: unknown) => void} schedule
 * @property {() => Promise<void>} start
 * @property {(options?: import('./types.js').DrainOptions) => Promise<import('./types.js').DrainResult>} drain
 * @property {() => void} wake
 */

/**
 * @typedef {object} BuiltRunner
 * @property {import('./sqlane_internals.js').AttachedRunner} attached
 * @property {import('./mounts.js').Mounts} mounts
 * @property {ReturnType<typeof createWorker>} worker
 * @property {import('./registry.js').Registry} registry
 * @property {import('./scheduler.js').Scheduler} scheduler
 * @property {() => Promise<void>} start
 * @property {(options?: import('./types.js').CloseOptions) => Promise<void>} close
 * @property {() => boolean} isStarting A start() runs: its check of the server, its registration.
 */

/**
 * Builds the runner of a sqlane, and attaches it.
 * @param {import('./sqlane_internals.js').SqlaneInternals} core
 * @param {{ localMaxConcurrency: number, logger?: import('./types.js').Logger }} options
 * @returns {BuiltRunner}
 */
export function buildRunner(core, { localMaxConcurrency, logger = core.logger }) {
    const { store, defaults, hintChannel, tablePrefix, testTimings } = core;
    const registry = createRegistry({
        lanesByName: core.lanesByName,
        defaultTimeoutMs: defaults.timeoutMs,
    });
    const worker = createWorker({
        store,
        registry,
        localMaxConcurrency,
        defaults,
        cleanup: core.cleanup,
        logger,
        onEvent: core.onEvent,
        hintChannel,
        hintsAfterCommit: Boolean(core.adapter.notify),
        timings: { pollIntervalMs: core.pollIntervalMs, ...testTimings },
        // Undocumented, for the tests of sqlane: the random start of the tie pointer
        random: testTimings.random ?? Math.random,
    });
    const scheduler = createScheduler({
        store,
        defaults,
        maxPayloadBytes: core.maxPayloadBytes,
        findDefinition: registry.findDefinition,
        unknownLanes: core.unknownLanes,
        notifyChannel: core.notifyChannel,
        onCreated: lane => core.wakeFor(lane, true),
        emit: worker.emit,
        logger,
        timings: testTimings.schedules,
    });
    const mounts = createMounts({ registry, scheduler, runner: worker, known: core.lanesByName });
    /** @type {Promise<void> | null} */
    let startPromise = null;
    /** start() runs: its registration of the schedules writes */
    let starting = false;
    /** @type {Promise<void> | null} */
    let closePromise = null;

    /**
     * Registers the schedules, then starts the worker and the scheduler. Nothing runs before the worker starts: a
     * rejected start leaves no half-started runner.
     * @returns {Promise<void>}
     */
    async function startOnce() {
        scheduler.prepare();

        /** @type {(() => Promise<void>) | null} */
        let serverCheck = null;

        try {
            await core.checkServerOnce('start()');
        } catch (error) {
            if (error instanceof ConfigError) {
                throw error;
            }

            // The database is down: start anyway. The dispatcher checks again before its first turn, and claims
            // nothing before the check passes; the schedules register once it passes
            core.reportError('server_check', error);
            serverCheck = () => core.checkServerOnce('start()');
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
        if (worker.isClosed()) {
            return;
        }

        if (serverCheck) {
            const check = serverCheck;

            // The dispatcher runs it before its first turn, again until it passes; never after a ConfigError
            await worker.start({
                serverCheck: async () => {
                    await check();

                    if (!worker.isClosed()) {
                        scheduler.startRegistering();
                    }
                },
            });

            return;
        }

        await worker.start();

        // close() ran during worker.start()
        if (!worker.isClosed()) {
            scheduler.start(read);
        }
    }

    /** @returns {Promise<void>} */
    function start() {
        if (worker.isClosed()) {
            return Promise.reject(new ClosedError('start() after close()'));
        }

        if (!startPromise && !worker.isIdle()) {
            return worker.start();
        }

        startPromise ??= (async () => {
            starting = true;

            try {
                await startOnce();
            } catch (error) {
                startPromise = null;
                throw error;
            } finally {
                starting = false;
            }
        })();

        return startPromise;
    }

    /**
     * The worker closes at once: mounts and start() then throw, and the deadline counts from the call. The scheduler
     * stops in parallel, and a pending registration of start() ends first.
     * @param {import('./types.js').CloseOptions} [closeOptions]
     * @returns {Promise<void>}
     */
    function close(closeOptions) {
        closePromise ??= (async () => {
            const workerClosed = worker.close(closeOptions);

            await Promise.all([scheduler.stop(), startPromise?.catch(() => {}), workerClosed]);
        })();

        return closePromise;
    }

    /** @type {LegacyRunner} */
    const legacy = {
        add: (lane, handler, addOptions) => {
            if (worker.isClosed()) {
                throw new ClosedError('lanes.add() after close()');
            }

            if (worker.isStarted()) {
                throw new ConfigError('lanes.add() after start(): add all the lanes before start()');
            }

            if (!worker.isIdle()) {
                throw new ConfigError('lanes.add() during drain(): add all the lanes before drain()');
            }

            registry.add(lane, handler, addOptions);
        },
        schedule: (lane, scheduleOptions) => {
            if (worker.isClosed()) {
                throw new ClosedError('schedule() after close()');
            }

            if (!worker.isIdle() || startPromise) {
                throw new ConfigError('schedule() after start(): add all the schedules before start()');
            }

            const entry = checkSchedule(lane, scheduleOptions);

            entry.definition = isPlainObject(lane) ? /** @type {import('./types.js').LaneDefinition} */ (lane) : null;
            scheduler.add(entry);
        },
        start,
        drain: worker.drain,
        wake: () => worker.wake(),
    };

    /** @type {import('./sqlane_internals.js').AttachedRunner} */
    const attached = {
        onEnqueued: worker.onEnqueued,
        onCommitted: worker.onCommitted,
        canStartNow: worker.canStartNow,
        wake: worker.wakeLanes,
        isBusy: () => starting || worker.isBusy(),
        close,
        findDefinition: registry.findDefinition,
        schedules: scheduler.entries,
        legacy,
    };

    core.attach(attached);

    return { attached, mounts, worker, registry, scheduler, start, close, isStarting: () => starting };
}

/**
 * @param {unknown} lane
 * @param {string} where
 * @returns {string} The name of the lane.
 */
function laneNameOf(lane, where) {
    const name = isPlainObject(lane) ? lane.name : lane;

    if (typeof name !== 'string') {
        throw new InvalidOptionsError(`${where}: the lane must be a lane definition or a lane name`);
    }

    return name;
}

/**
 * Creates the runner of this process over a sqlane: it runs the handlers and fires the schedules that it mounts, in
 * `start()` (production) or `drain()` (tests). One runner per sqlane. Its events go to the `onEvent` of the sqlane.
 * @param {import('./types.js').Sqlane<any>} sqlane The sqlane, from `createSqlane()`: its database, hint and events.
 * @param {RunnerOptions} [options] `localMaxConcurrency` (default 10), `logger` (default: the sqlane's).
 * @returns {Runner}
 */
export function createRunner(sqlane, options = {}) {
    const where = 'createRunner()';
    const core = internalsOf(sqlane, where);
    const scope = { where, ErrorClass: ConfigError };

    checkObject(options, RUNNER_OPTION_NAMES, 'options', scope);

    const { localMaxConcurrency = 10, logger = core.logger } = options;

    checkInteger(localMaxConcurrency, '"localMaxConcurrency"', scope);

    if (core.isClosed()) {
        throw new ClosedError(`${where} after sqlane.close()`);
    }

    const built = buildRunner(core, { localMaxConcurrency, logger });
    const { worker, mounts, registry, scheduler } = built;

    /**
     * @param {string} method
     */
    function checkMountable(method) {
        if (worker.isClosed()) {
            throw new ClosedError(`${method} after close()`);
        }

        if (worker.isDraining()) {
            throw new ConfigError(`${method} during drain(): mount and unmount before drain() or after it`);
        }
    }

    /** @type {Runner} */
    const runner = {
        mount: (parts) => {
            checkMountable('mount()');

            const handle = mounts.mount(parts);

            return Object.freeze({
                unmount: () => {
                    if (!worker.isClosed()) {
                        checkMountable('unmount()');
                    }

                    handle.unmount();
                },
            });
        },
        pauseLocally: (lane) => {
            worker.pauseLocally(laneNameOf(lane, 'pauseLocally()'));
        },
        resumeLocally: (lane) => {
            worker.resumeLocally(laneNameOf(lane, 'resumeLocally()'));
        },
        getStatus: /** @type {Runner['getStatus']} */ (/** @type {unknown} */ ((
            /** @type {unknown} */ target,
        ) => {
            if (isScheduleDefinition(target) || (typeof target === 'string' && target.includes(':'))) {
                const id = typeof target === 'string' ? target : target.id;

                return { mounted: scheduler.has(id) };
            }

            const name = laneNameOf(target, 'getStatus()');

            return {
                mounted: NAME_REGEXP.test(name) && registry.getEntry(name) !== undefined,
                pausedLocally: worker.isPausedLocally(name),
                running: registry.runningOf(name),
            };
        })),
        start: async () => {
            if (worker.isDraining()) {
                throw new ConfigError('start() during drain(): start the runner after drain()');
            }

            return built.start();
        },
        drain: async (drainOptions) => {
            if (worker.isStarted() || built.isStarting()) {
                throw new ConfigError('drain() after start(): drain() is for tests, without start()');
            }

            return worker.drain(drainOptions);
        },
        close: built.close,
    };

    return Object.freeze(runner);
}
