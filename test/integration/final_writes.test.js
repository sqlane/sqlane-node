import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { resolveDefaults } from '../../src/defaults.js';
import { toErrorJson } from '../../src/error_json.js';
import { createSqlane, defineJob } from '../../src/index.js';
import { buildNewJob } from '../../src/new_job.js';
import { createStore } from '../../src/store/store.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from './helpers/test_database.js';

/** @typedef {import('../../src/store/store.js').ClaimedJob} ClaimedJob */
/** @typedef {import('../../src/store/store.js').Store} Store */

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const READ_JOB_SQL = {
    mysql: p => `
        SELECT j.status, j.attempts, j.stalls, j.lock_token, j.failure_job, CAST(j.last_error AS CHAR) AS last_error,
               CAST(pl.payload AS CHAR) AS payload,
               TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), j.run_at) DIV 1000 AS run_in_ms,
               TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), j.locked_until) DIV 1000 AS lease_in_ms,
               TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), j.expires_at) DIV 1000 AS expires_in_ms,
               j.timed_out_at IS NOT NULL AS timed_out
          FROM ${p}jobs j LEFT JOIN ${p}payloads pl ON pl.id = j.id WHERE j.id = ?`,
    postgres: p => `
        SELECT j.status, j.attempts, j.stalls, j.lock_token, j.failure_job, j.last_error::text AS last_error,
               pl.payload::text AS payload,
               (EXTRACT(EPOCH FROM j.run_at - clock_timestamp()) * 1000)::bigint AS run_in_ms,
               (EXTRACT(EPOCH FROM j.locked_until - clock_timestamp()) * 1000)::bigint AS lease_in_ms,
               (EXTRACT(EPOCH FROM j.expires_at - clock_timestamp()) * 1000)::bigint AS expires_in_ms,
               j.timed_out_at IS NOT NULL AS timed_out
          FROM ${p}jobs j LEFT JOIN ${p}payloads pl ON pl.id = j.id WHERE j.id = $1`,
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const READ_HOLDS_SQL = {
    mysql: p => `SELECT mutex_key, job_id, TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), held_until) DIV 1000 AS held_in_ms
                  FROM ${p}mutexes ORDER BY mutex_key`,
    postgres: p => `SELECT mutex_key, job_id,
                           (EXTRACT(EPOCH FROM held_until - clock_timestamp()) * 1000)::bigint AS held_in_ms
                      FROM ${p}mutexes ORDER BY mutex_key`,
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const INSERT_HOLD_SQL = {
    mysql: p => `INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
                 VALUES (?, ?, ?, UTC_TIMESTAMP(3) + INTERVAL ? SECOND, UTC_TIMESTAMP(3))`,
    postgres: p => `INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
                    VALUES ($1, $2, $3, clock_timestamp() + $4 * interval '1 second', clock_timestamp())`,
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const INSERT_ORPHAN_SQL = {
    mysql: p => `INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
                 VALUES (?, ?, ?, NULL, UTC_TIMESTAMP(3))`,
    postgres: p => `INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
                    VALUES ($1, $2, $3, NULL, clock_timestamp())`,
};

const LEASE_MS = 240_000;
const defaults = resolveDefaults();
const keyed = defineJob({
    name: 'sync_order',
    mutexKeys: payload => [`order:${payload.orderId}`],
    timeout: '1m',
    failureJob: 'sync_failed',
});

/** @type {import('./helpers/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
let prefixCount = 0;

beforeAll(async () => {
    database = await connectTestDatabase();
    testAdapter = createTestAdapter();
});

afterAll(async () => {
    await testAdapter?.close();
    await database?.close();
});

/**
 * @returns {Promise<{ p: string, sqlane: import('../../src/types.js').Sqlane<any, never>, store: Store }>}
 */
async function freshTables() {
    prefixCount++;

    const p = `${database.tablePrefix}${prefixCount}_`;
    const sqlane = createSqlane({ adapter: testAdapter.adapter, tablePrefix: p });

    await sqlane.migrate();

    return { p, sqlane, store: createStore(testAdapter.adapter, p) };
}

/**
 * Enqueues a due keyed job and claims it.
 * @param {{ sqlane: import('../../src/types.js').Sqlane<any, never>, store: Store }} tables
 * @param {Record<string, unknown>} [options] Enqueue options.
 * @param {number} [leaseMs]
 * @returns {Promise<ClaimedJob>}
 */
async function claimedJob({ sqlane, store }, options = {}, leaseMs = LEASE_MS) {
    const { id } = await sqlane.enqueue(testAdapter.pool, keyed, { orderId: 1 }, {
        runAt: new Date(Date.now() - 1000),
        ...options,
    });
    const [job] = await store.claim({
        candidateIds: [id],
        lockToken: `T${Date.now()}${Math.random()}`.slice(0, 26),
        lockedBy: 'test',
        leaseMs,
        pick: locked => locked,
    });

    return job;
}

/**
 * @param {string} p
 * @param {string} id
 * @returns {Promise<Record<string, any> | undefined>}
 */
async function readJob(p, id) {
    const [row] = await database.query(READ_JOB_SQL[database.dialect](p), [id]);

    return row && {
        ...row,
        last_error: row.last_error === null ? null : JSON.parse(String(row.last_error)),
        payload: row.payload === null ? null : JSON.parse(String(row.payload)),
        run_in_ms: Number(row.run_in_ms),
        lease_in_ms: row.lease_in_ms === null ? null : Number(row.lease_in_ms),
        expires_in_ms: row.expires_in_ms === null ? null : Number(row.expires_in_ms),
        timed_out: Boolean(row.timed_out),
    };
}

/**
 * @param {string} p
 * @returns {Promise<{ mutex_key: string, job_id: string, held_in_ms: number | null }[]>}
 */
async function readHolds(p) {
    return (await database.query(READ_HOLDS_SQL[database.dialect](p))).map(row => ({
        mutex_key: String(row.mutex_key),
        job_id: String(row.job_id),
        held_in_ms: row.held_in_ms === null ? null : Number(row.held_in_ms),
    }));
}

/** @type {import('../../src/store/store.js').FailureJobBuilder} */
function buildFailureJob(failed) {
    return buildNewJob({
        name: failed.failureJob,
        definition: null,
        defaults,
        payload: { job: failed, error: failed.error },
        options: undefined,
        maxPayloadBytes: Infinity,
    });
}

test('renewLeases: the own jobs only', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables, {}, 1000);
    const renewed = await tables.store.renewLeases([job, { id: job.id, lockToken: 'other' }], 600_000);

    expect(renewed).toStrictEqual(new Set([job.id]));
    expect((await readJob(tables.p, job.id))?.lease_in_ms).toBeGreaterThan(590_000);
});

test('completeJob: completed until its retention, without payload and keys; a replay changes nothing', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables, { retention: { completed: '10m' } });

    await expect(tables.store.completeJob(job)).resolves.toBe(true);
    await expect(tables.store.completeJob(job)).resolves.toBe(false);

    const row = await readJob(tables.p, job.id);

    expect(row).toMatchObject({ status: 'completed', lock_token: null, payload: null, lease_in_ms: null });
    expect(row?.expires_in_ms).toBeGreaterThan(590_000);
    await expect(readHolds(tables.p)).resolves.toStrictEqual([]);
});

