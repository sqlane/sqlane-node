import { expect, test } from 'vitest';
import { getBackoffMs } from './backoff.js';

const noJitter = () => 0;
const almostOne = () => 1 - Number.EPSILON;

test('exponential: doubles each attempt, up to maxDelay', () => {
    const backoff = /** @type {const} */ ({ type: 'exponential', delay: '5s', maxDelay: '1m' });

    expect([1, 2, 3, 4, 5, 30].map(attempt => getBackoffMs(backoff, attempt, noJitter)))
        .toStrictEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000]);
});

test('exponential without maxDelay is not capped', () => {
    expect(getBackoffMs({ type: 'exponential', delay: 1000 }, 11, noJitter)).toBe(1_024_000);
});

test('fixed: the same delay each attempt', () => {
    expect([1, 5].map(attempt => getBackoffMs({ type: 'fixed', delay: '30s' }, attempt, noJitter)))
        .toStrictEqual([30_000, 30_000]);
});

test('jitter: reduces the delay by up to its fraction, default 0.2', () => {
    expect(getBackoffMs({ type: 'fixed', delay: 10_000 }, 1, almostOne)).toBe(8000);
    expect(getBackoffMs({ type: 'fixed', delay: 10_000, jitter: 0.5 }, 1, () => 0.5)).toBe(7500);
    expect(getBackoffMs({ type: 'fixed', delay: 10_000, jitter: 0 }, 1, almostOne)).toBe(10_000);
});
