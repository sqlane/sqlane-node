import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
        .toBe('9ad4758613310944475a2dd6ec4edddf545e52c81264d1c55d4593efa50626a1');
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
        delayMs: 0,
        runAt: null,
        fairGroup: null,
    };

    expect(toJobInput(job)).toMatchObject({ limit_keys: null, limit_maxes: null, rate_limits: job.rateLimits });
    expect(toJobInput({ ...job, rateLimits: [] })).toMatchObject({ rate_limits: null });
    // The failure lane is not stored: the definition of the process that fails the job decides
    expect(toJobInput(job)).not.toHaveProperty('failure_lane');
});

test('every insert of jobs in src/ writes the fair group: the inventory of the inserts', () => {
    const src = join(import.meta.dirname, '..');
    const insertOfJobs = /INSERT INTO \$\{p\}jobs/u;
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
        .filter(file => /(?<!\.test)\.js$/u.test(file))
        .filter(file => insertOfJobs.test(readFileSync(join(src, file), 'utf8')));

    // A new insert of jobs: give it the column of the group (only when a job has one), then add it here
    expect(files.toSorted()).toStrictEqual([
        join('store', 'mariadb_enqueue.js'),
        join('store', 'mysql_enqueue.js'),
        join('store', 'postgres_enqueue.js'),
        join('store', 'postgres_schedules.js'),
    ]);

    for (const file of files) {
        expect(readFileSync(join(src, file), 'utf8')).toContain('fair_group');
    }
});

test('the input of a job: its fair group; the statement names the column only when a job has a group', async () => {
    /** @type {import('../new_job.js').NewJob} */
    const job = {
        id: 'a', hasJobId: false, lane: 'a', payloadJson: '{}', limits: [], rateLimits: [], maxAttempts: 1, maxStalls: 0,
        completedRetentionMs: 0, failedRetentionMs: 0, delayMs: 0, runAt: null, fairGroup: 'g',
    };
    const grouped = await capture(executor => insertJobsPostgres(executor, 'sqlane_', [job, { ...job, id: 'b',
        fairGroup: null }], { enqueueToken: 't' }));
    const plain = await capture(executor => insertJobsPostgres(executor, 'sqlane_', [{ ...job, fairGroup: null }], {
        enqueueToken: 't',
    }));

    expect(toJobInput(job)).toMatchObject({ fair_group: 'g' });
    expect(grouped.sql).toMatch(/updated_at, fair_group\)/);
    expect(plain.sql).not.toMatch(/fair_group/);
});
