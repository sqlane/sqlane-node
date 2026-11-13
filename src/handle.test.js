import { expect, test } from 'vitest';
import { createSqlane } from './create_sqlane.js';
import { defineConcurrencyGroup } from './define_concurrency_group.js';
import { defineJob } from './define_job.js';
import { ClosedError, ConfigError } from './errors.js';

/** An adapter that is never called: the checks run before any SQL */
const adapter = /** @type {import('./types.js').Adapter<any>} */ ({ dialect: 'mysql' });
const withKeys = defineJob({ name: 'with_keys', mutexKeys: () => ['k'] });

/**
 * @param {Partial<import('./types.js').SqlaneOptions<any>>} [options]
 * @returns {import('./types.js').Sqlane<any>}
 */
function sqlaneWith(options = {}) {
    return createSqlane({ adapter, maxConcurrency: 10, ...options });
}

const noop = () => {};
const heavy = defineConcurrencyGroup({ name: 'heavy', maxConcurrency: 2 });

test.each([
    ['the concurrency of 4.x', () => sqlaneWith().handle('a', noop, /** @type {any} */ ({ concurrency: 2 })),
        'handle("a"): "concurrency" is now "maxConcurrency" (5.0)'],
    ['the lane of 4.x', () => sqlaneWith().handle('a', noop, /** @type {any} */ ({ lane: 'heavy' })),
        'handle("a"): "lane" was removed in 5.0: use "concurrencyGroup"'],
    ['a weight of 0', () => sqlaneWith().handle('a', noop, { fairShareWeight: 0 }),
        'handle("a"): "fairShareWeight" must be an integer from 1 to 1000'],
    ['a weight of 1001', () => sqlaneWith().handle('a', noop, { fairShareWeight: 1001 }),
        'handle("a"): "fairShareWeight" must be an integer from 1 to 1000'],
    ['a weight of null', () => sqlaneWith().handle('a', noop, /** @type {any} */ ({ fairShareWeight: null })),
        'handle("a"): "fairShareWeight" must be an integer from 1 to 1000'],
    ['a fractional weight', () => sqlaneWith().handle('a', noop, { fairShareWeight: 1.5 }),
        'handle("a"): "fairShareWeight" must be an integer from 1 to 1000'],
    ['a group that is not from defineConcurrencyGroup()', () => sqlaneWith().handle('a', noop, /** @type {any} */ ({
        concurrencyGroup: { name: 'heavy', maxConcurrency: 2 },
    })), 'handle("a"): "concurrencyGroup" must be a group from defineConcurrencyGroup()'],
    ['two groups with one name', () => {
        const sqlane = sqlaneWith();

        sqlane.handle('a', noop, { concurrencyGroup: heavy });
        sqlane.handle('b', noop, { concurrencyGroup: defineConcurrencyGroup({ name: 'heavy', maxConcurrency: 3 }) });
    }, 'handle("b"): another concurrency group is named "heavy"'],
    ['a maxConcurrency of 0', () => sqlaneWith().handle('a', noop, { maxConcurrency: 0 }), '"maxConcurrency"'],
    ['a bad timeout', () => sqlaneWith().handle('a', noop, { timeout: 'soon' }), '"timeout"'],
    ['an unknown option', () => sqlaneWith().handle('a', noop, /** @type {any} */ ({ retries: 3 })),
        'unknown options: retries'],
    ['a handler that is not a function', () => sqlaneWith().handle('a', /** @type {any} */ ('handler')),
        'the handler must be a function'],
    ['a bad name', () => sqlaneWith().handle('Bad', noop), 'the job must be a job definition or a job name'],
    ['a definition with mutex keys without a timeout', () => sqlaneWith().handle(withKeys, noop), 'needs a timeout'],
    ['a second handler of a name', () => {
        const sqlane = sqlaneWith();

        sqlane.handle('a', noop);
        sqlane.handle('a', noop);
    }, 'the job is handled already'],
    ['another definition of a name in "jobs"', () => {
        sqlaneWith({ jobs: [defineJob({ name: 'a' })] }).handle(defineJob({ name: 'a' }), noop);
    }, 'another definition of "a" is in "jobs"'],
    ['the concurrency of createSqlane() in 4.x', () => createSqlane(/** @type {any} */ ({ adapter, concurrency: 5 })),
        'createSqlane: "concurrency" is now "maxConcurrency" (5.0)'],
    ['the lanes of createSqlane() in 4.x', () => createSqlane(/** @type {any} */ ({ adapter, lanes: {} })),
        'createSqlane: "lanes" was removed in 5.0: define groups with defineConcurrencyGroup() and pass them to handle() as "concurrencyGroup"'],
])('handle() and createSqlane() throw ConfigError on %s', (_, func, message) => {
    expect(func).toThrow(ConfigError);
    expect(func).toThrow(message);
});

