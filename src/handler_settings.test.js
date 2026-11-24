import { expect, test } from 'vitest';
import { createRunner } from './create_runner.js';
import { createSqlane } from './create_sqlane.js';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
import { defineHandler } from './define_handler.js';
import { defineLane } from './define_lane.js';
import { defineRateLimit } from './define_rate_limit.js';
import { ConfigError } from './errors.js';
import { createRegistry } from './registry.js';

/** An adapter that is never called: the checks run before any SQL */
const adapter = /** @type {import('./types.js').Adapter<any>} */ ({ dialect: 'mysql' });
const withKeys = defineLane({ name: 'with_keys', globalConcurrencyLimits: () => [] });

/**
 * @param {Partial<import('./types.js').SqlaneOptions<any>>} [options]
 * @param {import('./types.js').RunnerOptions} [runnerOptions]
 * @returns {import('./sqlane.js').Runner}
 */
function runnerWith(options = {}, runnerOptions = {}) {
    return createRunner(createSqlane({ adapter, ...options }), { localMaxConcurrency: 10, ...runnerOptions });
}

const noop = () => {};
const heavy = defineConcurrencyLimit({ name: 'heavy', max: 2 });
const a = defineLane({ name: 'a' });
const b = defineLane({ name: 'b' });

test.each([
    ['two limits with one name and different maxes', () => {
        const runner = runnerWith();

        runner.mount([defineHandler(a, noop, { localConcurrencyLimits: [heavy] })]);
        runner.mount([defineHandler(b, noop, {
            localConcurrencyLimits: [defineConcurrencyLimit({ name: 'heavy', max: 3 })],
        })]);
    }, 'the concurrency limit "heavy" has the max 3 here and 2 in another handler'],
    ['two rate limits with one name and different settings', () => {
        const runner = runnerWith();

        runner.mount([defineHandler(a, noop, { localRateLimits: [defineRateLimit({ name: 'disk', max: 10, per: '1s' })] })]);
        runner.mount([defineHandler(b, noop, {
            localRateLimits: [defineRateLimit({ name: 'disk', max: 10, per: '1s', burst: 5 })],
        })]);
    }, 'the rate limit "disk" has max 10 per 1000 ms, burst 5 here and max 10 per 1000 ms, burst 1 in another '
    + 'handler'],
    ['a definition with global limits without a timeout', () => runnerWith().mount([defineHandler(withKeys, noop)]),
        'needs a timeout'],
    ['a lane mounted twice', () => {
        const runner = runnerWith();

        runner.mount([defineHandler(a, noop)]);
        runner.mount([defineHandler(a, noop)]);
    }, 'the lane "a" is handled here already'],
    ['concurrency', () => createSqlane(/** @type {any} */ ({ adapter, concurrency: 5 })),
        'createSqlane: unknown options: concurrency'],
])('mount() and createSqlane() throw ConfigError on %s', (_, func, message) => {
    expect(func).toThrow(ConfigError);
    expect(func).toThrow(message);
});

test('one limit shared by several handlers; limits with one name and one max are one limit', () => {
    const runner = runnerWith();

    expect(() => {
        runner.mount([defineHandler(a, noop, { localConcurrencyLimits: [heavy], fairShareWeight: 2 })]);
        runner.mount([defineHandler(b, noop, { localConcurrencyLimits: [heavy] })]);
        runner.mount([defineHandler(defineLane({ name: 'c' }), noop, {
            localConcurrencyLimits: [defineConcurrencyLimit({ name: 'heavy', max: 2 })],
        })]);
    }).not.toThrow();
});

test('a local rate limit: one state per name of limit in the runner, shared by its handlers', () => {
    const registry = createRegistry({ defaultTimeoutMs: null });
    const disk = defineRateLimit({ name: 'disk', max: 10, per: '1s' });
    const [first, second, third] = registry.addEntries([
        { name: 'a', definition: a, handler: noop, settings: { localRateLimits: [disk] }, where: 'test' },
        {
            name: 'b',
            definition: b,
            handler: noop,
            settings: { localRateLimits: [defineRateLimit({ name: 'disk', max: 10, per: 1000 })] },
            where: 'test',
        },
        { name: 'c', definition: defineLane({ name: 'c' }), handler: noop, settings: {}, where: 'test' },
    ]);

    expect(first.rates).toHaveLength(1);
    expect(second.rates[0]).toBe(first.rates[0]);
    expect(first.rates[0]).toMatchObject({ limit: disk, tatUs: 0, lanes: ['a', 'b'] });
    expect(third.rates).toStrictEqual([]);
});

test('start() accepts a local limit above the cap of the runner: the lower one applies', async () => {
    const runner = runnerWith({}, { localMaxConcurrency: 2 });
    const wide = defineConcurrencyLimit({ name: 'wide', max: 20 });

    runner.mount([defineHandler(a, noop, { localConcurrencyLimits: [wide] })]);

    // The dispatcher fails on the fake adapter: it reports the error and goes on, until close()
    await expect(runner.start()).resolves.toBeUndefined();
    await runner.close({ deadline: 0 });
});

test('a definition with global limits takes its timeout from the definition or the defaults', () => {
    const timed = defineLane({ name: 'k', globalConcurrencyLimits: () => [], timeout: '1m' });

    expect(() => runnerWith().mount([defineHandler(timed, noop)])).not.toThrow();
    expect(() => runnerWith({ defaults: { timeout: '1m' } }).mount([defineHandler(withKeys, noop)])).not.toThrow();
});
