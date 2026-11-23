import { expect, test } from 'vitest';
import { defineRateLimit, isRateLimit, isRateLimitKey } from './define_rate_limit.js';
import { ConfigError, InvalidRateLimitError } from './errors.js';

test('a frozen limit, known to defineLane(): per in milliseconds, burst 1 by default', () => {
    const github = defineRateLimit({ name: 'github', max: 5000, per: '1h' });

    expect(github).toMatchObject({ name: 'github', max: 5000, per: 3_600_000, burst: 1 });
    expect(Object.isFrozen(github)).toBe(true);
    expect(isRateLimit(github)).toBe(true);
    // Not frozen: not from defineRateLimit()
    expect(isRateLimit({ ...github })).toBe(false);
    expect(isRateLimit(Object.freeze({ ...github, extra: 1 }))).toBe(false);
    expect(isRateLimit('github')).toBe(false);
});

test('the ranges: max 1 to 1,000,000 and at most per in µs, per 1 ms to 7 d, burst 1 to max', () => {
    expect(defineRateLimit({ name: 'a', max: 1, per: 1 })).toMatchObject({ max: 1, per: 1, burst: 1 });
    // One start per µs at most: the tat moves by whole microseconds
    expect(defineRateLimit({ name: 'a', max: 1000, per: 1 })).toMatchObject({ max: 1000, per: 1 });
    expect(defineRateLimit({ name: 'a', max: 1_000_000, per: '7d', burst: 1_000_000 }))
        .toMatchObject({ max: 1_000_000, per: 604_800_000, burst: 1_000_000 });
    expect(defineRateLimit({ name: 'sms', max: 10, per: '1s', burst: 10 }).burst).toBe(10);
    expect(defineRateLimit({ name: 'a', max: 1, per: '1w' }).per).toBe(604_800_000);
});

test('key(): a frozen key of a string or an integer, cost 1 by default', () => {
    const github = defineRateLimit({ name: 'github', max: 5000, per: '1h', burst: 10 });
    const key = github.key('t1');

    expect(key).toStrictEqual({ limit: github, key: 't1', cost: 1 });
    expect(Object.isFrozen(key)).toBe(true);
    expect(isRateLimitKey(key)).toBe(true);
    expect(github.key(42, { cost: 10 })).toStrictEqual({ limit: github, key: '42', cost: 10 });
    expect(isRateLimitKey(github)).toBe(false);
    expect(isRateLimitKey({ limit: github, key: 't1', cost: 1 })).toBe(false);
});

test('cost(): the limit itself, at a cost', () => {
    const sms = defineRateLimit({ name: 'sms', max: 10, per: '1s', burst: 3 });
    const costly = sms.cost(3);

    expect(costly).toStrictEqual({ limit: sms, key: null, cost: 3 });
    expect(Object.isFrozen(costly)).toBe(true);
    expect(isRateLimitKey(costly)).toBe(true);
});

test.each([
    ['a float', 'k', { cost: 1.5 }, 'github.key(): "cost" must be an integer from 1 to the burst of the limit, 2, got 1.5'],
    ['a cost of 0', 'k', { cost: 0 }, 'github.key(): "cost" must be an integer from 1 to the burst of the limit, 2, got 0'],
    ['a cost above the burst', 'k', { cost: 3 }, 'github.key(): "cost" must be an integer from 1 to the burst of the limit, 2, got 3'],
    ['an unknown option', 'k', { weight: 1 }, 'github.key(): unknown options: weight'],
    ['options that are not an object', 'k', 2, 'github.key(): options must be an object'],
    ['a null key', null, undefined, 'github.key(): the key must be a string or an integer, got null'],
    ['a fractional key', 1.5, undefined, 'github.key(): the key must be a string or an integer, got 1.5'],
])('key() throws an InvalidRateLimitError for %s', (_, value, options, message) => {
    const github = defineRateLimit({ name: 'github', max: 10, per: '1s', burst: 2 });

    expect(() => github.key(/** @type {any} */ (value), /** @type {any} */ (options))).toThrow(InvalidRateLimitError);
    expect(() => github.key(/** @type {any} */ (value), /** @type {any} */ (options))).toThrow(message);
});

test.each([0, 3, 1.5, '1'])('cost(%o) throws an InvalidRateLimitError that names the burst', (cost) => {
    const sms = defineRateLimit({ name: 'sms', max: 10, per: '1s', burst: 2 });

    expect(() => sms.cost(/** @type {any} */ (cost))).toThrow(InvalidRateLimitError);
    expect(() => sms.cost(/** @type {any} */ (cost)))
        .toThrow('sms.cost(): "cost" must be an integer from 1 to the burst of the limit, 2');
});

const PER = '"per" must be a duration from 1 ms to 7 d (\'1s\', \'1h\', or milliseconds)';

test.each([
    ['an unknown option', { name: 'a', max: 1, per: '1s', weight: 1 }, 'defineRateLimit("a"): unknown options: weight'],
    ['a bad name', { name: 'GitHub', max: 1, per: '1s' }, 'defineRateLimit("GitHub"): "name" must match /^[a-z][a-z0-9_.-]{0,127}$/'],
    ['no name', { max: 1, per: '1s' }, 'defineRateLimit(""): "name" must match'],
    ['a max of 0', { name: 'a', max: 0, per: '1s' }, 'defineRateLimit("a"): "max" must be an integer from 1 to 1000000'],
    ['a max above 1,000,000', { name: 'a', max: 1_000_001, per: '1s' }, '"max" must be an integer from 1 to 1000000'],
    ['a fractional max', { name: 'a', max: 1.5, per: '1s' }, '"max" must be an integer from 1 to 1000000'],
    ['no per', { name: 'a', max: 1 }, `defineRateLimit("a"): ${PER}, got undefined`],
    ['a per of 0', { name: 'a', max: 1, per: 0 }, `${PER}, got 0`],
    ['a per above 7 d', { name: 'a', max: 1, per: '7d 1ms' }, `${PER}, got "7d 1ms"`],
    ['a per that is not a duration', { name: 'a', max: 1, per: '1 hour' }, `${PER}, got "1 hour"`],
    ['a max above the µs of per', { name: 'a', max: 1001, per: 1 }, 'defineRateLimit("a"): "max" must be at most the microseconds of "per", 1000: at most one start per microsecond'],
    ['a burst of 0', { name: 'a', max: 5, per: '1s', burst: 0 }, 'defineRateLimit("a"): "burst" must be an integer from 1 to "max", 5'],
    ['a burst above max', { name: 'a', max: 5, per: '1s', burst: 6 }, '"burst" must be an integer from 1 to "max", 5'],
    ['a fractional burst', { name: 'a', max: 5, per: '1s', burst: 1.5 }, '"burst" must be an integer from 1 to "max", 5'],
])('throws a ConfigError for %s', (_, options, message) => {
    expect(() => defineRateLimit(/** @type {any} */ (options))).toThrow(ConfigError);
    expect(() => defineRateLimit(/** @type {any} */ (options))).toThrow(message);
});
