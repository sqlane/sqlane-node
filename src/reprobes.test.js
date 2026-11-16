import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createReprobes } from './reprobes.js';

beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
    vi.useRealTimers();
});

/**
 * @param {{ pollIntervalMs?: number, state?: import('./runner.js').RunnerState }} [options]
 * @returns {{ reprobes: import('./reprobes.js').Reprobes, wakes: { at: number, names: string[] }[] }}
 */
function reprobesOf({ pollIntervalMs = 5000, state = 'started' } = {}) {
    /** @type {{ at: number, names: string[] }[]} */
    const wakes = [];
    const reprobes = createReprobes({
        pollIntervalMs,
        state: () => state,
        setTimer: (func, delayMs) => setTimeout(func, delayMs),
        clearTimer: timer => clearTimeout(timer),
        wake: names => wakes.push({ at: Date.now(), names }),
    });

    return { reprobes, wakes };
}

test('an enqueue: a wake of its names at each step shorter than the poll interval', () => {
    const { reprobes, wakes } = reprobesOf({ pollIntervalMs: 1000 });

    reprobes.follow(['a']);
    vi.advanceTimersByTime(10_000);
    expect(wakes).toStrictEqual([20, 50, 100, 200, 500].map(at => ({ at, names: ['a'] })));
    expect(vi.getTimerCount()).toBe(0);
});

test('a burst of enqueues: at most one re-probe per first step, and the series goes on from the last enqueue', () => {
    const { reprobes, wakes } = reprobesOf({ pollIntervalMs: 300 });

    reprobes.follow(['a']);
    vi.advanceTimersByTime(5);
    reprobes.follow(['b']);
    vi.advanceTimersByTime(10);
    reprobes.follow(['a']);
    vi.advanceTimersByTime(1000);
    // The re-probe at 20 stays; then the steps from the last enqueue (15): 35, 65, 115 and 215, past the last step of b
    expect(wakes).toStrictEqual([
        { at: 20, names: ['a', 'b'] },
        { at: 35, names: ['a', 'b'] },
        { at: 65, names: ['a', 'b'] },
        { at: 115, names: ['a', 'b'] },
        { at: 215, names: ['a'] },
    ]);
});

test('a name whose last step is past leaves the series that goes on for later enqueues', () => {
    const { reprobes, wakes } = reprobesOf({ pollIntervalMs: 60 });

    reprobes.follow(['a']);
    vi.advanceTimersByTime(40);
    reprobes.follow(['b']);
    vi.advanceTimersByTime(1000);
    // The steps of 20 and 50 ms: a at 20 and 50; then b at 60 and 90, from its enqueue at 40, without a
    expect(wakes).toStrictEqual([
        { at: 20, names: ['a'] },
        { at: 50, names: ['a', 'b'] },
        { at: 60, names: ['b'] },
        { at: 90, names: ['b'] },
    ]);
});

test('no re-probe unless started', () => {
    const { reprobes, wakes } = reprobesOf({ state: 'draining' });

    reprobes.follow(['a']);
    vi.advanceTimersByTime(10_000);
    expect(wakes).toStrictEqual([]);
    expect(vi.getTimerCount()).toBe(0);
});
