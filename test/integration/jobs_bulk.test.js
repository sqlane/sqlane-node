// sqlane.jobs.retry(), cancel() and remove(): through the public API, on each database. The hooks of hook_adapter.js
// run code between two statements of a call, for the races.
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import {
    createSqlane,
    defineConcurrencyLimit,
    defineJob,
    FatalJobError,
    IgnoredJobsError,
    InvalidOptionsError,
    JobCancelledError,
} from '../../src/index.js';
import { pgAdapter } from '../../src/adapters/pg.js';
import { hookAdapter } from './helpers/hook_adapter.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @typedef {import('../../src/types.js').Sqlane<any>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */

/** Fast timers: the tests wait milliseconds, not minutes */
const TIMINGS = { leaseMs: 5000, renewIntervalMs: 500, recoveryIntervalMs: 60_000 };

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];

beforeAll(async () => {
    database = await connectTestDatabase();
    testAdapter = createTestAdapter();
});

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await testAdapter?.close();
    await database?.close();
});

/**
 * @returns {string} A table prefix of its own.
 */
function nextPrefix() {
    prefixCount++;

    return `${database.tablePrefix}${prefixCount}_`;
}

/**
 * A sqlane instance on the tables of a prefix.
 * @param {string} p
 * @param {Partial<import('../../src/types.js').SqlaneOptions<any>>} [options]
 * @returns {{ sqlane: Sqlane, events: SqlaneEvent[] }}
 */
function sqlaneOn(p, options = {}) {
    /** @type {SqlaneEvent[]} */
    const events = [];
    const sqlane = createSqlane(/** @type {any} */ ({
        adapter: testAdapter.adapter,
        tablePrefix: p,
        pollInterval: '100ms',
        timings: TIMINGS,
        onEvent: (/** @type {SqlaneEvent} */ event) => events.push(event),
        ...options,
    }));

    instances.push(sqlane);

    return { sqlane, events };
}

/**
 * An `onEvent` that reads the status of each cancelled job at once, with `jobs.get`: on the queue's pool, another
 * connection than the one of the cancel. Before the commit, it would read the job as it was.
 * @param {{ sqlane: Sqlane | null }} holder The instance, set once created.
 * @param {Promise<unknown>[]} reads Gets the status read for each event.
 * @returns {(event: SqlaneEvent) => void}
 */
function readStatusOnCancel(holder, reads) {
    /**
     * @param {string} jobId
     * @returns {Promise<unknown>}
     */
    const statusOf = async jobId => (await /** @type {Sqlane} */ (holder.sqlane).jobs.get(jobId))?.status;

    return (event) => {
        if (event.type === 'cancelled') {
            reads.push(statusOf(event.jobId));
        }
    };
}

/**
 * A migrated instance on tables of its own.
 * @param {Partial<import('../../src/types.js').SqlaneOptions<any>>} [options]
 * @returns {Promise<{ sqlane: Sqlane, events: SqlaneEvent[], p: string }>}
 */
async function fresh(options = {}) {
    const p = nextPrefix();
    const { sqlane, events } = sqlaneOn(p, options);

    await sqlane.migrate();

    return { sqlane, events, p };
}

/**
 * Raw SQL of the test, with `?` placeholders, on either family.
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<any[]>}
 */
function raw(sql, params = []) {
    let index = 0;

    return database.query(database.family === 'postgres' ? sql.replaceAll('?', () => `$${++index}`) : sql, params);
}

/**
 * Waits until the condition holds.
 * @param {() => Promise<boolean> | boolean} condition
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitFor(condition, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;

    // oxlint-disable-next-line no-await-in-loop -- polls
    while (!await condition()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor: timed out');
        }

        // oxlint-disable-next-line no-await-in-loop -- polls
        await sleep(10);
    }
}

/**
 * Failed jobs of a name: enqueued, then failed for good by a drain of an instance whose handler throws.
 * @param {string} p
 * @param {string} name
 * @param {unknown[]} payloads
 * @param {import('../../src/types.js').EnqueueOptions} [options]
 * @returns {Promise<string[]>} Their ids.
 */
async function failedJobs(p, name, payloads, options = {}) {
    const { sqlane } = sqlaneOn(p);

    sqlane.handle(name, () => {
        throw new FatalJobError('boom');
    });

    const items = /** @type {any[]} */ (payloads.map(payload => ({ payload, options })));
    const results = await sqlane.enqueueMany(testAdapter.pool, name, items);

    await sqlane.drain();
    await sqlane.close();

    return results.map(({ id }) => id);
}

/**
 * A handler that holds its first run until the returned release is called; the next runs end at once.
 * @param {string[]} ran The ids of the runs, in order.
 * @returns {{ handler: import('../../src/types.js').Handler, release: () => void }}
 */
function holdingFirst(ran) {
    const { promise: firstHeld, resolve } = Promise.withResolvers();

    return {
        handler: async ({ job }) => {
            ran.push(job.id);
            await (ran.length === 1 ? firstHeld : undefined);
        },
        release: () => resolve(undefined),
    };
}

/**
 * A memory pub/sub, as Redis would be.
 * @returns {import('../../src/types.js').Hint & { published: string[] }}
 */
function memoryHint() {
    const bus = new EventEmitter();
    /** @type {string[]} */
    const published = [];

    return {
        published,
        publish: async (/** @type {string} */ channel, /** @type {string} */ message) => {
            published.push(message);
            bus.emit(channel, message);
        },
        subscribe: async (/** @type {string} */ channel, /** @type {(message: string) => void} */ onMessage) => {
            bus.on(channel, onMessage);

            return async () => {
                bus.off(channel, onMessage);
            };
        },
    };
}

