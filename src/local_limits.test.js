import { expect, test, vi } from 'vitest';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
import { defineLane } from './define_lane.js';
import { defineRateLimit } from './define_rate_limit.js';
import {
    createLocalRateWakes,
    limitsRoom,
    localLimitsOf,
    ratesAdmitBefore,
    roomOf,
    shareLanesOf,
} from './local_limits.js';
import { nowUs, takeRate } from './local_rates.js';
import { createRegistry } from './registry.js';

/**
 * Adds a handler of a lane to the registry, as a mount does.
 * @param {import('./registry.js').Registry} registry
 * @param {import('./types.js').LaneDefinition | string} lane A definition, or a name: a definition without options.
 * @param {import('./types.js').Handler} handler
 * @param {import('./types.js').HandlerOptions} [settings] Its local settings.
 * @returns {import('./registry.js').HandlerEntry}
 */
function addLane(registry, lane, handler, settings = {}) {
    const definition = typeof lane === 'string' ? defineLane({ name: lane }) : lane;
    const [entry] = registry.addEntries([{ name: definition.name, definition, handler, settings, where: 'test' }]);

    return entry;
}

const lane = defineConcurrencyLimit({ name: 'lane', max: 3 });
const disk = defineRateLimit({ name: 'disk', max: 2, per: '1s', burst: 2 });

/** @returns {import('./registry.js').Registry} plain, two names in `lane`, and one with `disk` */
function registryOf() {
    const registry = createRegistry({ lanesByName: new Map(), defaultTimeoutMs: null });

    addLane(registry, 'plain', async () => {});
    addLane(registry, 'a', async () => {}, { localConcurrencyLimits: [lane] });
    addLane(registry, 'b', async () => {}, { localConcurrencyLimits: [lane], fairShareWeight: 2 });
    addLane(registry, 'rated', async () => {}, { localRateLimits: [disk] });

    return registry;
}

/**
 * @param {import('./registry.js').Registry} registry
 * @param {string} name
 * @returns {import('./registry.js').HandlerEntry}
 */
function entryOf(registry, name) {
    return /** @type {import('./registry.js').HandlerEntry} */ (registry.getEntry(name));
}

test('the room of a name: Infinity without a local limit, else the lowest of its limits', () => {
    const registry = registryOf();
    const a = entryOf(registry, 'a');
    const rated = entryOf(registry, 'rated');

    expect(limitsRoom(entryOf(registry, 'plain'))).toBe(Infinity);
    expect(limitsRoom(a)).toBe(3);
    a.limits[0].running = 2;
    expect(limitsRoom(entryOf(registry, 'b'))).toBe(1);
    expect(roomOf(a.limits[0])).toBe(1);
    expect(limitsRoom(rated)).toBe(2);
    takeRate(rated.rates[0], nowUs());
    expect(roomOf(rated.rates[0])).toBe(1);
});

test('the local limits of a name: its own array without a rate limit', () => {
    const registry = registryOf();
    const a = entryOf(registry, 'a');

    expect(localLimitsOf(a)).toBe(a.limits);
    expect(localLimitsOf(entryOf(registry, 'rated'))).toStrictEqual(entryOf(registry, 'rated').rates);
});

test('the share names: the names of one limit share one room, at least 0', () => {
    const registry = registryOf();
    const [plain, a, b] = ['plain', 'a', 'b'].map(name => entryOf(registry, name));

    a.limits[0].running = 4;
    a.running = 4;

    const names = shareLanesOf([plain, a, b]);

    expect(names.map(({ name, index, weight, running, available }) => ({ name, index, weight, running, available })))
        .toStrictEqual([
            { name: 'plain', index: 0, weight: 1, running: 0, available: Infinity },
            { name: 'a', index: 1, weight: 1, running: 4, available: Infinity },
            { name: 'b', index: 2, weight: 2, running: 0, available: Infinity },
        ]);
    expect(names[0].limits).toStrictEqual([]);
    expect(names[1].limits[0]).toStrictEqual({ room: 0 });
    expect(names[1].limits[0]).toBe(names[2].limits[0]);
});

test('a name over its local rate limit: a wake of the names of the limit when it admits a start', () => {
    vi.useFakeTimers({ now: 1_000_000 });

    try {
        const registry = registryOf();
        const rated = entryOf(registry, 'rated');
        /** @type {string[][]} */
        const woken = [];
        const wakes = createLocalRateWakes({
            setTimer: (func, delayMs) => setTimeout(func, delayMs),
            clearTimer: timer => clearTimeout(timer),
            wake: names => woken.push(names),
        });

        // Quota left: no timer
        wakes.wakeAfterRates(rated);
        wakes.wakeAfterRates(entryOf(registry, 'plain'));
        expect(vi.getTimerCount()).toBe(0);
        expect(ratesAdmitBefore(registry, ['rated', 'plain'], Date.now() + 10_000)).toBe(false);

        // 2 per s: the next start in 500 ms
        takeRate(rated.rates[0], nowUs());
        takeRate(rated.rates[0], nowUs());
        expect(ratesAdmitBefore(registry, ['rated'], Date.now() + 501)).toBe(true);
        expect(ratesAdmitBefore(registry, ['rated'], Date.now() + 500)).toBe(false);
        wakes.wakeAfterRates(rated);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(499);
        expect(woken).toStrictEqual([]);
        vi.advanceTimersByTime(1);
        expect(woken).toStrictEqual([['rated']]);

        // clear(): no wake
        takeRate(rated.rates[0], nowUs());
        wakes.wakeAfterRates(rated);
        wakes.clear();
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});
