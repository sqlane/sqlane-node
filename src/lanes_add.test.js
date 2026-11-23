import { expect, test } from 'vitest';
import { createSqlane } from './create_sqlane.js';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
import { defineLane } from './define_lane.js';
import { defineRateLimit } from './define_rate_limit.js';
import { ClosedError, ConfigError } from './errors.js';
import { createRegistry } from './registry.js';

/** An adapter that is never called: the checks run before any SQL */
const adapter = /** @type {import('./types.js').Adapter<any>} */ ({ dialect: 'mysql' });
const withKeys = defineLane({ name: 'with_keys', globalConcurrencyLimits: () => [] });

/**
 * @param {Partial<import('./types.js').SqlaneOptions<any>>} [options]
 * @returns {import('./types.js').Sqlane<any>}
 */
function sqlaneWith(options = {}) {
    return createSqlane({ adapter, localMaxConcurrency: 10, ...options });
}

const noop = () => {};
const heavy = defineConcurrencyLimit({ name: 'heavy', max: 2 });

test.each([
    ['options', () => /** @type {any} */ (sqlaneWith()).lanes.add('a', noop, { maxConcurrency: 2 }),
        'lanes.add("a"): lanes.add() takes no options'],
    ['empty options', () => /** @type {any} */ (sqlaneWith()).lanes.add('a', noop, {}),
        'lanes.add("a"): lanes.add() takes no options'],
    ['two limits with one name and different maxes', () => {
        const sqlane = sqlaneWith();

        sqlane.lanes.add(defineLane({ name: 'a', localConcurrencyLimits: [heavy] }), noop);
        sqlane.lanes.add(defineLane({
            name: 'b',
            localConcurrencyLimits: [defineConcurrencyLimit({ name: 'heavy', max: 3 })],
        }), noop);
    }, 'lanes.add("b"): the concurrency limit "heavy" has the max 3 here and 2 in another definition'],
    ['two rate limits with one name and different settings', () => {
        const sqlane = sqlaneWith();

        sqlane.lanes.add(defineLane({
            name: 'a',
            localRateLimits: [defineRateLimit({ name: 'disk', max: 10, per: '1s' })],
        }), noop);
        sqlane.lanes.add(defineLane({
            name: 'b',
            localRateLimits: [defineRateLimit({ name: 'disk', max: 10, per: '1s', burst: 5 })],
        }), noop);
    }, 'lanes.add("b"): the rate limit "disk" has max 10 per 1000 ms, burst 5 here and max 10 per 1000 ms, burst 1 in '
    + 'another definition'],
    ['a handler that is not a function', () => sqlaneWith().lanes.add('a', /** @type {any} */ ('handler')),
        'the handler must be a function'],
    ['a bad name', () => sqlaneWith().lanes.add('Bad', noop), 'the lane must be a lane definition or a lane name'],
    ['a definition with global limits without a timeout', () => sqlaneWith().lanes.add(withKeys, noop), 'needs a timeout'],
    ['a lane added twice', () => {
        const sqlane = sqlaneWith();

        sqlane.lanes.add('a', noop);
        sqlane.lanes.add('a', noop);
    }, 'the lane is added already'],
    ['another definition of a name in "lanes"', () => {
        sqlaneWith({ lanes: [defineLane({ name: 'a' })] }).lanes.add(defineLane({ name: 'a' }), noop);
    }, 'another definition of "a" is in "lanes"'],
    ['the lanes as an object', () => createSqlane(/** @type {any} */ ({ adapter, lanes: { heavy: {} } })),
        'createSqlane: "lanes" must be an array of lane definitions'],
    ['concurrency', () => createSqlane(/** @type {any} */ ({ adapter, concurrency: 5 })),
        'createSqlane: unknown options: concurrency'],
])('lanes.add() and createSqlane() throw ConfigError on %s', (_, func, message) => {
    expect(func).toThrow(ConfigError);
    expect(func).toThrow(message);
});

test('one limit shared by several definitions; limits with one name and one max are one limit', () => {
    const sqlane = sqlaneWith();

    expect(() => {
        sqlane.lanes.add(defineLane({ name: 'a', localConcurrencyLimits: [heavy], fairShareWeight: 2 }), noop);
        sqlane.lanes.add(defineLane({ name: 'b', localConcurrencyLimits: [heavy] }), noop);
        sqlane.lanes.add(defineLane({
            name: 'c',
            localConcurrencyLimits: [defineConcurrencyLimit({ name: 'heavy', max: 2 })],
        }), noop);
    }).not.toThrow();
});

