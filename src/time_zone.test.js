import { describe, expect, test } from 'vitest';
import { isTimeZone, normalizeTimeZoneCase, offsetAt, resolveWall, transitionNear, wallOf } from './time_zone.js';

const at = (/** @type {string} */ iso) => Date.parse(iso);

test('isTimeZone accepts the zones of Intl only', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone(42)).toBe(false);
});

describe('wallOf', () => {
    test('UTC is the instant itself', () => {
        expect(wallOf(at('2026-03-29T01:30:12.345Z'), 'UTC')).toBe(at('2026-03-29T01:30:12.345Z'));
    });

    test('a zone adds its offset, milliseconds included', () => {
        expect(wallOf(at('2026-07-01T10:00:00.250Z'), 'Europe/Berlin')).toBe(at('2026-07-01T12:00:00.250Z'));
        expect(offsetAt(at('2026-01-01T00:00:00Z'), 'Europe/Berlin')).toBe(3_600_000);
    });

    test('midnight is 00, not 24', () => {
        expect(new Date(wallOf(at('2026-07-01T22:00:00Z'), 'Europe/Berlin')).toISOString())
            .toBe('2026-07-02T00:00:00.000Z');
    });
});

describe('resolveWall', () => {
    test('a plain time has one instant', () => {
        expect(resolveWall(at('2026-07-01T12:00:00Z'), 'Europe/Berlin')).toStrictEqual({
            instants: [at('2026-07-01T10:00:00Z')],
        });
    });

    test('a time in the gap of spring forward has none: the gap ends at 03:00 CEST', () => {
        expect(resolveWall(at('2026-03-29T02:30:00Z'), 'Europe/Berlin')).toStrictEqual({
            gapEnd: at('2026-03-29T01:00:00Z'),
        });
    });

    test('a time in the repeated hour of fall back has two', () => {
        expect(resolveWall(at('2026-10-25T02:30:00Z'), 'Europe/Berlin')).toStrictEqual({
            instants: [at('2026-10-25T00:30:00Z'), at('2026-10-25T01:30:00Z')],
        });
    });

    test('Lord Howe: a half-hour shift', () => {
        // 2026-04-05 02:00 LHDT (+11) → 01:30 LHST (+10:30): 01:30–01:59 twice
        expect(resolveWall(at('2026-04-05T01:45:00Z'), 'Australia/Lord_Howe')).toStrictEqual({
            instants: [at('2026-04-04T14:45:00Z'), at('2026-04-04T15:15:00Z')],
        });
        // 2026-10-04 02:00 LHST → 02:30 LHDT: 02:00–02:29 does not exist
        expect(resolveWall(at('2026-10-04T02:15:00Z'), 'Australia/Lord_Howe')).toStrictEqual({
            gapEnd: at('2026-10-03T15:30:00Z'),
        });
    });

    test('UTC has one instant', () => {
        expect(resolveWall(at('2026-03-29T02:30:00Z'), 'UTC')).toStrictEqual({ instants: [at('2026-03-29T02:30:00Z')] });
    });
});

test('transitionNear finds the instant of the change', () => {
    expect(transitionNear(at('2026-03-29T05:00:00Z'), 'Europe/Berlin')).toBe(at('2026-03-29T01:00:00Z'));
    expect(transitionNear(at('2026-10-24T20:00:00Z'), 'Europe/Berlin')).toBe(at('2026-10-25T01:00:00Z'));
});

test.each([
    ['utc', 'UTC'],
    ['Etc/UTC', 'UTC'],
    ['europe/berlin', 'Europe/Berlin'],
    ['Europe/Berlin', 'Europe/Berlin'],
])('normalizeTimeZoneCase(%j) is %j', (given, expected) => {
    expect(normalizeTimeZoneCase(given)).toBe(expected);
});