describe('jobs.retry()', () => {
    test('a failed job: pending, due now; same id, enqueue time, last run, last error and payload; attempts 0',
        async () => {
            const { sqlane, p } = await fresh();
            const [id] = await failedJobs(p, 'ping', [{ n: 1 }]);
            const before = await sqlane.jobs.get(id);
            const result = await sqlane.jobs.retry({ jobIds: [id] }, { includeAffectedJobIds: true });
            const after = await sqlane.jobs.get(id);

            expect(result).toStrictEqual({ affectedCount: 1, affectedJobIds: [id], ignoredJobs: [] });
            expect(after).toMatchObject({
                status: 'pending',
                attempts: 0,
                stalls: 0,
                maxAttempts: 3,
                finishedAt: null,
                expiresAt: null,
                blockedOn: null,
                enqueuedAt: before?.enqueuedAt,
                startedAt: before?.startedAt,
                lastError: { name: 'FatalJobError', message: 'boom' },
                payload: { n: 1 },
            });
            expect(Math.abs(Number(after?.runAt) - Date.now())).toBeLessThan(5000);
        });

    test('a retried job runs; when it fails again, it adds a second failure job, from attempt 1', async () => {
        const p = nextPrefix();
        const { sqlane } = sqlaneOn(p);
        /** @type {unknown[]} */
        const failures = [];
        const flaky = defineJob({ name: 'flaky', maxAttempts: 1, failureJob: 'flaky_failed' });

        sqlane.handle(flaky, () => {
            throw new Error('again');
        });
        sqlane.handle('flaky_failed', ({ payload }) => {
            failures.push(payload.job.attempt);
        });
        await sqlane.migrate();

        const { id } = await sqlane.enqueue(testAdapter.pool, flaky, {});

        await sqlane.drain();
        await sqlane.jobs.retry({ jobIds: [id] });
        await sqlane.drain();

        expect(failures).toStrictEqual([1, 1]);
        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'failed', attempts: 1 });
    });

    test('one_more: maxAttempts becomes attempts + 1, maxStalls max(maxStalls, stalls); a later reset keeps them',
        async () => {
            const { sqlane, p } = await fresh();
            const [byAttempts, byStalls] = await failedJobs(p, 'ping', [{}, {}], { maxAttempts: 2 });

            // A job that its stalls failed: stalls above its max
            await raw(`UPDATE ${p}jobs SET stalls = 3, max_stalls = 2, attempts = 0 WHERE id = ?`, [byStalls]);
            await sqlane.jobs.retry({ jobIds: [byAttempts, byStalls] }, { budget: 'one_more' });

            await expect(sqlane.jobs.get(byAttempts)).resolves
                .toMatchObject({ status: 'pending', attempts: 1, maxAttempts: 2, stalls: 0, maxStalls: 2 });
            await expect(sqlane.jobs.get(byStalls)).resolves
                .toMatchObject({ status: 'pending', attempts: 0, maxAttempts: 1, stalls: 3, maxStalls: 3 });

            await raw(`UPDATE ${p}jobs SET status = 'failed' WHERE id = ?`, [byStalls]);
            await sqlane.jobs.retry({ jobIds: [byStalls] });

            await expect(sqlane.jobs.get(byStalls)).resolves
                .toMatchObject({ attempts: 0, maxAttempts: 1, stalls: 0, maxStalls: 3 });
        });

    test('a cancelled job that never ran, then one_more: maxAttempts 1', async () => {
        const { sqlane } = await fresh();
        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' });

        await sqlane.jobs.cancel({ jobIds: [id] });
        await sqlane.jobs.retry({ jobIds: [id] }, { budget: 'one_more' });

        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'pending', attempts: 0, maxAttempts: 1 });
    });

    test('ignored: unknown and impossible ids, other statuses, no payload; a filter skips them silently', async () => {
        const { sqlane, p } = await fresh();
        const [failed, noPayload] = await failedJobs(p, 'ping', [{}, {}]);
        const { id: pending } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' });

        await raw(`DELETE FROM ${p}payloads WHERE id = ?`, [noPayload]);

        await expect(sqlane.jobs.retry({ jobIds: ['ping:none', noPayload, pending, 'x ', failed, 'ping:none'] }))
            .resolves.toStrictEqual({
                affectedCount: 1,
                ignoredJobs: [
                    { jobId: 'ping:none', reason: 'not_found' },
                    { jobId: noPayload, reason: 'no_payload', status: 'failed' },
                    { jobId: pending, reason: 'status', status: 'pending' },
                    { jobId: 'x ', reason: 'not_found' },
                ],
            });
        await raw(`UPDATE ${p}jobs SET status = 'failed' WHERE id = ?`, [failed]);
        await expect(sqlane.jobs.retry({ jobName: 'ping' })).resolves
            .toStrictEqual({ affectedCount: 1, ignoredJobs: [] });
        await expect(sqlane.jobs.get(noPayload)).resolves.toMatchObject({ status: 'failed' });
    });

    test('a completed id is ignored by its status; completed in a filter rejects', async () => {
        const { sqlane } = await fresh();

        sqlane.handle('ping', () => {});

        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {});

        await sqlane.drain();
        await expect(sqlane.jobs.retry({ jobIds: [id] })).resolves.toStrictEqual({
            affectedCount: 0,
            ignoredJobs: [{ jobId: id, reason: 'status', status: 'completed' }],
        });
        await expect(sqlane.jobs.retry({ jobName: 'ping', status: 'completed' })).rejects
            .toBeInstanceOf(InvalidOptionsError);
    });

    test('a job of a name that no process handles, with unknownJobs reject: retried', async () => {
        const { sqlane, p } = await fresh();
        const [id] = await failedJobs(p, 'elsewhere', [{}]);
        const { sqlane: strictOne } = sqlaneOn(p, { unknownJobs: 'reject' });

        await expect(strictOne.jobs.retry({ jobIds: [id] })).resolves.toMatchObject({ affectedCount: 1 });
        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'pending' });
    });

    test('the retried jobs wake a started worker; the hint goes out from a process that cannot start them; no event',
        async () => {
            const p = nextPrefix();
            const hint = memoryHint();
            const { sqlane: worker } = sqlaneOn(p, { hint, pollInterval: '10s' });
            const { sqlane: producer, events } = sqlaneOn(p, { hint });

            await producer.migrate();

            const [id] = await failedJobs(p, 'ping', [{}]);
            const ran = /** @type {string[]} */ ([]);

            worker.handle('ping', ({ job }) => {
                ran.push(job.id);
            });
            await worker.start();
            await sleep(100);
            await producer.jobs.retry({ jobIds: [id] });
            await waitFor(() => ran.length === 1, 3000);

            expect(hint.published).toContain('ping');
            expect(events).toStrictEqual([]);
        });

    test('a retried job does not start before the linger of its last run ends; the linger stays', async () => {
        const p = nextPrefix();
        const { sqlane } = sqlaneOn(p);
        const order = defineConcurrencyLimit({ name: 'order', max: 1 });
        const sync = defineJob({ name: 'sync', timeout: '1m', globalConcurrencyLimits: () => [order] });
        const { promise: never } = Promise.withResolvers();

        sqlane.handle(sync, () => never);
        await sqlane.migrate();

        const { id } = await sqlane.enqueue(testAdapter.pool, sync, {});

        await sqlane.start();
        await waitFor(async () => (await sqlane.jobs.get(id))?.status === 'running');
        // Released on close: its slot lingers until the process exits (exitsBy)
        await sqlane.close({ deadline: 0, mode: 'release', exitsBy: '20s' });

        const { sqlane: admin } = sqlaneOn(p);

        await admin.jobs.cancel({ jobIds: [id] });
        await admin.jobs.retry({ jobIds: [id] });

        const job = await admin.jobs.get(id);

        expect(Number(job?.runAt) - Date.now()).toBeGreaterThan(10_000);
        await expect(raw(`SELECT job_id FROM ${p}concurrency_slots`)).resolves.toMatchObject([{ job_id: id }]);
        await admin.jobs.remove({ jobIds: [id] });
        await expect(raw(`SELECT job_id FROM ${p}concurrency_slots`)).resolves.toMatchObject([{ job_id: id }]);
    });
});

