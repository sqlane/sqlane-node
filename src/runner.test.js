import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { resolveDefaults } from './defaults.js';
import { createHintChannel } from './hint_channel.js';
import { createRegistry } from './registry.js';
import { createRunner } from './runner.js';

/**
 * A runner over a store of no jobs, whose makeDue() fails as given, call after call.
 * @param {unknown[]} makeDueErrors
 * @returns {{ runner: import('./runner.js').Runner, events: import('./types.js').SqlaneEvent[] }}
 */
function runnerWith(makeDueErrors) {
    const registry = createRegistry({
        jobsByName: new Map(),
        lanes: undefined,
        concurrency: 10,
        defaultTimeoutMs: null,
    });
    /** @type {import('./types.js').SqlaneEvent[]} */
    const events = [];
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        makeDue: async () => {
            const error = makeDueErrors.shift();

            if (error) {
                throw error;
            }
        },
        findCandidates: async () => [],
        claimDue: async () => [],
    }));

    registry.handle('ping', () => {});

    return {
        runner: createRunner({
            store,
            registry,
            concurrency: 10,
            defaults: resolveDefaults(),
            cleanup: false,
            logger: undefined,
            onEvent: event => events.push(event),
            hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
            hintsAfterCommit: false,
        }),
        events,
    };
}

test('drain: a deadlock in a round is retried, not thrown', async () => {
    const deadlock = Object.assign(new Error('Deadlock found when trying to get lock'), { errno: 1213 });
    const { runner, events } = runnerWith([deadlock, deadlock]);

    await expect(runner.drain({ includeDelayed: true }))
        .resolves.toStrictEqual({ completed: 0, retried: 0, failed: 0 });
    expect(events).toMatchObject([
        { type: 'error', operation: 'drain', error: deadlock },
        { type: 'error', operation: 'drain', error: deadlock },
    ]);
});

test('drain: another error rejects', async () => {
    const { runner } = runnerWith([new Error('syntax error')]);

    await expect(runner.drain({ includeDelayed: true })).rejects.toThrow('syntax error');
});

/**
 * @typedef {object} HintedRunner
 * @property {import('./runner.js').Runner} runner
 * @property {() => number} probes The probes so far.
 * @property {(name: string) => void} deliver Delivers a hint message.
 */

/**
 * A started runner of the name `ping`, over a store of no jobs, with a hint whose messages the test delivers.
 * @param {boolean} hintsAfterCommit
 * @returns {Promise<HintedRunner>}
 */
async function runnerWithHint(hintsAfterCommit) {
    const registry = createRegistry({
        jobsByName: new Map(),
        lanes: undefined,
        concurrency: 10,
        defaultTimeoutMs: null,
    });
    let probes = 0;
    /** @type {((message: string) => void) | null} */
    let deliver = null;
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async () => {
            probes++;

            return [];
        },
    }));

    registry.handle('ping', () => {});

    const runner = createRunner({
        store,
        registry,
        concurrency: 10,
        defaults: resolveDefaults(),
        cleanup: false,
        logger: undefined,
        onEvent: undefined,
        hintChannel: createHintChannel({
            hint: {
                publish: async () => {},
                subscribe: async (_channel, onMessage) => {
                    deliver = onMessage;

                    return async () => {};
                },
            },
            channel: 'c',
            reportError: () => {},
        }),
        hintsAfterCommit,
    });

    await runner.start();
    // The first turn
    await sleep(50);

    return { runner, probes: () => probes, deliver: name => deliver?.(name) };
}

test.each([
    { hint: 'NOTIFY, after the commit: probes at once', hintsAfterCommit: true, probes: 1 },
    { hint: 'other, before the commit: re-probes from 20 ms', hintsAfterCommit: false, probes: 0 },
])('a hint: $hint', async ({ hintsAfterCommit, probes: expected }) => {
    const { runner, probes, deliver } = await runnerWithHint(hintsAfterCommit);
    const before = probes();

    deliver('ping');
    await sleep(10);
    expect(probes() - before).toBe(expected);
    await runner.close({ deadline: 0 });
});

/** @returns {number} The timers that keep the process alive. */
function refTimers() {
    return process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
}

test('close() leaves no timer that keeps the process alive', async () => {
    const before = refTimers();
    const { runner } = runnerWith([]);

    await runner.start();
    await runner.close({ deadline: '30s' });
    expect(refTimers()).toBe(before);
});
