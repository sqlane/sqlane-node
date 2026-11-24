import { describe, expect, test, vi } from 'vitest';
import { createRunner } from './create_runner.js';
import { createSqlane } from './create_sqlane.js';
import { defineHandler } from './define_handler.js';
import { defineLane } from './define_lane.js';
import { defineSchedule } from './define_schedule.js';
import { ClosedError, ConfigError, InvalidOptionsError } from './errors.js';

/**
 * An adapter over a PostgreSQL 18 with no rows: every statement gives none.
 * @returns {import('./types.js').Adapter<any>}
 */
function fakeAdapter() {
    /** @type {import('./types.js').Executor} */
    const executor = {
        query: async sql => (sql === 'SELECT VERSION() AS version' ? [{ version: 'PostgreSQL 18.6 on x86_64' }] : []),
        run: async () => 0,
    };

    return /** @type {import('./types.js').Adapter<any>} */ (/** @type {unknown} */ ({
        dialect: 'postgres',
        queue: executor,
        queueTransaction: (/** @type {(executor: unknown) => Promise<unknown>} */ func) => func(executor),
        withConnection: (/** @type {(executor: unknown) => Promise<unknown>} */ func) => func(executor),
        inTransaction: (/** @type {unknown} */ _connection, /** @type {(executor: unknown) => unknown} */ func) => (
            func(executor)
        ),
    }));
}

/**
 * The inserts of the adapter give a job: an enqueue creates it.
 * @param {import('./types.js').Adapter<any>} adapter
 * @param {string} id
 */
function insertGives(adapter, id) {
    const { query } = adapter.queue;

    adapter.queue.query = async (sql, params) => (sql.includes('INSERT') ? [{ id }] : query(sql, params));
}

const report = defineLane({ name: 'report' });
const daily = defineSchedule(report, { key: 'daily', cron: '0 6 * * *' });

describe('createRunner', () => {
    test('one runner per sqlane: a second one is a ConfigError', () => {
        const sqlane = createSqlane({ adapter: fakeAdapter() });

        createRunner(sqlane);
        expect(() => createRunner(sqlane)).toThrow(new ConfigError(
            'createRunner(): this sqlane has a runner already: one runner per sqlane',
        ));
    });

    test('a sqlane that createSqlane() of this copy of the package did not make: a ConfigError', () => {
        expect(() => createRunner(/** @type {any} */ ({ enqueue: () => {} }))).toThrow(ConfigError);
        expect(() => createRunner(/** @type {any} */ (null))).toThrow('from this copy of @sqlane/core');
    });

    test.each([
        ['an unknown option', { pollInterval: '1s' }, 'unknown options: pollInterval'],
        ['a localMaxConcurrency of 0', { localMaxConcurrency: 0 }, '"localMaxConcurrency" must be an integer'],
    ])('%s: a ConfigError', (_, options, message) => {
        const sqlane = createSqlane({ adapter: fakeAdapter() });

        expect(() => createRunner(sqlane, /** @type {any} */ (options))).toThrow(ConfigError);
        expect(() => createRunner(sqlane, /** @type {any} */ (options))).toThrow(message);
    });

    test('after sqlane.close(): a ClosedError', async () => {
        const sqlane = createSqlane({ adapter: fakeAdapter() });

        await sqlane.close();
        expect(() => createRunner(sqlane)).toThrow(new ClosedError('createRunner() after sqlane.close()'));
    });

    test('the logger of the sqlane by default; its own when given', async () => {
        const sqlaneLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const runnerLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        // No database: each check of the server fails, and the dispatcher logs it
        const adapter = /** @type {import('./types.js').Adapter<any>} */ ({ dialect: 'mysql' });
        const first = createRunner(createSqlane({ adapter, logger: sqlaneLogger, pollInterval: '100ms' }));
        const second = createRunner(createSqlane({ adapter, logger: sqlaneLogger, pollInterval: '100ms' }), {
            logger: runnerLogger,
        });

        first.mount([defineHandler(report, () => {})]);
        second.mount([defineHandler(report, () => {})]);
        await Promise.all([first.start(), second.start()]);
        await vi.waitFor(() => {
            expect(runnerLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ operation: 'server_check' }),
                'sqlane: server_check failed',
            );
        });
        expect(sqlaneLogger.error.mock.calls.filter(([details]) => details.operation === 'server_check'))
            .not.toHaveLength(0);
        await Promise.all([first.close({ deadline: 0 }), second.close({ deadline: 0 })]);
    });
});