describe('jobs.cancel()', () => {
    test('pending and blocked jobs fail at once, with JobCancelledError, without a failure job; events after commit',
        async () => {
            const p = nextPrefix();
            const { sqlane, events } = sqlaneOn(p);
            const withFailure = defineJob({ name: 'report', failureJob: 'report_failed' });

            sqlane.handle('report_failed', () => {});
            await sqlane.migrate();

            const { id } = await sqlane.enqueue(testAdapter.pool, withFailure, { n: 1 }, { delay: '1h' });
            const { id: blocked } = await sqlane.enqueue(testAdapter.pool, withFailure, { n: 2 });

            await raw(`UPDATE ${p}jobs SET status = 'blocked', blocked_on = 'order:1' WHERE id = ?`, [blocked]);

            const before = await sqlane.jobs.get(id);

            await expect(sqlane.jobs.cancel({ jobName: withFailure })).resolves
                .toStrictEqual({ affectedCount: 2, ignoredJobs: [] });

            const job = await sqlane.jobs.get(id);

            expect(job).toMatchObject({
                status: 'failed',
                attempts: 0,
                runAt: before?.runAt,
                blockedOn: null,
                lastError: { name: 'JobCancelledError', message: 'Cancelled by jobs.cancel()', code: 'JOB_CANCELLED' },
                payload: { n: 1 },
            });
            // Two clock readings, each rounded to the millisecond on PostgreSQL
            expect(Math.abs(Number(job?.expiresAt) - Number(job?.finishedAt) - (30 * 24 * 3600 * 1000)))
                .toBeLessThanOrEqual(1);
            await expect(sqlane.jobs.get(blocked)).resolves.toMatchObject({ status: 'failed', blockedOn: null });
            await expect(sqlane.drain()).resolves.toStrictEqual({ completed: 0, retried: 0, failed: 0 });
            expect(events.filter(event => event.type === 'cancelled').map(event => /** @type {any} */ (event).jobId)
                .toSorted()).toStrictEqual([id, blocked].toSorted());
            expect(events.find(event => event.type === 'cancelled')).toMatchObject({ jobName: 'report', attempt: 1 });
        });

    test('a running job is not changed: its id is ignored; running in a filter rejects', async () => {
        const { sqlane, p } = await fresh();
        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {});

        await raw(`UPDATE ${p}jobs SET status = 'running' WHERE id = ?`, [id]);
        await expect(sqlane.jobs.cancel({ jobIds: [id] })).resolves.toStrictEqual({
            affectedCount: 0,
            ignoredJobs: [{ jobId: id, reason: 'status', status: 'running' }],
        });
        await expect(sqlane.jobs.cancel({ jobName: 'ping', status: 'running' })).rejects
            .toBeInstanceOf(InvalidOptionsError);
        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'running' });
    });

    test('a cancelled job keeps blocking its dedupe key until it is removed', async () => {
        const { sqlane } = await fresh();
        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { jobId: 'k', delay: '1h' });

        await sqlane.jobs.cancel({ jobIds: [id] });
        await expect(sqlane.enqueue(testAdapter.pool, 'ping', {}, { jobId: 'k' })).resolves
            .toMatchObject({ created: false });
        await sqlane.jobs.remove({ jobIds: [id] });
        await expect(sqlane.enqueue(testAdapter.pool, 'ping', {}, { jobId: 'k' })).resolves
            .toMatchObject({ created: true });
    });
});

