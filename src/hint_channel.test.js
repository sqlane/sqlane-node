import { expect, test } from 'vitest';
import { createHintChannel } from './hint_channel.js';

/**
 * A hint whose subscriptions resolve when the test says so.
 * @returns {{ hint: import('./types.js').Hint, subscribed: () => void, unsubscribes: () => number }}
 */
function slowHint() {
    const pending = Promise.withResolvers();
    let unsubscribes = 0;

    return {
        hint: {
            publish: async () => {},
            subscribe: async () => {
                await pending.promise;

                return async () => {
                    unsubscribes++;
                };
            },
        },
        subscribed: () => pending.resolve(undefined),
        unsubscribes: () => unsubscribes,
    };
}

test.each([
    ['unlisten()', (/** @type {import('./hint_channel.js').HintChannel} */ channel) => channel.unlisten()],
    ['stop()', (/** @type {import('./hint_channel.js').HintChannel} */ channel) => channel.stop()],
])('%s while the subscription is pending: it is unsubscribed once it resolves', async (_, end) => {
    const { hint, subscribed, unsubscribes } = slowHint();
    const channel = createHintChannel({ hint, channel: 'c', reportError: () => {} });
    const listening = channel.listen(() => {});

    await end(channel);
    subscribed();
    await listening;
    expect(unsubscribes()).toBe(1);
    await channel.stop();
    expect(unsubscribes()).toBe(1);
});

test('a subscription that resolves before unlisten(): unlisten() ends it once', async () => {
    const { hint, subscribed, unsubscribes } = slowHint();
    const channel = createHintChannel({ hint, channel: 'c', reportError: () => {} });

    subscribed();
    await channel.listen(() => {});
    await channel.unlisten();
    await channel.unlisten();
    expect(unsubscribes()).toBe(1);
});