test('a local rate limit: one state per name of limit in the instance, shared by its definitions', () => {
    const registry = createRegistry({ lanesByName: new Map(), defaultTimeoutMs: null });
    const disk = defineRateLimit({ name: 'disk', max: 10, per: '1s' });

    registry.add(defineLane({ name: 'a', localRateLimits: [disk] }), noop);
    registry.add(defineLane({
        name: 'b',
        localRateLimits: [defineRateLimit({ name: 'disk', max: 10, per: 1000 })],
    }), noop);
    registry.add('c', noop);

    const [a, b, c] = ['a', 'b', 'c'].map(name => registry.getEntry(name));

    expect(a?.rates).toHaveLength(1);
    expect(b?.rates[0]).toBe(a?.rates[0]);
    expect(a?.rates[0]).toMatchObject({ limit: disk, tatUs: 0, lanes: ['a', 'b'] });
    expect(c?.rates).toStrictEqual([]);
});

test('start() accepts a local limit above the instance\'s cap: the lower one applies', async () => {
    const sqlane = sqlaneWith({ localMaxConcurrency: 2 });
    const wide = defineConcurrencyLimit({ name: 'wide', max: 20 });

    sqlane.lanes.add(defineLane({ name: 'a', localConcurrencyLimits: [wide] }), noop);

    // The dispatcher fails on the fake adapter: it reports the error and goes on, until close()
    await expect(sqlane.start()).resolves.toBeUndefined();
    await sqlane.close({ deadline: 0 });
});

test('a definition with global limits takes its timeout from the definition or the defaults', () => {
    const timed = defineLane({ name: 'k', globalConcurrencyLimits: () => [], timeout: '1m' });

    expect(() => sqlaneWith().lanes.add(timed, noop)).not.toThrow();
    expect(() => sqlaneWith({ defaults: { timeout: '1m' } }).lanes.add(withKeys, noop)).not.toThrow();
});

test.each([
    ['a failure lane that is not known', [defineLane({ name: 'a', failureLane: 'a_failed' })]],
    ['a failure lane with a failure lane of its own', [
        defineLane({ name: 'a', failureLane: defineLane({ name: 'a_failed', failureLane: 'other' }) }),
    ]],
])('start() and drain() throw ConfigError on %s', async (_, [definition]) => {
    const sqlane = sqlaneWith();

    sqlane.lanes.add(definition, noop);

    await expect(sqlane.start()).rejects.toThrow(ConfigError);
    await expect(sqlane.drain()).rejects.toThrow(ConfigError);
});

test('a failure lane in "lanes" or added resolves', async () => {
    const sqlane = sqlaneWith({ lanes: [defineLane({ name: 'b_failed' })] });

    sqlane.lanes.add(defineLane({ name: 'a', failureLane: 'a_failed' }), noop);
    sqlane.lanes.add('a_failed', noop);
    sqlane.lanes.add(defineLane({ name: 'b', failureLane: 'b_failed' }), noop);

    // The dispatcher fails on the fake adapter: it reports the error and goes on, until close()
    await expect(sqlane.start()).resolves.toBeUndefined();
    await sqlane.close({ deadline: 0 });
});

test('lanes.add() after start() throws ConfigError', async () => {
    const sqlane = sqlaneWith();

    await sqlane.start();

    expect(() => sqlane.lanes.add('a', noop)).toThrow(ConfigError);
    await sqlane.close({ deadline: 0 });
});

test('lanes.add() during drain() throws ConfigError', async () => {
    const sqlane = sqlaneWith();
    // No lane: nothing to drain
    const draining = sqlane.drain({ timeout: '1s' });

    expect(() => sqlane.lanes.add('a', noop))
        .toThrow('lanes.add() during drain(): add all the lanes before drain()');
    await expect(draining).resolves.toStrictEqual({ completed: 0, retried: 0, failed: 0 });
    await sqlane.close({ deadline: 0 });
});

test('after close(): lanes.add(), start() and drain() throw ClosedError', async () => {
    const sqlane = sqlaneWith();

    await sqlane.close({ deadline: 0 });

    expect(() => sqlane.lanes.add('a', noop)).toThrow(ClosedError);
    await expect(sqlane.start()).rejects.toThrow(ClosedError);
    await expect(sqlane.drain()).rejects.toThrow(ClosedError);
});
