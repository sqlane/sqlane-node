import { expect, test } from 'vitest';
import { createSqlane } from './create_sqlane.js';
import { defineJob } from './define_job.js';
import { ClosedError, ConfigError } from './errors.js';

/** An adapter that is never called: the checks run before any SQL */
const adapter = /** @type {import('./types.js').Adapter<any>} */ ({ dialect: 'mysql' });
const withKeys = defineJob({ name: 'with_keys', mutexKeys: () => ['k'] });

/**
 * @param {Partial<import('./types.js').SqlaneOptions<any, 'heavy'>>} [options]
 * @returns {import('./types.js').Sqlane<any, 'heavy'>}
 */
function sqlaneWith(options = {}) {
    return createSqlane({ adapter, lanes: { heavy: { concurrency: 2 } }, ...options });
}

const noop = () => {};

test.each([
    ['an unknown lane', () => sqlaneWith().handle('a', noop, /** @type {any} */ ({ lane: 'light' }))],
    ['a lane and a concurrency', () => sqlaneWith().handle('a', noop, /** @type {any} */ ({ lane: 'heavy', concurrency: 2 }))],
    ['a concurrency of 0', () => sqlaneWith().handle('a', noop, { concurrency: 0 })],
    ['a bad timeout', () => sqlaneWith().handle('a', noop, { timeout: 'soon' })],
    ['an unknown option', () => sqlaneWith().handle('a', noop, /** @type {any} */ ({ retries: 3 }))],
    ['a handler that is not a function', () => sqlaneWith().handle('a', /** @type {any} */ ('handler'))],
    ['a bad name', () => sqlaneWith().handle('Bad', noop)],
    ['a definition with mutex keys without a timeout', () => sqlaneWith().handle(withKeys, noop)],
    ['a second handler of a name', () => {
        const sqlane = sqlaneWith();

        sqlane.handle('a', noop);
        sqlane.handle('a', noop);
    }],
    ['another definition of a name in "jobs"', () => {
        sqlaneWith({ jobs: [defineJob({ name: 'a' })] }).handle(defineJob({ name: 'a' }), noop);
    }],
    ['bad lanes', () => sqlaneWith({ lanes: /** @type {any} */ ({ heavy: { concurrency: -1 } }) })],
])('handle() throws ConfigError on %s', (_, func) => {
    expect(func).toThrow(ConfigError);
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

test('after close(): handle(), start() and drain() throw ClosedError', async () => {
    const sqlane = sqlaneWith();

    await sqlane.close({ deadline: 0 });

    expect(() => sqlane.handle('a', noop)).toThrow(ClosedError);
    await expect(sqlane.start()).rejects.toThrow(ClosedError);
    await expect(sqlane.drain()).rejects.toThrow(ClosedError);
});
