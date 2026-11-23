// Scenarios: migrations; a hint over any pub/sub; stats.
import { sqlane } from './sqlane.js';

/** @returns {Promise<void>} */
export async function migrate() {
    await sqlane.schema.migrate({ lockTimeout: '5m' });
}

/**
 * Any pub/sub as a hint, e.g. Redis, where NOTIFY is not available, as on MySQL and MariaDB. Pass it to
 * createSqlane({ hint }) in place of the adapter's notify. Two clients, one of them subscribed.
 * @param {{ publish(channel: string, message: string): Promise<unknown> }} publisher
 * @param {{
 *     subscribe(channel: string, listener: (message: string) => void): Promise<unknown>,
 *     unsubscribe(channel: string): Promise<unknown>,
 * }} subscriber
 * @returns {import('@sqlane/core').Hint}
 */
export function redisHint(publisher, subscriber) {
    return {
        publish: async (channel, message) => {
            await publisher.publish(channel, message);
        },
        subscribe: async (channel, onMessage) => {
            await subscriber.subscribe(channel, onMessage);

            return async () => {
                await subscriber.unsubscribe(channel);
            };
        },
    };
}

/** @returns {Promise<number>} The jobs that wait the longest, in ms. */
export async function oldestDueAgeMs() {
    const stats = await sqlane.jobs.stats();

    return Math.max(0, ...stats.map(row => row.oldestDueAgeMs ?? 0));
}