describe('jobs.remove()', () => {
    test('each accepted status is deleted with its payload; a running job is not', async () => {
        const { sqlane, p } = await fresh();
        const ids = (await sqlane.enqueueMany(testAdapter.pool, 'ping', [0, 1, 2, 3, 4].map(n => ({
            payload: { n },
            options: { delay: '1h' },
        })))).map(({ id }) => id);
        const statuses = ['pending', 'blocked', 'completed', 'failed', 'running'];

        for (const [at, status] of statuses.entries()) {
            // oxlint-disable-next-line no-await-in-loop -- setup
            await raw(`UPDATE ${p}jobs SET status = ? WHERE id = ?`, [status, ids[at]]);
        }

        await expect(sqlane.jobs.remove({ jobIds: ids })).resolves.toStrictEqual({
            affectedCount: 4,
            ignoredJobs: [{ jobId: ids[4], reason: 'status', status: 'running' }],
        });
        await expect(raw(`SELECT id FROM ${p}jobs`)).resolves.toStrictEqual([{ id: ids[4] }]);
        await expect(raw(`SELECT id FROM ${p}payloads`)).resolves.toStrictEqual([{ id: ids[4] }]);
    });

    test('outside a transaction, a job claimed between the lock and the delete keeps its row and its payload',
        async () => {
            const p = nextPrefix();
            const hooks = hookAdapter(testAdapter.adapter);
            const { sqlane } = sqlaneOn(p, { adapter: hooks.adapter });

            await sqlane.migrate();

            const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', { n: 1 });

            // As a claim would, on another connection, after the lock statement ended
            hooks.afterStatement(/ORDER BY j\.id FOR UPDATE\s*$/, () => raw(
                `UPDATE ${p}jobs SET status = 'running', lock_token = 'T' WHERE id = ?`,
                [id],
            ));

            const connection = await testAdapter.connect();

            try {
                await expect(sqlane.jobs.remove({ jobIds: [id] }, { connection: connection.raw }))
                    .resolves.toMatchObject({ affectedCount: 0 });
            } finally {
                connection.release();
            }

            await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'running', payload: { n: 1 } });
        });

    test('removing a pending job that an unblock made due lets the next blocked job of its key start at once',
        async () => {
            const p = nextPrefix();
            const order = defineConcurrencyLimit({ name: 'order', max: 1 });
            const a = defineJob({ name: 'job_a', timeout: '1m', globalConcurrencyLimits: () => [order] });
            const b = defineJob({ name: 'job_b', timeout: '1m', globalConcurrencyLimits: () => [order] });
            const { sqlane: worker } = sqlaneOn(p);
            const { sqlane: other } = sqlaneOn(p);
            /** @type {string[]} */
            const ran = [];
            const { handler, release } = holdingFirst(ran);

            await worker.migrate();
            worker.handle(a, handler);
            other.handle(b, () => {});

            const { id: a1 } = await worker.enqueue(testAdapter.pool, a, {});

            await worker.start();
            await waitFor(() => ran.length === 1);

            // B1 is blocked first, by a process that handles it, then that process stops
            const { id: b1 } = await worker.enqueue(testAdapter.pool, b, {});

            await other.start();
            await waitFor(async () => (await worker.jobs.get(b1))?.status === 'blocked');
            await other.close({ deadline: 0 });

            const { id: a2 } = await worker.enqueue(testAdapter.pool, a, {});

            await waitFor(async () => (await worker.jobs.get(a2))?.status === 'blocked');
            release();
            // A1 ends: its key unblocks B1, the head, which no started process handles
            await waitFor(async () => (await worker.jobs.get(b1))?.status === 'pending');
            await expect(worker.jobs.get(a2)).resolves.toMatchObject({ status: 'blocked' });

            const { sqlane: admin } = sqlaneOn(p);

            await admin.jobs.remove({ jobIds: [b1] });
            await waitFor(() => ran.length === 2, 3000);

            expect(ran).toStrictEqual([a1, a2]);
        });

    test('a failure of the unblock is an error event; the call resolves', async () => {
        const p = nextPrefix();
        const hooks = hookAdapter(testAdapter.adapter);
        const { sqlane, events } = sqlaneOn(p, { adapter: hooks.adapter });
        const order = defineConcurrencyLimit({ name: 'order', max: 1 });

        await sqlane.migrate();

        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { globalConcurrencyLimits: [order] });
        const { id: blocked } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { globalConcurrencyLimits: [order] });

        await raw(`UPDATE ${p}jobs SET status = 'blocked', blocked_on = 'order' WHERE id = ?`, [blocked]);
        hooks.rejectOn(/head\.max - \(SELECT count|SET status = 'pending', blocked_on = NULL, updated_at/,
            () => new Error('unblock down'));

        await expect(sqlane.jobs.remove({ jobIds: [id] })).resolves.toMatchObject({ affectedCount: 1 });
        await waitFor(() => events.some(event => event.type === 'error'));

        expect(events).toMatchObject([{ type: 'error', operation: 'unblock', error: { message: 'unblock down' } }]);
    });
});