test('a write with another lock token changes nothing', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables);
    const other = { id: job.id, lockToken: 'other' };

    await expect(tables.store.completeJob(other)).resolves.toBe(false);
    await expect(tables.store.retryJob(other, { delayMs: 0, error: toErrorJson('x') })).resolves.toBe(false);
    await expect(tables.store.releaseJob(other, { delayMs: 0, lingerMs: 0 })).resolves.toBe(false);
    await expect(tables.store.failJob(other, { error: toErrorJson('x'), buildFailureJob }))
        .resolves.toStrictEqual({ changed: false, failureJob: null });
    await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'running', lock_token: job.lockToken });
    await expect(readHolds(tables.p)).resolves.toMatchObject([{ mutex_key: 'order:1', job_id: job.id }]);
});

test('retryJob: pending after the delay, one attempt used, the error kept, the keys freed', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables);

    await expect(tables.store.retryJob(job, { delayMs: 60_000, error: toErrorJson(new Error('boom')) }))
        .resolves.toBe(true);

    const row = await readJob(tables.p, job.id);

    expect(row).toMatchObject({ status: 'pending', attempts: 1, lock_token: null, last_error: { message: 'boom' } });
    expect(row?.run_in_ms).toBeGreaterThan(55_000);
    await expect(readHolds(tables.p)).resolves.toStrictEqual([]);
});

describe('failJob', () => {
    test('failed with its payload; its failure job added in the same transaction', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables, { jobId: 'o1' });
        const result = await tables.store.failJob(job, { error: toErrorJson(new Error('gone')), buildFailureJob });

        expect(result).toMatchObject({ changed: true, failureJob: { added: { name: 'sync_failed' } } });
        await expect(readJob(tables.p, job.id)).resolves.toMatchObject({
            status: 'failed',
            attempts: 1,
            payload: { orderId: 1 },
            last_error: { name: 'Error', message: 'gone' },
        });

        const failureId = /** @type {{ added: { id: string } }} */ (result.failureJob).added.id;

        await expect(readJob(tables.p, failureId)).resolves.toMatchObject({
            status: 'pending',
            failure_job: null,
            payload: {
                job: { id: 'sync_order:o1', name: 'sync_order', payload: { orderId: 1 }, attempt: 1, maxAttempts: 3 },
                error: { name: 'Error', message: 'gone' },
            },
        });
        await expect(readHolds(tables.p)).resolves.toStrictEqual([]);
    });

    test('a failure job that the database refuses: the job still fails, without it', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables);
        const result = await tables.store.failJob(job, {
            error: toErrorJson('gone'),
            buildFailureJob: failed => ({ ...buildFailureJob(failed), name: 'x'.repeat(200) }),
        });

        expect(result.changed).toBe(true);
        expect(result.failureJob).toHaveProperty('notAdded');
        await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'failed' });

        const [{ count }] = await database.query(`SELECT COUNT(*) AS count FROM ${tables.p}jobs`);

        expect(Number(count)).toBe(1);
    });

    test('a failure job that cannot be built: the job still fails, without it', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables);
        const result = await tables.store.failJob(job, {
            error: toErrorJson('gone'),
            buildFailureJob: () => {
                throw new Error('bad options');
            },
        });

        expect(result).toMatchObject({ changed: true, failureJob: { notAdded: { message: 'bad options' } } });
    });
});