test('one group object shared by several handlers, combined with a maxConcurrency and a weight', () => {
    const sqlane = sqlaneWith();

    expect(() => {
        sqlane.handle('a', noop, { concurrencyGroup: heavy, maxConcurrency: 1, fairShareWeight: 2 });
        sqlane.handle('b', noop, { concurrencyGroup: heavy });
    }).not.toThrow();
});

test.each([
    ['start()', (/** @type {import('./types.js').Sqlane<any>} */ sqlane) => sqlane.start()],
    ['drain()', (/** @type {import('./types.js').Sqlane<any>} */ sqlane) => sqlane.drain()],
])('%s throws a ConfigError for a cap above the instance\'s, naming the handler or the group', async (where, run) => {
    const handlerCap = sqlaneWith();
    const groupCap = sqlaneWith();

    handlerCap.handle('transcode', noop, { maxConcurrency: 16 });
    groupCap.handle('render', noop, { concurrencyGroup: defineConcurrencyGroup({ name: 'wide', maxConcurrency: 20 }) });

    await expect(run(handlerCap)).rejects.toThrow(
        `${where}: the maxConcurrency of handle("transcode") (16) is above the instance's maxConcurrency (10)`,
    );
    await expect(run(groupCap)).rejects.toThrow(
        `${where}: the maxConcurrency of the concurrency group "wide" (20) is above the instance's maxConcurrency (10)`,
    );
});

test('a definition with mutex keys takes its timeout from handle() or the defaults', () => {
    expect(() => sqlaneWith().handle(withKeys, noop, { timeout: '1m' })).not.toThrow();
    expect(() => sqlaneWith({ defaults: { timeout: '1m' } }).handle(withKeys, noop)).not.toThrow();
});

test.each([
    ['a failure job that is not known', [defineJob({ name: 'a', failureJob: 'a_failed' })]],
    ['a failure job with a failure job of its own', [
        defineJob({ name: 'a', failureJob: defineJob({ name: 'a_failed', failureJob: 'other' }) }),
    ]],
])('start() and drain() throw ConfigError on %s', async (_, [definition]) => {
    const sqlane = sqlaneWith();

    sqlane.handle(definition, noop);

    await expect(sqlane.start()).rejects.toThrow(ConfigError);
    await expect(sqlane.drain()).rejects.toThrow(ConfigError);
});

test('a failure job in "jobs" or handled resolves', async () => {
    const sqlane = sqlaneWith({ jobs: [defineJob({ name: 'b_failed' })] });

    sqlane.handle(defineJob({ name: 'a', failureJob: 'a_failed' }), noop);
    sqlane.handle('a_failed', noop);
    sqlane.handle(defineJob({ name: 'b', failureJob: 'b_failed' }), noop);

    // The dispatcher fails on the fake adapter: it reports the error and goes on, until close()
    await expect(sqlane.start()).resolves.toBeUndefined();
    await sqlane.close({ deadline: 0 });
});

test('handle() after start() throws ConfigError', async () => {
    const sqlane = sqlaneWith();

    await sqlane.start();

    expect(() => sqlane.handle('a', noop)).toThrow(ConfigError);
    await sqlane.close({ deadline: 0 });
});

test('handle() during drain() throws ConfigError', async () => {
    const sqlane = sqlaneWith();
    // No handler: nothing to drain
    const draining = sqlane.drain({ timeout: '1s' });

    expect(() => sqlane.handle('a', noop))
        .toThrow('handle() during drain(): register all the handlers before drain()');
    await expect(draining).resolves.toStrictEqual({ completed: 0, retried: 0, failed: 0 });
    await sqlane.close({ deadline: 0 });
});

test('after close(): handle(), start() and drain() throw ClosedError', async () => {
    const sqlane = sqlaneWith();

    await sqlane.close({ deadline: 0 });

    expect(() => sqlane.handle('a', noop)).toThrow(ClosedError);
    await expect(sqlane.start()).rejects.toThrow(ClosedError);
    await expect(sqlane.drain()).rejects.toThrow(ClosedError);
});
