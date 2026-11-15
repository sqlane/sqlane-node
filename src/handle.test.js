import { expect, test } from 'vitest';
import { createSqlane } from './create_sqlane.js';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
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
    return createSqlane({ adapter, localMaxConcurrency: 10, ...options });
}

const noop = () => {};
const heavy = defineConcurrencyLimit({ name: 'heavy', max: 2 });

const MOVED = 'handle() takes no options since 6.0: set "timeout" and "fairShareWeight" in defineJob(), and replace '
    + '"maxConcurrency" and "concurrencyGroup" with "localConcurrencyLimits"';

test.each([
    ['the options of 5.x', () => /** @type {any} */ (sqlaneWith()).handle('a', noop, { maxConcurrency: 2 }),
        `handle("a"): ${MOVED}`],
    ['empty options', () => /** @type {any} */ (sqlaneWith()).handle('a', noop, {}), `handle("a"): ${MOVED}`],
    ['two limits with one name and different maxes', () => {
        const sqlane = sqlaneWith();

        sqlane.handle(defineJob({ name: 'a', localConcurrencyLimits: [heavy] }), noop);
        sqlane.handle(defineJob({
            name: 'b',
            localConcurrencyLimits: [defineConcurrencyLimit({ name: 'heavy', max: 3 })],
        }), noop);
    }, 'handle("b"): the concurrency limit "heavy" has the max 3 here and 2 in another definition'],
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
        'createSqlane: "concurrency" is now "localMaxConcurrency" (6.0)'],
    ['the maxConcurrency of createSqlane() in 5.x', () => createSqlane(/** @type {any} */ ({ adapter, maxConcurrency: 5 })),
        'createSqlane: "maxConcurrency" is now "localMaxConcurrency" (6.0)'],
    ['the lanes of createSqlane() in 4.x', () => createSqlane(/** @type {any} */ ({ adapter, lanes: {} })),
        'createSqlane: "lanes" was removed in 5.0: define limits with defineConcurrencyLimit() and list them in a job definition\'s "localConcurrencyLimits"'],
])('handle() and createSqlane() throw ConfigError on %s', (_, func, message) => {
    expect(func).toThrow(ConfigError);
    expect(func).toThrow(message);
});

test('one limit shared by several definitions; limits with one name and one max are one limit', () => {
    const sqlane = sqlaneWith();

    expect(() => {
        sqlane.handle(defineJob({ name: 'a', localConcurrencyLimits: [heavy], fairShareWeight: 2 }), noop);
        sqlane.handle(defineJob({ name: 'b', localConcurrencyLimits: [heavy] }), noop);
        sqlane.handle(defineJob({
            name: 'c',
            localConcurrencyLimits: [defineConcurrencyLimit({ name: 'heavy', max: 2 })],
        }), noop);
    }).not.toThrow();
});

test('start() accepts a local limit above the instance\'s cap: the lower one applies', async () => {
    const sqlane = sqlaneWith({ localMaxConcurrency: 2 });
    const wide = defineConcurrencyLimit({ name: 'wide', max: 20 });

    sqlane.handle(defineJob({ name: 'a', localConcurrencyLimits: [wide] }), noop);

    // The dispatcher fails on the fake adapter: it reports the error and goes on, until close()
    await expect(sqlane.start()).resolves.toBeUndefined();
    await sqlane.close({ deadline: 0 });
});

test('a definition with mutex keys takes its timeout from the definition or the defaults', () => {
    expect(() => sqlaneWith().handle(defineJob({ name: 'k', mutexKeys: () => ['k'], timeout: '1m' }), noop)).not.toThrow();
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
