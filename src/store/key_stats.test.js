import { describe, expect, test } from 'vitest';
import { toKeyStats } from './key_stats.js';

/**
 * A row of the keyStats statement, as the drivers give it: numbers may be strings or BigInts, JSON is text.
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
function row(fields) {
    return {
        k: 'order:1',
        held: 0,
        lingering: 0,
        blocked: 0,
        blockedage: null,
        heldage: null,
        headkeys: null,
        headmaxes: null,
        headrates: null,
        holderkeys: null,
        holdermaxes: null,
        debtus: null,
        ...fields,
    };
}

/**
 * @param {string} rates The rate settings of the head job, as JSON.
 * @param {number} debtus
 * @returns {import('../types.js').KeyStats} A rate key with one blocked job.
 */
function rate(rates, debtus) {
    return toKeyStats(row({ k: '@api:t1', blocked: 1, blockedage: 5, headrates: rates, debtus }));
}

const RATES = JSON.stringify([{ key: '@api:t1', max: 1, per_us: 2_000_000, burst: 1, cost: 1 }]);

describe('a concurrency key', () => {
    test('the max of the head job, at the position of the key', () => {
        expect(toKeyStats(row({
            k: 'order:1',
            held: '1',
            lingering: 1n,
            blocked: 2,
            blockedage: '1500',
            heldage: 300n,
            headkeys: '["client:1","order:1"]',
            headmaxes: '[9,2]',
            holderkeys: '["order:1"]',
            holdermaxes: '[5]',
        }))).toStrictEqual({
            type: 'concurrency',
            key: 'order:1',
            max: 2,
            held: 1,
            lingering: 1,
            blocked: 2,
            blockedTruncated: false,
            oldestBlockedAgeMs: 1500,
            oldestHeldAgeMs: 300,
        });
    });

    test('nothing blocked: the max of the newest slot\'s job; none, or without the key: null', () => {
        const holder = (/** @type {string} */ key) => row({ held: 1, holderkeys: `["${key}"]`, holdermaxes: '[5]' });

        expect(toKeyStats(holder('order:1'))).toMatchObject({ max: 5 });
        expect(toKeyStats(holder('other:1'))).toMatchObject({ max: null });
        expect(toKeyStats(row({ held: 1 }))).toMatchObject({ max: null, oldestBlockedAgeMs: null });
    });

    test('1001 blocked jobs read: 1000, truncated', () => {
        expect(toKeyStats(row({ blocked: 1001, blockedage: 1 })))
            .toMatchObject({ blocked: 1000, blockedTruncated: true });
        expect(toKeyStats(row({ blocked: 1000, blockedage: 1 })))
            .toMatchObject({ blocked: 1000, blockedTruncated: false });
    });

    test('an age below 0 (a row committed after the statement\'s time) is 0', () => {
        expect(toKeyStats(row({ blockedage: -1, heldage: '-2' }))).toMatchObject({
            oldestBlockedAgeMs: 0,
            oldestHeldAgeMs: 0,
        });
    });
});

describe('a rate key', () => {
    test('its limit and key, and the wait of its head by its own settings', () => {
        expect(toKeyStats(row({
            k: '@api:t1',
            blocked: '2',
            blockedage: 1000,
            headrates: RATES,
            debtus: '1500000',
        }))).toStrictEqual({
            type: 'rate',
            limit: 'api',
            key: 't1',
            blocked: 2,
            blockedTruncated: false,
            oldestBlockedAgeMs: 1000,
            nextStartInMs: 1500,
        });
    });

    test('a limit without key; no debt, or no row: 0; a head without the settings of the key: 0', () => {
        expect(toKeyStats(row({ k: '@api', blocked: 1, blockedage: 5 }))).toMatchObject({
            type: 'rate',
            limit: 'api',
            key: null,
            nextStartInMs: 0,
        });
        expect(toKeyStats(row({ k: '@api:t1', blocked: 1, blockedage: 5, headrates: RATES, debtus: null })))
            .toMatchObject({ nextStartInMs: 0 });
        expect(toKeyStats(row({ k: '@api:t1', blocked: 1, blockedage: 5, headrates: '[]', debtus: 9_000_000 })))
            .toMatchObject({ nextStartInMs: 0 });
    });

    test('a burst and a cost: the debt minus the allowance, (burst − cost) × per / max; 0 within it', () => {
        const bursty = JSON.stringify([{ key: '@api:t1', max: 3, per_us: 3_000_000, burst: 3, cost: 1 }]);
        const costly = JSON.stringify([{ key: '@api:t1', max: 4, per_us: 4_000_000, burst: 4, cost: 2 }]);

        expect(rate(bursty, 2_500_000)).toMatchObject({ nextStartInMs: 500 });
        expect(rate(bursty, 1_000_000)).toMatchObject({ nextStartInMs: 0 });
        expect(rate(costly, 3_000_000)).toMatchObject({ nextStartInMs: 1000 });
        expect(rate(costly, 2_000_000)).toMatchObject({ nextStartInMs: 0 });
    });

    test('the wait is rounded up to the ms', () => {
        expect(toKeyStats(row({ k: '@api:t1', blocked: 1, blockedage: 5, headrates: RATES, debtus: 1_000_001 })))
            .toMatchObject({ nextStartInMs: 1001 });
    });
});
