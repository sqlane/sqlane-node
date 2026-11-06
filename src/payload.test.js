import { expect, test } from 'vitest';
import { InvalidOptionsError, PayloadTooLargeError } from './errors.js';
import { serializePayload } from './payload.js';

test('accepts a backslash followed by u0000', () => {
    expect(serializePayload({ path: 'C:\\u0000' }, 1024, 'test')).toBe('{"path":"C:\\\\u0000"}');
});

test('gives the JSON', () => {
    expect(serializePayload({ reportId: 'r1', tags: ['a'], skipped: undefined }, 1024, 'test'))
        .toBe('{"reportId":"r1","tags":["a"]}');
});

test('measures UTF-8 bytes, up to the limit included', () => {
    expect(serializePayload('ї', 4, 'test')).toBe('"ї"');
    expect(() => serializePayload('ї', 3, 'test')).toThrow(PayloadTooLargeError);
});

test.each([
    ['undefined', undefined],
    ['a function', () => 1],
    ['a bigint', { id: 1n }],
    ['a lone surrogate in a value', { text: '\uD800' }],
    ['a lone surrogate in a key', { '\uDC00': 1 }],
    ['a NUL character', { text: 'a\u0000b' }],
])('rejects %s', (_, payload) => {
    expect(() => serializePayload(payload, 1024, 'test')).toThrow(InvalidOptionsError);
});
