import { expect, test } from 'vitest';
import { parseDuration } from './duration.js';

test.each([
    [0, 0],
    [1500, 1500],
    ['500ms', 500],
    ['5s', 5000],
    ['10m', 600_000],
    ['1h', 3_600_000],
    ['30d', 2_592_000_000],
    ['1.5s', 1500],
    ['4m30s', 270_000],
    ['1h 0m 1s', 3_601_000],
    ['2 days', 172_800_000],
    ['0.0004s', 0],
])('parses %o', (value, expected) => {
    expect(parseDuration(value)).toBe(expected);
});

test.each([
    [-1],
    [1.5],
    [Number.NaN],
    [Infinity],
    [''],
    ['soon'],
    ['-5s'],
    [null],
    [undefined],
    [{}],
    ['9999999999999d'],
])('rejects %o', (value) => {
    expect(parseDuration(value)).toBeNull();
});