describe('selectors, results and strict', () => {
    test('1000 distinct ids with duplicates: accepted; ignored ids once, in the order of their first appearance',
        async () => {
            const { sqlane } = await fresh();
            const ids = Array.from({ length: 1000 }, (_, n) => `ping:none${n}`);
            const result = await sqlane.jobs.remove({ jobIds: [...ids, ...ids] });

            expect(result.affectedCount).toBe(0);
            expect(result.ignoredJobs.map(job => job.jobId)).toStrictEqual(ids);
            await expect(sqlane.jobs.remove({ jobIds: [...ids, 'ping:more'] })).rejects
                .toBeInstanceOf(InvalidOptionsError);
        });

    test('strict: any ignored id rejects with IgnoredJobsError, and nothing changes', async () => {
        const { sqlane } = await fresh();
        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' });
        const call = sqlane.jobs.cancel({ jobIds: [id, 'ping:none'] }, { strict: true });

        await expect(call).rejects.toBeInstanceOf(IgnoredJobsError);
        await expect(call).rejects
            .toMatchObject({ code: 'IGNORED_JOBS', ignoredJobs: [{ jobId: 'ping:none', reason: 'not_found' }] });
        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'pending' });
        await expect(sqlane.jobs.cancel({ jobIds: [id] }, { strict: true })).resolves
            .toMatchObject({ affectedCount: 1 });
    });

    test('strict: a job whose status changes between the read and the lock rejects, and nothing changes', async () => {
        const p = nextPrefix();
        const hooks = hookAdapter(testAdapter.adapter);
        const { sqlane } = sqlaneOn(p, { adapter: hooks.adapter });

        await sqlane.migrate();

        const [{ id: first }, { id: second }] = await sqlane.enqueueMany(testAdapter.pool, 'ping', [
            { payload: {}, options: { delay: '1h' } },
            { payload: {}, options: { delay: '1h' } },
        ]);

        hooks.afterStatement(/AS found FROM \S+jobs j LEFT JOIN/, () => raw(
            `UPDATE ${p}jobs SET status = 'running' WHERE id = ?`,
            [second],
        ));
        await expect(sqlane.jobs.cancel({ jobIds: [first, second] }, { strict: true })).rejects.toMatchObject({
            code: 'IGNORED_JOBS',
            ignoredJobs: [{ jobId: second, reason: 'status', status: 'running' }],
        });
        await expect(sqlane.jobs.get(first)).resolves.toMatchObject({ status: 'pending' });
    });

    test('the ignored ids keep the order of the ids, also those that changed between the read and the lock', async () => {
        const p = nextPrefix();
        const hooks = hookAdapter(testAdapter.adapter);
        const { sqlane } = sqlaneOn(p, { adapter: hooks.adapter });

        await sqlane.migrate();

        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' });

        hooks.afterStatement(/AS found FROM \S+jobs j LEFT JOIN/, () => raw(
            `UPDATE ${p}jobs SET status = 'running' WHERE id = ?`,
            [id],
        ));
        await expect(sqlane.jobs.cancel({ jobIds: [id, 'ping:none'] })).resolves.toStrictEqual({
            affectedCount: 0,
            ignoredJobs: [
                { jobId: id, reason: 'status', status: 'running' },
                { jobId: 'ping:none', reason: 'not_found' },
            ],
        });
    });

    test.each([
        { mode: 'atomic', read: /AS found FROM \S+jobs j LEFT JOIN/ },
        { mode: 'batches', read: /AS ms\s+FROM \S+jobs j/ },
    ])('$mode: the statuses of a filter are checked again under the lock', async ({ mode, read }) => {
        const p = nextPrefix();
        const hooks = hookAdapter(testAdapter.adapter);
        const { sqlane, events } = sqlaneOn(p, { adapter: hooks.adapter });
        // The ids and the events too: on MySQL and MariaDB they come from the lock, not from the write
        const options = /** @type {any} */ ({ mode, includeAffectedJobIds: true });

        await sqlane.migrate();

        // Blocked, then made pending between the read and the lock: a cancel of blocked jobs leaves it
        const { id: blocked } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' });

        await raw(`UPDATE ${p}jobs SET status = 'blocked', blocked_on = 'order:1' WHERE id = ?`, [blocked]);
        hooks.afterStatement(read, () => raw(
            `UPDATE ${p}jobs SET status = 'pending', blocked_on = NULL WHERE id = ?`,
            [blocked],
        ));
        await expect(sqlane.jobs.cancel({ jobName: 'ping', status: 'blocked' }, options)).resolves
            .toStrictEqual({ affectedCount: 0, affectedJobIds: [], ignoredJobs: [] });
        await expect(sqlane.jobs.get(blocked)).resolves.toMatchObject({ status: 'pending' });

        // Failed, then retried to pending between the read and the lock: a remove of failed jobs leaves it
        const [failed] = await failedJobs(p, 'flop', [{}]);

        hooks.afterStatement(read, () => raw(`UPDATE ${p}jobs SET status = 'pending' WHERE id = ?`, [failed]));
        await expect(sqlane.jobs.remove({ jobName: 'flop', status: 'failed' }, options)).resolves
            .toStrictEqual({ affectedCount: 0, affectedJobIds: [], ignoredJobs: [] });
        await expect(sqlane.jobs.get(failed)).resolves.toMatchObject({ status: 'pending' });
        expect(events.filter(event => event.type === 'cancelled')).toStrictEqual([]);
    });

    test('outside a transaction, the write checks the statuses of the filter again', async () => {
        const p = nextPrefix();
        const hooks = hookAdapter(testAdapter.adapter);
        const { sqlane, events } = sqlaneOn(p, { adapter: hooks.adapter });

        await sqlane.migrate();

        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' });

        await raw(`UPDATE ${p}jobs SET status = 'blocked', blocked_on = 'order:1' WHERE id = ?`, [id]);
        // Made pending on another connection after the lock statement ended, before the write
        hooks.afterStatement(/ORDER BY j\.id FOR UPDATE\s*$/, () => raw(
            `UPDATE ${p}jobs SET status = 'pending', blocked_on = NULL WHERE id = ?`,
            [id],
        ));

        const connection = await testAdapter.connect();

        try {
            await expect(sqlane.jobs.cancel({ jobName: 'ping', status: 'blocked' }, { connection: connection.raw }))
                .resolves.toMatchObject({ affectedCount: 0 });
        } finally {
            connection.release();
        }

        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'pending' });
        expect(events.filter(event => event.type === 'cancelled')).toStrictEqual([]);
    });

    test('a job whose status changes between the read and the lock is ignored with its new status', async () => {
        const p = nextPrefix();
        const hooks = hookAdapter(testAdapter.adapter);
        const { sqlane } = sqlaneOn(p, { adapter: hooks.adapter });

        await sqlane.migrate();

        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' });

        hooks.afterStatement(/AS found FROM \S+jobs j LEFT JOIN/, () => raw(
            `UPDATE ${p}jobs SET status = 'running' WHERE id = ?`,
            [id],
        ));
        await expect(sqlane.jobs.cancel({ jobIds: [id] })).resolves.toStrictEqual({
            affectedCount: 0,
            ignoredJobs: [{ jobId: id, reason: 'status', status: 'running' }],
        });
    });
});