test('releaseJob: pending without an attempt used; the keys freed, or lingering while the handler runs', async () => {
    const tables = await freshTables();
    const freed = await claimedJob(tables);

    await expect(tables.store.releaseJob(freed, { delayMs: 0, lingerMs: 0 })).resolves.toBe(true);
    await expect(readJob(tables.p, freed.id)).resolves.toMatchObject({ status: 'pending', attempts: 0 });
    await expect(readHolds(tables.p)).resolves.toStrictEqual([]);

    const lingering = await claimedJob(tables);

    await tables.store.releaseJob(lingering, { delayMs: 32_000, lingerMs: 32_000 });

    const [hold] = await readHolds(tables.p);

    expect(hold.held_in_ms).toBeGreaterThan(30_000);
    expect((await readJob(tables.p, lingering.id))?.run_in_ms).toBeGreaterThan(30_000);
});

test('markTimedOut: the job stays running, marked; the next claim clears the mark', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables);

    await expect(tables.store.markTimedOut(job)).resolves.toBe(true);
    await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'running', timed_out: true });
    await tables.store.retryJob(job, { delayMs: 0, error: toErrorJson('timeout') });
    await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'pending', timed_out: false });
});

describe('stall recovery', () => {
    test('a stale job: one more stall, pending after 30 s; its keys linger for one lease', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables, {}, 1);

        await sleep(20);
        await expect(tables.store.findStaleJobs(10)).resolves.toStrictEqual([{ id: job.id, name: 'sync_order' }]);
        await expect(tables.store.recoverStaleJob(job.id, { leaseMs: 60_000, buildFailureJob }))
            .resolves.toStrictEqual({ result: 'released', failureJob: null });

        const row = await readJob(tables.p, job.id);

        expect(row).toMatchObject({ status: 'pending', stalls: 1, attempts: 0, last_error: { name: 'StalledError' } });
        expect(row?.run_in_ms).toBeGreaterThan(28_000);
        expect((await readHolds(tables.p))[0].held_in_ms).toBeGreaterThan(55_000);
        await expect(tables.store.recoverStaleJob(job.id, { leaseMs: 60_000, buildFailureJob }))
            .resolves.toStrictEqual({ result: null, failureJob: null });
    });

    test('after maxStalls: fails for good, with its failure job', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables, { maxStalls: 0 }, 1);

        await sleep(20);

        const recovered = await tables.store.recoverStaleJob(job.id, { leaseMs: 60_000, buildFailureJob });

        expect(recovered).toMatchObject({ result: 'failed', failureJob: { added: { name: 'sync_failed' } } });
        await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'failed', stalls: 1 });
    });

    test('a running job with its lease is not stale', async () => {
        const tables = await freshTables();

        await claimedJob(tables);
        await expect(tables.store.findStaleJobs(10)).resolves.toStrictEqual([]);
    });
});

test('sweepMutexes: deletes the ended lingers and the holds without their running job', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables);
    const insertHold = INSERT_HOLD_SQL[database.dialect](tables.p);

    await database.query(insertHold, ['ended', 'gone', 'old', -1]);
    await database.query(insertHold, ['future', 'gone', 'old', 3600]);
    await database.query(INSERT_ORPHAN_SQL[database.dialect](tables.p), ['orphan', 'gone', 'old']);

    await expect(tables.store.sweepMutexes(100)).resolves.toStrictEqual({ lingers: 1, orphans: 1 });
    await expect(readHolds(tables.p)).resolves.toMatchObject([
        { mutex_key: 'future' },
        { mutex_key: 'order:1', job_id: job.id },
    ]);
});

test('deleteExpiredJobs: the finished jobs after their retention, with their payloads', async () => {
    const tables = await freshTables();
    // One after the other: the jobs share their mutex key
    const completed = await claimedJob(tables, { retention: { completed: 0 } });

    await tables.store.completeJob(completed);

    const failed = await claimedJob(tables, { retention: { failed: 0 } });

    await tables.store.failJob(failed, { error: toErrorJson('x'), buildFailureJob });

    const kept = await claimedJob(tables, { retention: { completed: '1h' } });

    await tables.store.completeJob(kept);
    await sleep(5);

    await expect(tables.store.deleteExpiredJobs(100)).resolves.toBe(2);
    await expect(readJob(tables.p, failed.id)).resolves.toBeUndefined();
    await expect(readJob(tables.p, kept.id)).resolves.toMatchObject({ status: 'completed' });

    const ids = new Set([completed.id, failed.id, kept.id]);
    const payloads = await database.query(`SELECT id FROM ${tables.p}payloads`);

    expect(payloads.filter(row => ids.has(String(row.id)))).toStrictEqual([]);
});
