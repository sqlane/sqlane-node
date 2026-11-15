import { expect, test } from 'vitest';
import { normalizeGlobalLimits } from './concurrency_keys.js';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
import { InvalidConcurrencyLimitError } from './errors.js';

const order = defineConcurrencyLimit({ name: 'order', max: 1 });
const client = defineConcurrencyLimit({ name: 'client', max: 2 });
const messages = defineConcurrencyLimit({ name: 'messages', max: 100 });

test('a limit, keys of limits; sorted by key, without duplicates, before the count', () => {
    const entries = [
        order.key('2'), messages, order.key(1), order.key('2'), client.key('a'),
        ...Array.from({ length: 6 }, (_, index) => client.key(`c${index}`)),
    ];

    expect(normalizeGlobalLimits(entries, 'test')).toStrictEqual([
        { key: 'client:a', max: 2 },
        ...Array.from({ length: 6 }, (_, index) => ({ key: `client:c${index}`, max: 2 })),
        { key: 'messages', max: 100 },
        { key: 'order:1', max: 1 },
        { key: 'order:2', max: 1 },
    ]);
});

test('accepts none, inner spaces, and a stored key of 255 characters', () => {
    expect(normalizeGlobalLimits([], 'test')).toStrictEqual([]);
    expect(normalizeGlobalLimits([order.key('a b'), order.key('x'.repeat(249))], 'test')).toStrictEqual([
        { key: 'order:a b', max: 1 },
        { key: `order:${'x'.repeat(249)}`, max: 1 },
    ]);
});

test('key() takes a string or an integer', () => {
    expect(order.key(42)).toStrictEqual({ limit: order, key: '42' });
    expect(Object.isFrozen(order.key('a'))).toBe(true);
    expect(() => order.key(/** @type {any} */ (1.5))).toThrow(InvalidConcurrencyLimitError);
    expect(() => order.key(/** @type {any} */ (null))).toThrow('order.key(): the key must be a string or an integer');
});

test.each([
    ['not an array', order],
    ['a string', ['order:1']],
    ['a copy of a limit', [{ name: 'order', max: 1 }]],
    ['an empty key', [order.key('')]],
    ['a key with a space at the end', [order.key('1 ')]],
    ['a non-ASCII key', [order.key('замовлення')]],
    ['a control character', [order.key('a\n1')]],
    ['a stored key of 256 characters', [order.key('x'.repeat(250))]],
    ['one key with two maxes', [order.key('1'), defineConcurrencyLimit({ name: 'order', max: 2 }).key('1')]],
    ['11 distinct keys', Array.from({ length: 11 }, (_, index) => order.key(index))],
])('rejects %s', (_, entries) => {
    expect(() => normalizeGlobalLimits(entries, 'test')).toThrow(InvalidConcurrencyLimitError);
});