describe('the rules of a runner', () => {
    test('start() during drain(): a ConfigError', async () => {
        const runner = createRunner(createSqlane({ adapter: fakeAdapter() }));

        runner.mount([defineHandler(report, () => {})]);

        const draining = runner.drain({ timeout: '1s' });

        await expect(runner.start()).rejects.toThrow(new ConfigError(
            'start() during drain(): start the runner after drain()',
        ));
        await draining;
        await runner.start();
        await runner.close({ deadline: 0 });
    });

    test('mount() and unmount() during drain(): a ConfigError; drain() after start(): a ConfigError', async () => {
        const runner = createRunner(createSqlane({ adapter: fakeAdapter() }));
        const mount = runner.mount([defineHandler(report, () => {})]);
        const draining = runner.drain({ timeout: '1s' });

        expect(() => runner.mount([daily])).toThrow(new ConfigError(
            'mount() during drain(): mount and unmount before drain() or after it',
        ));
        expect(() => mount.unmount()).toThrow(ConfigError);
        await draining;
        await runner.start();
        await expect(runner.drain()).rejects.toThrow(new ConfigError(
            'drain() after start(): drain() is for tests, without start()',
        ));
        expect(() => mount.unmount()).not.toThrow();
        await runner.close({ deadline: 0 });
    });

    test('drain() while start() is pending: a ConfigError', async () => {
        const adapter = fakeAdapter();
        const held = Promise.withResolvers();
        const { query } = adapter.queue;

        // The server check of start() waits
        adapter.queue.query = async (sql, params) => {
            await held.promise;

            return query(sql, params);
        };

        const runner = createRunner(createSqlane({ adapter }));
        const starting = runner.start();

        await expect(runner.drain()).rejects.toThrow(new ConfigError(
            'drain() after start(): drain() is for tests, without start()',
        ));
        held.resolve(undefined);
        await starting;
        await runner.close({ deadline: 0 });
    });

    test('after close(), or after sqlane.close(): mount() is a ClosedError; unmount() does nothing', async () => {
        const sqlane = createSqlane({ adapter: fakeAdapter() });
        const runner = createRunner(sqlane);
        const mount = runner.mount([defineHandler(report, () => {})]);

        await runner.close({ deadline: 0 });
        expect(() => runner.mount([daily])).toThrow(new ClosedError('mount() after close()'));
        expect(() => mount.unmount()).not.toThrow();
        await expect(runner.start()).rejects.toThrow(ClosedError);

        const other = createSqlane({ adapter: fakeAdapter() });
        const otherRunner = createRunner(other);

        await other.close({ deadline: 0 });
        expect(() => otherRunner.mount([daily])).toThrow(ClosedError);
    });

    test('pauseLocally() of a value that is not a lane: an InvalidOptionsError', () => {
        const runner = createRunner(createSqlane({ adapter: fakeAdapter() }));

        expect(() => runner.pauseLocally(/** @type {any} */ (3))).toThrow(InvalidOptionsError);
    });
});

describe('getStatus', () => {
    test('a lane: mounted, paused here, its running jobs; a typo: not mounted', () => {
        const runner = createRunner(createSqlane({ adapter: fakeAdapter() }));

        expect(runner.getStatus(report)).toStrictEqual({ mounted: false, pausedLocally: false, running: 0 });

        const mount = runner.mount([defineHandler(report, () => {})]);

        runner.pauseLocally('report');
        expect(runner.getStatus(report)).toStrictEqual({ mounted: true, pausedLocally: true, running: 0 });
        expect(runner.getStatus('report')).toStrictEqual({ mounted: true, pausedLocally: true, running: 0 });
        expect(runner.getStatus('unknown_lane')).toStrictEqual({ mounted: false, pausedLocally: false, running: 0 });
        mount.unmount();
        runner.resumeLocally(report);
        expect(runner.getStatus(report)).toStrictEqual({ mounted: false, pausedLocally: false, running: 0 });
    });

    test('a schedule: by definition or id; a typo: not mounted', () => {
        const runner = createRunner(createSqlane({ adapter: fakeAdapter() }));
        const mount = runner.mount([daily]);

        expect(runner.getStatus(daily)).toStrictEqual({ mounted: true });
        expect(runner.getStatus('report:daily')).toStrictEqual({ mounted: true });
        expect(runner.getStatus('report:nightly')).toStrictEqual({ mounted: false });
        // A schedule mounts without the handler of its lane
        expect(runner.getStatus(report).mounted).toBe(false);
        mount.unmount();
        expect(runner.getStatus(daily)).toStrictEqual({ mounted: false });
    });
});

/**
 * @returns {{ hint: import('./types.js').Hint, published: string[], unsubscribed: () => number }}
 */
function recordedHint() {
    /** @type {string[]} */
    const published = [];
    let unsubscribed = 0;

    return {
        hint: {
            publish: async (_channel, message) => {
                published.push(message);
            },
            subscribe: async () => async () => {
                unsubscribed++;
            },
        },
        published,
        unsubscribed: () => unsubscribed,
    };
}

describe('close', () => {
    test('runner.close(): the runner stops listening to the hint; the enqueues of the sqlane still send it', async () => {
        const { hint, published, unsubscribed } = recordedHint();
        const adapter = fakeAdapter();

        insertGives(adapter, 'report:k');
        const sqlane = createSqlane({ adapter, hint });
        const runner = createRunner(sqlane);

        await runner.start();
        await runner.close({ deadline: 0 });
        expect(unsubscribed()).toBe(1);
        await sqlane.enqueue({}, report, {}, { dedupeKey: 'k' });
        expect(published).toStrictEqual(['report']);
        await sqlane.close();
        expect(unsubscribed()).toBe(1);
    });

    test('sqlane.close(): closes the runner, then the hint', async () => {
        const { hint, unsubscribed } = recordedHint();
        const sqlane = createSqlane({ adapter: fakeAdapter(), hint });
        const runner = createRunner(sqlane);

        await runner.start();
        await sqlane.close({ deadline: 0 });
        expect(unsubscribed()).toBe(1);
        expect(() => runner.mount([daily])).toThrow(ClosedError);
    });
});
