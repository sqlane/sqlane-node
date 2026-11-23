import { expect, test } from 'vitest';
import {
    admitQueue,
    allowanceUs,
    incrementsOf,
    incrementUs,
    nextUnblockMs,
    splitByRate,
    waitMsOf,
    waitUs,
} from './gcra.js';

/**
 * @param {Partial<import('./rate_keys.js').GlobalRateLimit>} [settings]
 * @returns {import('./rate_keys.js').GlobalRateLimit}
 */
function limitOf(settings = {}) {
    return { key: '@sms', max: 10, per_us: 1_000_000, burst: 1, cost: 1, ...settings };
}

test('the increment and the allowance: cost × per / max rounded up, burst × per / max rounded down', () => {
    expect(incrementUs(limitOf())).toBe(100_000);
    expect(incrementUs(limitOf({ cost: 3, burst: 3 }))).toBe(300_000);
    expect(allowanceUs(limitOf({ burst: 10 }))).toBe(1_000_000);
    // 1 ms per 3: 333.3… µs
    expect(incrementUs(limitOf({ max: 3, per_us: 1000 }))).toBe(334);
    expect(allowanceUs(limitOf({ max: 3, per_us: 1000, burst: 3 }))).toBe(1000);
    // Exact at the ends of the ranges, where cost × per is above 2^53
    const huge = limitOf({ max: 999_999, per_us: 604_800_000_000, burst: 999_999, cost: 999_999 });

    expect(incrementUs(huge)).toBe(604_800_000_000);
    expect(allowanceUs(huge)).toBe(604_800_000_000);
    expect(incrementUs(limitOf({ max: 7, per_us: 604_800_000_000, burst: 7, cost: 5 })))
        .toBe(Number((5n * 604_800_000_000n + 6n) / 7n));
});

test('burst = max: max starts at once, then one per per / max', () => {
    const limit = limitOf({ burst: 10 });
    let debt = 0;
    let starts = 0;

    while (waitUs(debt, limit) <= 0) {
        debt += incrementUs(limit);
        starts++;
    }

    expect(starts).toBe(10);
    expect(waitUs(debt, limit)).toBe(100_000);
    // 100 ms later: one more
    expect(waitUs(debt - 100_000, limit)).toBe(0);
    expect(waitUs(debt - 100_000 + incrementUs(limit), limit)).toBe(100_000);
});

test('burst 1: one start, then the next after per / max', () => {
    const limit = limitOf();

    expect(waitUs(0, limit)).toBe(0);
    expect(waitUs(100_000, limit)).toBe(100_000);
    expect(waitUs(1, limit)).toBe(1);
    expect(waitMsOf(1)).toBe(1);
    expect(waitMsOf(-5)).toBe(0);
});

test('a per that is not a multiple of max: a job always fits without debt; the rounding costs µs, not starts', () => {
    // 1 s per 7: 142,857.1… µs
    const smooth = limitOf({ max: 7 });

    expect(waitUs(0, smooth)).toBe(0);
    expect(waitUs(incrementUs(smooth), smooth)).toBe(142_858);

    // 1 ms per 3, bursts of 3: the increments round up, 334 µs each; the third start waits 2 µs, not a period
    const bursty = limitOf({ max: 3, per_us: 1000, burst: 3 });

    expect(waitUs(2 * 334, bursty)).toBe(2);
    expect(waitUs(3 * 334, bursty)).toBe(336);
    // A cost of the whole burst: only without debt
    expect(waitUs(0, { ...bursty, cost: 3 })).toBe(0);
    expect(waitUs(1, { ...bursty, cost: 3 })).toBe(1);
});