describe('transactions', () => {
    test('in a caller\'s transaction: visible at its commit, gone at its rollback; no cancelled event', async () => {
        const { sqlane, events } = await fresh();
        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' });
        const connection = await testAdapter.connect();

        try {
            await connection.begin();
            await sqlane.jobs.cancel({ jobIds: [id] }, { connection: connection.raw });
            await connection.rollback();
            await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'pending' });

            await connection.begin();
            await sqlane.jobs.cancel({ jobIds: [id] }, { connection: connection.raw });
            await connection.commit();
        } finally {
            connection.release();
        }

        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'failed' });
        expect(events).toStrictEqual([]);
    });

    test('a pool as connection: a transaction of sqlane\'s own; the cancelled event after its commit', async () => {
        const { sqlane, events } = await fresh();
        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' });
        /** @type {unknown[]} */
        const seen = [];

        events.push = (/** @type {SqlaneEvent[]} */ ...pushed) => {
            seen.push(...pushed.map(event => event.type));

            return Array.prototype.push.apply(events, pushed);
        };

        await expect(sqlane.jobs.cancel({ jobIds: [id] }, { connection: testAdapter.pool })).resolves
            .toMatchObject({ affectedCount: 1 });
        expect(seen).toStrictEqual(['cancelled']);
    });

    test.each([
        ['without connection', () => undefined],
        ['with a pool as connection', () => testAdapter.pool],
    ])('%s: the cancelled event comes after the commit: another connection then reads the job failed', async (
        _,
        connectionOf,
    ) => {
        const p = nextPrefix();
        /** @type {{ sqlane: Sqlane | null }} */
        const holder = { sqlane: null };
        /** @type {Promise<unknown>[]} */
        const reads = [];
        const { sqlane } = sqlaneOn(p, { onEvent: readStatusOnCancel(holder, reads) });

        holder.sqlane = sqlane;
        await sqlane.migrate();

        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' });

        await expect(sqlane.jobs.cancel({ jobIds: [id] }, { connection: connectionOf() })).resolves
            .toMatchObject({ affectedCount: 1 });
        await expect(Promise.all(reads)).resolves.toStrictEqual(['failed']);
    });

    test('an owned call whose write fails changes nothing', async () => {
        const p = nextPrefix();
        const hooks = hookAdapter(testAdapter.adapter);
        const { sqlane, events } = sqlaneOn(p, { adapter: hooks.adapter });

        await sqlane.migrate();

        const [{ id: first }, { id: second }] = await sqlane.enqueueMany(testAdapter.pool, 'ping', [
            { payload: {}, options: { delay: '1h' } },
            { payload: {}, options: { delay: '1h' } },
        ]);

        // The jobs DELETE runs, then the payloads DELETE fails (MySQL); PostgreSQL: one statement, then a failure
        hooks.afterStatement(/^\s*(DELETE|WITH) /, () => {
            throw new Error('down after the write');
        });
        await expect(sqlane.jobs.remove({ jobIds: [first, second] })).rejects.toThrow('down after the write');
        await expect(sqlane.jobs.get(first)).resolves.toMatchObject({ status: 'pending' });
        await expect(sqlane.jobs.get(second)).resolves.toMatchObject({ status: 'pending' });
        expect(events).toStrictEqual([]);
    });

    test('a job locked by a caller\'s transaction is not run by a worker; after the commit it is cancelled', async () => {
        const p = nextPrefix();
        const { sqlane } = sqlaneOn(p);
        const { sqlane: worker } = sqlaneOn(p);
        /** @type {string[]} */
        const ran = [];

        await sqlane.migrate();
        worker.handle('ping', ({ job }) => {
            ran.push(job.id);
        });

        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {});
        const connection = await testAdapter.connect();

        try {
            await connection.begin();
            await sqlane.jobs.cancel({ jobIds: [id] }, { connection: connection.raw });
            await expect(worker.drain({ timeout: '300ms' })).resolves.toStrictEqual({ completed: 0, retried: 0, failed: 0 });
            await connection.commit();
        } finally {
            connection.release();
        }

        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'failed', attempts: 0 });
        expect(ran).toStrictEqual([]);
    });
});

