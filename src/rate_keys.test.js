import { expect, test } from 'vitest';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
import { defineRateLimit } from './define_rate_limit.js';
import { InvalidRateLimitError } from './errors.js';
import { normalizeGlobalRateLimits } from './rate_keys.js';

const github = defineRateLimit({ name: 'github', max: 5000, per: '1h' });
const sms = defineRateLimit({ name: 'sms', max: 10, per: '1s', burst: 10 });
const fast = defineRateLimit({ name: 'fast', max: 3, per: 1 });

test('limits, keys and costs: stored as @<name>[:<key>], sorted by key, without duplicates, µs', () => {
    const entries = [sms, github.key('t2'), github.key(1), sms, github.key('t2'), fast, sms.cost(1)];

    expect(normalizeGlobalRateLimits(entries, 'test', 0)).toStrictEqual([
        { key: '@fast', max: 3, per_us: 1000, burst: 1, cost: 1 },
        { key: '@github:1', max: 5000, per_us: 3_600_000_000, burst: 1, cost: 1 },
        { key: '@github:t2', max: 5000, per_us: 3_600_000_000, burst: 1, cost: 1 },
        { key: '@sms', max: 10, per_us: 1_000_000, burst: 10, cost: 1 },
    ]);
});

test('a cost', () => {
    expect(normalizeGlobalRateLimits([sms.cost(4), github.key('t', { cost: 1 })], 'test', 0)).toStrictEqual([
        { key: '@github:t', max: 5000, per_us: 3_600_000_000, burst: 1, cost: 1 },
        { key: '@sms', max: 10, per_us: 1_000_000, burst: 10, cost: 4 },
    ]);
});

test('accepts none, inner spaces, and a stored key of 255 characters', () => {
    expect(normalizeGlobalRateLimits([], 'test', 10)).toStrictEqual([]);
    expect(normalizeGlobalRateLimits([github.key('a b'), github.key('x'.repeat(247))], 'test', 0).map(({ key }) => key))
        .toStrictEqual(['@github:a b', `@github:${'x'.repeat(247)}`]);
});

test('10 global keys with the concurrency keys', () => {
    const keys = Array.from({ length: 4 }, (_, index) => github.key(index));

    expect(normalizeGlobalRateLimits(keys, 'test', 6)).toHaveLength(4);
    expect(() => normalizeGlobalRateLimits(keys, 'test', 7))
        .toThrow('test: at most 10 global keys, concurrency and rate limits together, got 11');
});

test.each([
    ['not an array', github],
    ['a string', ['@github:1']],
    ['a concurrency limit', [defineConcurrencyLimit({ name: 'github', max: 1 })]],
    ['a copy of a limit', [{ ...github }]],
    ['an empty key', [github.key('')]],
    ['a key with a space at the end', [github.key('1 ')]],
    ['a non-ASCII key', [github.key('ключ')]],
    ['a control character', [github.key('a\n1')]],
    ['a stored key of 256 characters', [github.key('x'.repeat(248))]],
    ['one key with two maxes', [github.key('1'), defineRateLimit({ name: 'github', max: 1, per: '1h' }).key('1')]],
    ['one key with two periods', [github, defineRateLimit({ name: 'github', max: 5000, per: '2h' })]],
    ['one key with two bursts', [sms, defineRateLimit({ name: 'sms', max: 10, per: '1s', burst: 9 })]],
    ['one key with two costs', [sms, sms.cost(2)]],
    ['11 distinct keys', Array.from({ length: 11 }, (_, index) => github.key(index))],
])('rejects %s', (_, entries) => {
    expect(() => normalizeGlobalRateLimits(entries, 'test', 0)).toThrow(InvalidRateLimitError);
});