test('splitByRate: FIFO per key, behind an older blocked job or a waiting job of the claim', () => {
    const sms = limitOf({ burst: 2 });
    const other = limitOf({ key: '@sms:b', burst: 2 });
    const rows = ['a1', 'a2', 'a3', 'a4'].map((id, at) => ({
        job: { id, lane: 'send', rateLimits: [sms] },
        runAtMs: at,
    }));
    const behind = { job: { id: 'b1', lane: 'send', rateLimits: [other] }, runAtMs: 5 };
    const split = splitByRate([...rows, behind], new Map([
        ['@sms', { debtUs: 0, head: null }],
        ['@sms:b', { debtUs: 0, head: { runAtMs: 1, id: 'old' } }],
    ]));

    expect(split.open.map(job => job.id)).toStrictEqual(['a1', 'a2']);
    expect(split.blocked).toStrictEqual([
        { id: 'a3', lane: 'send', key: '@sms' },
        { id: 'a4', lane: 'send', key: '@sms' },
        { id: 'b1', lane: 'send', key: '@sms:b' },
    ]);
    // A wait only for the key on which this split blocked the first job
    expect(split.waits).toStrictEqual([{ key: '@sms', delayMs: 100 }]);
});

test('splitByRate: all or nothing; a job blocked on one key takes no quota of the others', () => {
    const a = limitOf({ key: '@a' });
    const b = limitOf({ key: '@b' });
    const split = splitByRate([
        { job: { id: 'j1', lane: 'x', rateLimits: [a, b] }, runAtMs: 0 },
        { job: { id: 'j2', lane: 'x', rateLimits: [a] }, runAtMs: 1 },
    ], new Map([['@a', { debtUs: 0, head: null }], ['@b', { debtUs: 50_000, head: null }]]));

    expect(split.blocked).toStrictEqual([{ id: 'j1', lane: 'x', key: '@b' }]);
    expect(split.open.map(job => job.id)).toStrictEqual(['j2']);
    expect(split.waits).toStrictEqual([{ key: '@b', delayMs: 50 }]);
});

test('admitQueue: the prefix that fits, then the wait of the next; at most a batch', () => {
    const limit = limitOf({ burst: 3 });
    const queue = [limit, limit, limit, limit];

    expect(admitQueue(0, queue, 500)).toStrictEqual({ count: 3, waitUs: 100_000, debtUs: 300_000, left: true });
    expect(admitQueue(250_000, queue, 500)).toStrictEqual({ count: 0, waitUs: 50_000, debtUs: 250_000, left: true });
    expect(admitQueue(0, queue, 2)).toStrictEqual({ count: 2, waitUs: 0, debtUs: 200_000, left: true });
    // None left: the time of a next job like the last one
    expect(admitQueue(0, queue.slice(0, 2), 500)).toStrictEqual({ count: 2, waitUs: 0, debtUs: 200_000, left: false });
    expect(admitQueue(0, queue.slice(0, 3), 500))
        .toStrictEqual({ count: 3, waitUs: 100_000, debtUs: 300_000, left: false });
    expect(admitQueue(0, [], 500)).toStrictEqual({ count: 0, waitUs: null, debtUs: 0, left: false });
});

test('admitQueue: the next round after a full batch counts the jobs of the batch, if given their debt', () => {
    const limit = limitOf({ burst: 3 });
    const first = admitQueue(0, [limit, limit, limit, limit], 2);

    // Without: the stored debt, as if the batch had not started; the rest of the queue fits again
    expect(admitQueue(0, [limit, limit], 2)).toMatchObject({ count: 2, left: false });
    expect(admitQueue(first.debtUs, [limit, limit], 2)).toStrictEqual({
        count: 1,
        waitUs: 100_000,
        debtUs: 300_000,
        left: true,
    });
});

test('nextUnblockMs: the wait with jobs left; else one more unblock, in a second at the earliest', () => {
    expect(nextUnblockMs(1500, true)).toBe(2);
    expect(nextUnblockMs(0, true)).toBe(0);
    expect(nextUnblockMs(0, false)).toBe(1000);
    expect(nextUnblockMs(5_000_000, false)).toBe(5000);
});

test('incrementsOf: the µs per key of the jobs that start', () => {
    const a = limitOf({ key: '@a', cost: 1 });
    const costly = limitOf({ key: '@a', cost: 2, burst: 2 });

    expect(incrementsOf([{ rateLimits: [a] }, { rateLimits: [costly] }, { rateLimits: [] }]))
        .toStrictEqual(new Map([['@a', 300_000]]));
});