describe('batches', () => {
    test('a filter in batches: every job once; a job enqueued during the walk is newer, so not visited', async () => {
        const p = nextPrefix();
        const hooks = hookAdapter(testAdapter.adapter);
        const { sqlane } = sqlaneOn(p, { adapter: hooks.adapter });
        /** @type {string[]} */
        const late = [];

        await sqlane.migrate();

        for (let at = 0; at < 5; at++) {
            // oxlint-disable-next-line no-await-in-loop -- 2500 jobs
            await sqlane.enqueueMany(testAdapter.pool, 'ping', Array.from({ length: 500 }, () => ({
                payload: {},
                options: { delay: '1h' },
            })));
        }

        // After the first write of the first batch
        hooks.afterStatement(/SET status = 'failed', finished_at/, async () => {
            late.push((await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' })).id);
        });
        await expect(sqlane.jobs.cancel({ jobName: 'ping' }, { mode: 'batches' })).resolves
            .toStrictEqual({ affectedCount: 2500, ignoredJobs: [] });
        expect(late).toHaveLength(1);
        await expect(sqlane.jobs.get(late[0])).resolves.toMatchObject({ status: 'pending' });
    });

    test('a retry in batches of jobs that fail again during the walk counts each job once', async () => {
        const p = nextPrefix();
        const hooks = hookAdapter(testAdapter.adapter);
        const { sqlane } = sqlaneOn(p, { adapter: hooks.adapter });

        await sqlane.migrate();
        await failedJobs(p, 'flaky', Array.from({ length: 1500 }, () => ({})));
        // After the first retry write, and before the next batch is read (the first batch has committed): its jobs fail
        // again, so a walk without its keyset would read them again
        hooks.afterStatement(/SET (?:j\.)?status = 'pending'/, () => {
            hooks.beforeStatement(/AS ms\s+FROM \S+jobs j/, () => raw(
                `UPDATE ${p}jobs SET status = 'failed' WHERE job_name = 'flaky' AND status = 'pending'`,
            ));
        });

        await expect(sqlane.jobs.retry({ jobName: 'flaky' }, { mode: 'batches' })).resolves
            .toStrictEqual({ affectedCount: 1500, ignoredJobs: [] });
    });
});

describe('schedules', () => {
    test('overlap skip, with the scheduler: a cancel or a remove of the pending last job lets the next slot add one; '
        + 'a retry of it makes the skip apply again', async () => {
        const { sqlane, events } = await fresh();
        const fired = () => events.filter(event => event.type === 'schedule_fired');
        let seen = 0;

        /**
         * The job id of the next slot that the scheduler decides.
         * @returns {Promise<string | null>}
         */
        async function nextSlot() {
            await waitFor(() => fired().length > seen, 10_000);

            return /** @type {import('../../src/types.js').ScheduleFiredEvent} */ (fired()[seen++]).jobId;
        }

        // No handler: the job of a slot stays pending
        sqlane.schedule('slow', { every: '1s', overlap: 'skip' });
        await sqlane.start();

        const first = /** @type {string} */ (await nextSlot());

        expect(first).toMatch(/^slow:schedule:/);
        // Skipped while the last job is pending
        await expect(nextSlot()).resolves.toBeNull();

        // Cancelled: the next slot adds a job
        await sqlane.jobs.cancel({ jobIds: [first] });

        const second = /** @type {string} */ (await nextSlot());

        expect(second).toMatch(/^slow:schedule:/);

        // Cancelled, then retried, in one transaction: the scheduler never sees it cancelled; pending again, so the
        // skip applies again
        const connection = await testAdapter.connect();

        try {
            await connection.begin();
            await sqlane.jobs.cancel({ jobIds: [second] }, { connection: connection.raw });
            await sqlane.jobs.retry({ jobIds: [second] }, { connection: connection.raw });
            await connection.commit();
        } finally {
            connection.release();
        }

        await expect(sqlane.jobs.get(second)).resolves.toMatchObject({ status: 'pending' });
        await expect(nextSlot()).resolves.toBeNull();

        // Removed: the next slot adds a job
        await sqlane.jobs.remove({ jobIds: [second] });
        await expect(nextSlot()).resolves.toMatch(/^slow:schedule:/);
    }, 30_000);

    test('after a remove, a manual enqueue of its slot adds a new job', async () => {
        const { sqlane } = await fresh();
        const at = new Date('2026-01-01T00:00:00.000Z');
        const { id } = await sqlane.enqueue(testAdapter.pool, 'nightly', {}, { slot: { at }, delay: '1h' });

        await expect(sqlane.enqueue(testAdapter.pool, 'nightly', {}, { slot: { at } })).resolves
            .toMatchObject({ created: false });
        await sqlane.jobs.remove({ jobIds: [id] });
        await expect(sqlane.enqueue(testAdapter.pool, 'nightly', {}, { slot: { at } })).resolves
            .toMatchObject({ id, created: true });
    });
});

describe('wakes, hints and the work after the commit', () => {
    test('a retry wakes this process at once, without a hint', async () => {
        const { sqlane, p } = await fresh({ pollInterval: '10s' });
        const [id] = await failedJobs(p, 'ping', [{}]);
        /** @type {string[]} */
        const ran = [];

        sqlane.handle('ping', ({ job }) => {
            ran.push(job.id);
        });
        await sqlane.start();
        await sleep(100);

        const retriedAt = Date.now();

        await sqlane.jobs.retry({ jobIds: [id] });
        await waitFor(() => ran.length === 1, 3000);

        expect(Date.now() - retriedAt).toBeLessThan(2000);
    });

    test('a retry in a caller\'s transaction wakes this process at once after its commit', async () => {
        const { sqlane, p } = await fresh({ pollInterval: '10s' });
        const [id] = await failedJobs(p, 'ping', [{}]);
        /** @type {string[]} */
        const ran = [];

        sqlane.handle('ping', ({ job }) => {
            ran.push(job.id);
        });
        await sqlane.start();
        await sleep(100);

        const connection = await testAdapter.connect();
        const retriedAt = Date.now();

        try {
            await connection.begin();
            await sqlane.jobs.retry({ jobIds: [id] }, { connection: connection.raw });
            await connection.commit();
        } finally {
            connection.release();
        }

        await waitFor(() => ran.length === 1, 3000);

        expect(Date.now() - retriedAt).toBeLessThan(2000);
    });

    test('a cancel in a caller\'s transaction unblocks the key of the pending job it cancelled', async () => {
        const p = nextPrefix();
        const order = defineConcurrencyLimit({ name: 'order', max: 1 });
        const a = defineJob({ name: 'job_a', timeout: '1m', globalConcurrencyLimits: () => [order] });
        const b = defineJob({ name: 'job_b', timeout: '1m', globalConcurrencyLimits: () => [order] });
        const { sqlane: worker } = sqlaneOn(p);
        const { sqlane: other } = sqlaneOn(p);
        /** @type {string[]} */
        const ran = [];
        const { handler, release } = holdingFirst(ran);

        await worker.migrate();
        worker.handle(a, handler);
        other.handle(b, () => {});

        const { id: a1 } = await worker.enqueue(testAdapter.pool, a, {});

        await worker.start();
        await waitFor(() => ran.length === 1);

        // B1 is blocked first, by a process that handles it, then that process stops
        const { id: b1 } = await worker.enqueue(testAdapter.pool, b, {});

        await other.start();
        await waitFor(async () => (await worker.jobs.get(b1))?.status === 'blocked');
        await other.close({ deadline: 0 });

        const { id: a2 } = await worker.enqueue(testAdapter.pool, a, {});

        await waitFor(async () => (await worker.jobs.get(a2))?.status === 'blocked');
        release();
        // A1 ends: its key unblocks B1, the head, which no started process handles
        await waitFor(async () => (await worker.jobs.get(b1))?.status === 'pending');

        const { sqlane: admin } = sqlaneOn(p);
        const connection = await testAdapter.connect();

        try {
            await connection.begin();
            await admin.jobs.cancel({ jobIds: [b1] }, { connection: connection.raw });
            await connection.commit();
        } finally {
            connection.release();
        }

        // Before the recovery sweep (60 s here): the unblock after the call
        await waitFor(() => ran.length === 2, 3000);

        expect(ran).toStrictEqual([a1, a2]);
    });

    test('after close(), a retry sends no hint', async () => {
        const hint = memoryHint();
        const { sqlane, p } = await fresh({ hint });
        const [id] = await failedJobs(p, 'ping', [{}]);

        await sqlane.close();
        await expect(sqlane.jobs.retry({ jobIds: [id] })).resolves.toMatchObject({ affectedCount: 1 });
        await sleep(200);

        expect(hint.published).toStrictEqual([]);
    });

    test.runIf(inject('databaseDialect') === 'postgres')(
        'with the notify option, the NOTIFY of a retry goes with its transaction',
        async () => {
            const p = nextPrefix();
            const { sqlane } = sqlaneOn(p, { adapter: pgAdapter(testAdapter.pool, { dialect: 'postgres', notify: true }) });

            await sqlane.migrate();

            const [id] = await failedJobs(p, 'ping', [{}]);
            const client = await testAdapter.pool.connect();
            /** @type {string[]} */
            const got = [];

            try {
                client.on('notification', (/** @type {{ payload?: string }} */ notification) => got.push(String(notification.payload)));
                await client.query(`LISTEN ${p}ready`);
                await sqlane.jobs.retry({ jobIds: [id] });
                await waitFor(() => got.length > 0, 3000);
            } finally {
                client.release();
            }

            expect(got).toStrictEqual(['ping']);
        },
    );

    test.runIf(inject('databaseDialect') === 'postgres')(
        'a pool as connection runs at READ COMMITTED, also when the pool defaults to REPEATABLE READ',
        async () => {
            const pool = new Pool({
                connectionString: inject('databaseUrl'),
                max: 2,
                options: '-c default_transaction_isolation=repeatable\\ read',
            });

            try {
                const adapter = pgAdapter(pool, { dialect: 'postgres' });
                const plain = await pool.query('SELECT current_setting(\'default_transaction_isolation\') AS level');
                const level = await adapter.poolTransaction?.(pool, async executor => String(
                    (await executor.query('SHOW transaction_isolation', []))[0].transaction_isolation,
                ));

                expect(plain.rows[0].level).toBe('repeatable read');
                expect(level).toBe('read committed');
            } finally {
                await pool.end();
            }
        },
    );

    test('cancelling a pending job that an unblock made due lets the next blocked job of its key start', async () => {
        const p = nextPrefix();
        const order = defineConcurrencyLimit({ name: 'order', max: 1 });
        const a = defineJob({ name: 'job_a', timeout: '1m', globalConcurrencyLimits: () => [order] });
        const b = defineJob({ name: 'job_b', timeout: '1m', globalConcurrencyLimits: () => [order] });
        const { sqlane: worker } = sqlaneOn(p);
        const { sqlane: other } = sqlaneOn(p);
        /** @type {string[]} */
        const ran = [];
        const { handler, release } = holdingFirst(ran);

        await worker.migrate();
        worker.handle(a, handler);
        other.handle(b, () => {});

        const { id: a1 } = await worker.enqueue(testAdapter.pool, a, {});

        await worker.start();
        await waitFor(() => ran.length === 1);

        const { id: b1 } = await worker.enqueue(testAdapter.pool, b, {});

        await other.start();
        await waitFor(async () => (await worker.jobs.get(b1))?.status === 'blocked');
        await other.close({ deadline: 0 });

        const { id: a2 } = await worker.enqueue(testAdapter.pool, a, {});

        await waitFor(async () => (await worker.jobs.get(a2))?.status === 'blocked');
        release();
        await waitFor(async () => (await worker.jobs.get(b1))?.status === 'pending');

        const { sqlane: admin } = sqlaneOn(p);

        await admin.jobs.cancel({ jobIds: [b1] });
        await waitFor(() => ran.length === 2, 3000);

        expect(ran).toStrictEqual([a1, a2]);
    });
});

describe('retry, further', () => {
    test('in a caller\'s transaction: retried at its commit, unchanged at its rollback', async () => {
        const { sqlane, p } = await fresh();
        const [id] = await failedJobs(p, 'ping', [{}]);
        const connection = await testAdapter.connect();

        try {
            await connection.begin();
            await expect(sqlane.jobs.retry({ jobIds: [id] }, { connection: connection.raw })).resolves
                .toMatchObject({ affectedCount: 1 });
            await connection.rollback();
            await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'failed' });

            await connection.begin();
            await sqlane.jobs.retry({ jobIds: [id] }, { connection: connection.raw });
            await connection.commit();
        } finally {
            connection.release();
        }

        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'pending', attempts: 0 });
    });

    test('one_more gives exactly one more attempt', async () => {
        const { sqlane, p } = await fresh();
        const [id] = await failedJobs(p, 'flaky', [{}], { maxAttempts: 1 });
        let runs = 0;

        sqlane.handle('flaky', () => {
            runs++;
            throw new Error('again');
        });
        await sqlane.jobs.retry({ jobIds: [id] }, { budget: 'one_more' });

        await expect(sqlane.drain({ includeDelayed: true })).resolves
            .toStrictEqual({ completed: 0, retried: 0, failed: 1 });
        expect(runs).toBe(1);
        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'failed', attempts: 2, maxAttempts: 2 });
    });

    test('a retried job keeps its keys', async () => {
        const { sqlane, p } = await fresh();
        const perOrder = defineConcurrencyLimit({ name: 'order', max: 2 });
        const [id] = await failedJobs(p, 'sync', [{}], { globalConcurrencyLimits: [perOrder.key(7)] });

        await sqlane.jobs.retry({ jobIds: [id] });

        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({
            status: 'pending',
            globalConcurrencyLimits: [{ key: 'order:7', max: 2 }],
        });
    });

    test('a handler that throws JobCancelledError throws an ordinary error: retried, not cancelled', async () => {
        const { sqlane, events } = await fresh();
        const outcomes = [() => {
            throw new JobCancelledError('not a cancel');
        }, () => {}];
        const quits = defineJob({ name: 'quits', maxAttempts: 2, backoff: { type: 'fixed', delay: 0, jitter: 0 } });

        sqlane.handle(quits, () => /** @type {() => void} */ (outcomes.shift())());

        const { id } = await sqlane.enqueue(testAdapter.pool, 'quits', {});

        await expect(sqlane.drain({ includeDelayed: true })).resolves
            .toStrictEqual({ completed: 1, retried: 1, failed: 0 });
        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ status: 'completed', attempts: 2 });
        expect(events.some(event => event.type === 'cancelled')).toBe(false);
    });
});

