import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { insertJobsPostgres } from './postgres_enqueue.js';
import { insertScheduledJobsPostgres } from './postgres_schedules.js';

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

    // Changed on purpose? Measure with `pnpm bench:regression`, then pin the new hash.
    expect(createHash('sha256').update(sql).digest('hex'))
        .toBe('d0f4d836652a839144f84e51a0163e2a81dd3871295db9d729e81a6767203885');
});

test('the jobs of slots: one NOTIFY per name, run by a reference', async () => {
    const { sql, params } = await capture(executor => insertScheduledJobsPostgres(executor, 'sqlane_', [], {
        enqueueToken: 't',
        notifyChannel: 'sqlane_ready',
    }));

    expect(sql).toMatch(/SELECT pg_notify\(\$3, d\.job_name\)\s+FROM \(SELECT DISTINCT job_name FROM inserted\) AS d/);
    expect(sql).toMatch(/SELECT id FROM inserted WHERE \(SELECT count\(\*\) FROM notified\) >= 0/);
    expect(params).toStrictEqual(['[]', 't', 'sqlane_ready']);
});
