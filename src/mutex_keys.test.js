import { expect, test } from 'vitest';
import { InvalidMutexKeyError } from './errors.js';
import { normalizeMutexKeys } from './mutex_keys.js';

test('sorts the keys and removes the duplicates before the count', () => {
    const keys = ['order:2', 'order:1', 'order:2', ...Array.from({ length: 8 }, (_, index) => `item:${index}`)];

    expect(normalizeMutexKeys(keys, 'test')).toStrictEqual([
        'item:0', 'item:1', 'item:2', 'item:3', 'item:4', 'item:5', 'item:6', 'item:7', 'order:1', 'order:2',
    ]);
});

test('accepts no keys, inner spaces and 255 characters', () => {
    expect(normalizeMutexKeys([], 'test')).toStrictEqual([]);
    expect(normalizeMutexKeys(['a b', 'x'.repeat(255)], 'test')).toStrictEqual(['a b', 'x'.repeat(255)]);
});

test.each([
    ['not an array', 'order:1'],
    ['an empty key', ['']],
    ['a key with a space at the end', ['order:1 ']],
    ['a key with a space at the start', [' order:1']],
    ['a non-ASCII key', ['замовлення:1']],
    ['a control character', ['order:\n1']],
    ['a key of 256 characters', ['x'.repeat(256)]],
    ['a number', [1]],
    ['11 distinct keys', Array.from({ length: 11 }, (_, index) => `key:${index}`)],
])('rejects %s', (_, keys) => {
    expect(() => normalizeMutexKeys(keys, 'test')).toThrow(InvalidMutexKeyError);
});
