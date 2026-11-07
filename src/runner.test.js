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
