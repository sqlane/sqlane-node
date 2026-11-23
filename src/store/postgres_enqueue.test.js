import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { insertJobsPostgres, toJobInput } from './postgres_enqueue.js';
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
        .toBe('8c85c3161bd98b9fca2d3302bf268348c7cfdb8d6f4709111454e36e57aa9e5d');
});

test('the jobs of slots: one NOTIFY per name, run by a reference', async () => {
    const { sql, params } = await capture(executor => insertScheduledJobsPostgres(executor, 'sqlane_', [], {
        enqueueToken: 't',
        notifyChannel: 'sqlane_ready',
    }));

    expect(sql).toMatch(/SELECT pg_notify\(\$3, d\.lane\)\s+FROM \(SELECT DISTINCT lane FROM inserted\) AS d/);
    expect(sql).toMatch(/SELECT id FROM inserted WHERE \(SELECT count\(\*\) FROM notified\) >= 0/);
    expect(params).toStrictEqual(['[]', 't', 'sqlane_ready']);
});

test('the input of a job: its rate limits as a JSON array, null without', () => {
    /** @type {import('../new_job.js').NewJob} */
    const job = {
        id: 'a',
        hasJobId: false,
        lane: 'a',
        payloadJson: '{}',
        limits: [],
        rateLimits: [{ key: '@api', max: 10, per_us: 1_000_000, burst: 2, cost: 1 }],
        maxAttempts: 1,
        maxStalls: 0,
        completedRetentionMs: 0,
        failedRetentionMs: 0,
        failureLane: null,
        delayMs: 0,
        runAt: null,
    };

    expect(toJobInput(job)).toMatchObject({ limit_keys: null, limit_maxes: null, rate_limits: job.rateLimits });
    expect(toJobInput({ ...job, rateLimits: [] })).toMatchObject({ rate_limits: null });
});
