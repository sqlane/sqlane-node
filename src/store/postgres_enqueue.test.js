import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { insertJobsPostgres } from './postgres_enqueue.js';

/**
 * @param {(executor: import('../types.js').Executor) => Promise<unknown>} func
 * @returns {Promise<{ sql: string, params: readonly unknown[] }>} The statement that func sent.
 */
async function capture(func) {
    /** @type {{ sql: string, params: readonly unknown[] }[]} */
    const sent = [];

    await func({
        query: async (sql, params) => {
            sent.push({ sql, params });

            return [];
        },
        run: async () => 0,
    });

    return sent[0];
}

test('the enqueue statement is pinned: its prepared statement does not change by accident', async () => {
    const { sql } = await capture(executor => insertJobsPostgres(executor, 'sqlane_', [], { enqueueToken: 't' }));

    // Changed on purpose? Measure with `pnpm bench:cpu`, then pin the new hash.
    expect(createHash('sha256').update(sql).digest('hex'))
        .toBe('baab81f8b10f08e35523208c90cc802fce95ca69c44a64dc2c163b7614ec38c8');
});
