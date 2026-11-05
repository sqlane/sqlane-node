// Scenarios: PostgreSQL with NOTIFY hints; migrations; a hint over any pub/sub; stats.
import { Pool } from 'pg';
import { createSqlane, getMigrations } from '@sqlane/core';
import { pgAdapter } from '@sqlane/core/pg';

const queuePool = new Pool({ connectionString: 'postgres://app@localhost/app', max: 3 });

export const sqlane = createSqlane({
    adapter: pgAdapter(queuePool, { notify: true }),
});

/** @returns {Promise<void>} */
export async function migrate() {
    await sqlane.migrate({ lockTimeout: '5m' });
}

/** @returns {string[]} The SQL for the app's own migration tool. */
export function migrationSql() {
    return getMigrations({ dialect: 'postgres' }).flatMap(migration => migration.statements);
}

/**
 * Any pub/sub as a hint, e.g. Redis: two clients, one of them subscribed.
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
    const stats = await sqlane.getStats();

    return Math.max(0, ...stats.map(row => row.oldestDueAgeMs ?? 0));
}
