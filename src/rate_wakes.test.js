import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createRateWakes } from './rate_wakes.js';

beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
    vi.useRealTimers();
});

/**
 * @returns {{ wakes: import('./rate_wakes.js').RateWakes, due: string[][], timers: () => number }}
 */
function wakesOf() {
    /** @type {string[][]} */
    const due = [];
    const wakes = createRateWakes({
        setTimer: (func, delayMs) => setTimeout(func, delayMs),
        clearTimer: timer => clearTimeout(timer),
        onDue: keys => due.push(keys),
    });

    return { wakes, due, timers: () => vi.getTimerCount() };
}

test('one timer for the earliest key; the keys due within 10 ms of it go together', () => {
    const { wakes, due, timers } = wakesOf();

    wakes.arm('@b', 100);
    wakes.arm('@a', 50);
    wakes.arm('@c', 55);
    wakes.arm('@d', 200);
    expect(timers()).toBe(1);
    vi.advanceTimersByTime(49);
    expect(due).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(due).toStrictEqual([['@a', '@c']]);
    vi.advanceTimersByTime(50);
    expect(due).toStrictEqual([['@a', '@c'], ['@b']]);
    vi.advanceTimersByTime(100);
    expect(due).toStrictEqual([['@a', '@c'], ['@b'], ['@d']]);
    expect(timers()).toBe(0);
});

test('a key keeps its earlier time; a sooner time replaces it', () => {
    const { wakes, due } = wakesOf();

    wakes.arm('@a', 100);
    wakes.arm('@a', 300);
    expect(wakes.dueBefore(101)).toBe(true);
    wakes.arm('@a', 20);
    vi.advanceTimersByTime(20);
    expect(due).toStrictEqual([['@a']]);
    // The stale time of the key fires nothing
    vi.advanceTimersByTime(500);
    expect(due).toStrictEqual([['@a']]);
    expect(wakes.dueBefore(Infinity)).toBe(false);
});

test('clear() forgets the keys and stops the timer', () => {
    const { wakes, due, timers } = wakesOf();

    wakes.arm('@a', 10);
    wakes.clear();
    expect(timers()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(due).toStrictEqual([]);
});
