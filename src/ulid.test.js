import { expect, test, vi } from 'vitest';
import { createMonotonicUlid } from './ulid.js';

test('encodes known timestamp and entropy vectors', () => {
    const generate = createMonotonicUlid({
        now: () => 1_469_918_176_385,
        random: () => Uint8Array.from([0xD6, 0xE4, 0xCF, 0x80, 0x97, 0x66, 0x80, 0x97, 0x66, 0x80]),
    });

    expect(generate()).toBe('01ARYZ6S41TVJCZ04QCT09ESM0');
});

test('encodes timestamp zero and maximum timestamp', () => {
    expect(createMonotonicUlid({ now: () => 0, random: () => new Uint8Array(10) })())
        .toBe('00000000000000000000000000');
    expect(createMonotonicUlid({ now: () => 2 ** 48 - 1, random: () => new Uint8Array(10).fill(255) })())
        .toBe('7ZZZZZZZZZZZZZZZZZZZZZZZZZ');
});

test('increments within a millisecond and through backward clock changes, then refreshes entropy', () => {
    let time = 100;
    const random = vi.fn(() => new Uint8Array(10));
    const generate = createMonotonicUlid({ now: () => time, random });
    const first = generate();
    const second = generate();

    time = 99;
    const third = generate();

    expect(first).toBe('00000000340000000000000000');
    expect(second).toBe('00000000340000000000000001');
    expect(third).toBe('00000000340000000000000002');
    expect(random).toHaveBeenCalledTimes(1);

    time = 101;
    expect(generate()).toBe('00000000350000000000000000');
    expect(random).toHaveBeenCalledTimes(2);
});

test('carries through multiple suffix characters', () => {
    const bytes = new Uint8Array(10);

    bytes[9] = 255;
    const generate = createMonotonicUlid({ now: () => 0, random: () => bytes });

    expect(generate()).toBe('0000000000000000000000007Z');
    expect(generate()).toBe('00000000000000000000000080');
});

test('overflow never wraps and a later timestamp recovers', () => {
    let time = 0;
    const generate = createMonotonicUlid({ now: () => time, random: () => new Uint8Array(10).fill(255) });
    expect(generate()).toBe('0000000000ZZZZZZZZZZZZZZZZ');

    expect(() => generate()).toThrow('ULID random suffix overflow');
    expect(() => generate()).toThrow('ULID random suffix overflow');

    time = 1;
    expect(generate()).toBe('0000000001ZZZZZZZZZZZZZZZZ');
});

test.each([-1, 1.5, Number.NaN, Infinity, 2 ** 48])('rejects invalid timestamp %s', (time) => {
    expect(() => createMonotonicUlid({ now: () => time })()).toThrow(RangeError);
});

test('rejects an incorrect entropy length without changing generator state', () => {
    const random = vi.fn().mockReturnValueOnce(new Uint8Array(9)).mockReturnValue(new Uint8Array(10));
    const generate = createMonotonicUlid({ now: () => 0, random });

    expect(() => generate()).toThrow('ULID entropy must contain 10 bytes');
    expect(generate()).toBe('00000000000000000000000000');
});

test('default crypto source produces valid distinct IDs', () => {
    const generate = createMonotonicUlid();
    const ids = Array.from({ length: 1000 }, () => generate());

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toStrictEqual(ids.toSorted());
    expect(ids.every(id => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id))).toBe(true);
});