describe('lifecycle', () => {
    test('before start(), after close(), and in an instance without handlers', async () => {
        const { sqlane, p } = await fresh();
        const ids = (await sqlane.enqueueMany(testAdapter.pool, 'ping', [{ payload: {} }, { payload: {} }]))
            .map(({ id }) => id);

        await expect(sqlane.jobs.cancel({ jobIds: [ids[0]] })).resolves.toMatchObject({ affectedCount: 1 });
        await sqlane.close();
        await expect(sqlane.jobs.remove({ jobIds: ids })).resolves.toMatchObject({ affectedCount: 2 });
        await expect(raw(`SELECT id FROM ${p}jobs`)).resolves.toStrictEqual([]);
    });

    test('the options and the selector are checked before any query', async () => {
        const { sqlane } = await fresh();

        for (const call of [
            () => sqlane.jobs.cancel(/** @type {any} */ ({})),
            () => sqlane.jobs.cancel({ jobIds: ['a'] }, /** @type {any} */ ({ mode: 'batches' })),
            () => sqlane.jobs.cancel({ jobName: 'ping' }, { strict: true }),
            () => sqlane.jobs.cancel({ jobName: 'ping' }, /** @type {any} */ ({ budget: 'reset' })),
            () => sqlane.jobs.remove({ jobName: 'ping', status: /** @type {any} */ ('running') }),
        ]) {
            // oxlint-disable-next-line no-await-in-loop -- one call after the other
            await expect(call()).rejects.toBeInstanceOf(InvalidOptionsError);
        }
    });
});
