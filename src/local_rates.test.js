import { expect, test } from 'vitest';
import { defineRateLimit } from './define_rate_limit.js';
import { createRateState, pauseRate, rateRoom, rateWaitMs, takeRate } from './local_rates.js';

test('a fresh limit: its burst at once, then one start per per / max', () => {
    // 10 per s, bursts of 3: one each 100 ms
    const state = createRateState(defineRateLimit({ name: 'disk', max: 10, per: '1s', burst: 3 }));

    expect(state.settings).toStrictEqual({ key: '@disk', max: 10, per_us: 1_000_000, burst: 3, cost: 1 });
    expect(rateRoom(state, 5_000_000)).toBe(3);
    expect(rateWaitMs(state, 5_000_000)).toBe(0);

    for (let start = 0; start < 3; start++) {
        takeRate(state, 5_000_000);
    }

    expect(rateRoom(state, 5_000_000)).toBe(0);
    expect(rateWaitMs(state, 5_000_000)).toBe(100);
    expect(rateRoom(state, 5_099_999)).toBe(0);
    expect(rateWaitMs(state, 5_099_999)).toBe(1);
    expect(rateRoom(state, 5_100_000)).toBe(1);
    expect(rateRoom(state, 5_300_000)).toBe(3);
    // The debt ends: no more than the burst
    expect(rateRoom(state, 9_000_000)).toBe(3);
});

test('a start after the debt ended counts from now', () => {
    const state = createRateState(defineRateLimit({ name: 'disk', max: 10, per: '1s' }));

    takeRate(state, 1_000_000);
    takeRate(state, 3_000_000);
    expect(state.tatUs).toBe(3_100_000);
    expect(rateRoom(state, 3_000_000)).toBe(0);
});

test('a per that is not a multiple of max: one start without debt', () => {
    const state = createRateState(defineRateLimit({ name: 'seventh', max: 7, per: '1s' }));

    expect(rateRoom(state, 0)).toBe(1);
    takeRate(state, 0);
    expect(rateRoom(state, 0)).toBe(0);
    expect(rateWaitMs(state, 0)).toBe(143);
});

test('pauseRate: the next start at now + retryAfter, then one per per / max; it only extends', () => {
    const state = createRateState(defineRateLimit({ name: 'api', max: 10, per: '1s', burst: 5 }));

    pauseRate(state, 1_000_000, 300_000);
    expect(rateRoom(state, 1_299_999)).toBe(0);
    expect(rateWaitMs(state, 1_000_000)).toBe(300);
    expect(rateRoom(state, 1_300_000)).toBe(1);
    takeRate(state, 1_300_000);
    expect(rateWaitMs(state, 1_300_000)).toBe(100);

    // A shorter pause does not bring it back
    pauseRate(state, 1_300_000, 0);
    expect(rateWaitMs(state, 1_300_000)).toBe(100);
});
