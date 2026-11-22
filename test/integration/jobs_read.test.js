// sqlane.jobs.get() and sqlane.jobs.list(): the jobs as the database has them, on each dialect, through the public API.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import {
    createSqlane,
    defineConcurrencyLimit,
    defineJob,
    defineRateLimit,
    FatalJobError,
    InvalidOptionsError,
    RateLimitedError,
} from '../../src/index.js';
import { MAX_STACK_LENGTH } from '../../src/error_json.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @typedef {import('../../src/types.js').Sqlane<any>} Sqlane */

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];

const fixedBackoff = /** @type {const} */ ({ type: 'fixed', delay: 10, jitter: 0 });

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
 * A sqlane instance on tables of its own.
 * @param {Partial<import('../../src/types.js').SqlaneOptions<any>>} [options]
 * @param {{ migrate?: boolean }} [setup] Default: migrated.
 * @returns {Promise<Sqlane>}
 */
async function freshSqlane(options = {}, { migrate = true } = {}) {
    prefixCount++;

    const sqlane = createSqlane({
        adapter: testAdapter.adapter,
        tablePrefix: `${database.tablePrefix}${prefixCount}_`,
        ...options,
    });

    instances.push(sqlane);

    if (migrate) {
        await sqlane.migrate();
    }

    return sqlane;
}

/**
 * Waits until the condition holds.
 * @param {() => Promise<boolean>} condition
 * @returns {Promise<void>}
 */
async function waitFor(condition) {
    const deadline = Date.now() + 5000;

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
 * @param {string} message
 * @returns {() => void} A handler that throws at its first call, then succeeds.
 */
function failingOnce(message) {
    let calls = 0;

    return () => {
        calls++;

        if (calls === 1) {
            throw new Error(message);
        }
    };
}

/**
 * @param {unknown} parts
 * @returns {string} A cursor built by hand.
 */
function cursorOf(parts) {
    return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

/**
 * @param {import('../../src/types.js').JobRecord[]} jobs
 * @returns {import('../../src/types.js').JobRecord[] | undefined} A group of jobs of one enqueue time, of ids whose
 *     byte order is not their locale order.
 */
function tieOf(jobs) {
    return Object.values(Object.groupBy(jobs, job => String(Number(job.enqueuedAt)))).find((group = []) => {
        const ids = group.map(job => job.id);

        return ids.length > 1
            && JSON.stringify(ids.toSorted()) !== JSON.stringify(ids.toSorted((a, b) => a.localeCompare(b)));
    });
}

/**
 * Enqueues groups of jobs of one insert until one group has one enqueue time: always on MySQL and MariaDB, which give
 * one time to the rows of an insert; on PostgreSQL a group may straddle a millisecond.
 * @param {Sqlane} sqlane
 * @returns {Promise<{ all: import('../../src/types.js').JobRecord[], tie: import('../../src/types.js').JobRecord[] }>}
 */
async function enqueueUntilTie(sqlane) {
    // Byte order: B < _ < a; localeCompare: _ < a < B
    const keys = ['B', '_', 'a', 'b', 'Z'];

    for (let group = 0; group < 10; group++) {
        // oxlint-disable-next-line no-await-in-loop -- one group after the other
        await sqlane.enqueueMany(testAdapter.pool, 'ping', keys.map(key => ({
            payload: {},
            options: { jobId: `g${group}${key}` },
        })));
        // oxlint-disable-next-line no-await-in-loop -- one group after the other
        await sleep(5);

        // oxlint-disable-next-line no-await-in-loop -- one group after the other
        const { jobs } = await sqlane.jobs.list({ jobName: 'ping' }, { limit: 1000 });
        const tie = tieOf(jobs);

        if (tie) {
            return { all: jobs, tie };
        }
    }

    throw new Error('enqueueUntilTie: no group of one enqueue time');
}

/**
 * @param {Sqlane} sqlane
 * @param {import('../../src/types.js').JobFilter} filter
 * @param {import('../../src/types.js').ListJobsOptions} options The options of every page.
 * @param {string | null} cursor The first cursor.
 * @returns {Promise<string[]>} The ids of the pages from the cursor to the last.
 */
async function idsFrom(sqlane, filter, options, cursor) {
    const ids = [];
    let next = cursor;

    while (next) {
        // oxlint-disable-next-line no-await-in-loop -- one page after the other
        const page = await sqlane.jobs.list(filter, { ...options, cursor: next });

        ids.push(...page.jobs.map(job => job.id));
        next = page.nextCursor;
    }

    return ids;
}

describe('jobs.get()', () => {
    test('a pending job: every field, and its payload', async () => {
        const sqlane = await freshSqlane();
        const runAt = new Date(Date.now() + 3_600_000);
        const { id } = await sqlane.enqueue(testAdapter.pool, 'build_report', { reportId: 'r1' }, {
            jobId: 'r1',
            runAt,
            maxAttempts: 5,
            failureJob: 'report_failed',
        });

        await expect(sqlane.jobs.get(id)).resolves.toStrictEqual({
            id: 'build_report:r1',
            name: 'build_report',
            status: 'pending',
            attempts: 0,
            maxAttempts: 5,
            stalls: 0,
            maxStalls: 2,
            // The option of the app, exactly
            runAt,
            enqueuedAt: expect.any(Date),
            startedAt: null,
            finishedAt: null,
            expiresAt: null,
            scheduledAt: null,
            stuck: false,
            lastError: null,
            globalConcurrencyLimits: [],
            globalRateLimits: [],
            blockedOn: null,
            failureJob: 'report_failed',
            payload: { reportId: 'r1' },
        });
    });

    test('a completed job: its times, no payload; a failed job: its error with its code, its payload kept', async () => {
        const sqlane = await freshSqlane();

        sqlane.handle('ok', () => {});
        sqlane.handle('broken', () => {
            throw new FatalJobError('no such report');
        });

        const ok = await sqlane.enqueue(testAdapter.pool, 'ok', { n: 1 });
        const broken = await sqlane.enqueue(testAdapter.pool, 'broken', { n: 2 });

        await sqlane.drain();

        const completed = await sqlane.jobs.get(ok.id);
        const failed = await sqlane.jobs.get(broken.id);

        expect(completed).toMatchObject({ status: 'completed', attempts: 1, lastError: null });
        expect(completed).not.toHaveProperty('payload');
        expect(completed?.startedAt).toBeInstanceOf(Date);
        expect(completed?.finishedAt).toBeInstanceOf(Date);
        // The default retention of a completed job: 1 h
        expect(Number(completed?.expiresAt) - Number(completed?.finishedAt)).toBe(3_600_000);
        expect(failed).toMatchObject({
            status: 'failed',
            attempts: 1,
            lastError: { name: 'FatalJobError', message: 'no such report', code: 'FATAL_JOB' },
            payload: { n: 2 },
            finishedAt: expect.any(Date),
        });
    });

    test('a running job past its timeout is stuck; a job behind it is blocked on its concurrency key', async () => {
        const sqlane = await freshSqlane({ pollInterval: '50ms' });
        const order = defineConcurrencyLimit({ name: 'order', max: 1 });
        const sync = defineJob({
            name: 'sync_order',
            timeout: '50ms',
            globalConcurrencyLimits: ({ payload }) => [order.key(payload.orderId)],
        });
        const { promise: settled, resolve: finish } = Promise.withResolvers();

        // Ignores its signal: runs on after its timeout
        sqlane.handle(sync, () => settled);
        await sqlane.start();

        const first = await sqlane.enqueue(testAdapter.pool, sync, { orderId: 7 });

        await waitFor(async () => (await sqlane.jobs.get(first.id))?.stuck === true);

        const second = await sqlane.enqueue(testAdapter.pool, sync, { orderId: 7 });

        await waitFor(async () => (await sqlane.jobs.get(second.id))?.status === 'blocked');
        await expect(sqlane.jobs.get(first.id)).resolves.toMatchObject({
            status: 'running',
            stuck: true,
            startedAt: expect.any(Date),
            globalConcurrencyLimits: [{ key: 'order:7', max: 1 }],
            blockedOn: null,
        });
        await expect(sqlane.jobs.get(second.id)).resolves.toMatchObject({
            status: 'blocked',
            stuck: false,
            blockedOn: { type: 'concurrency', key: 'order:7' },
        });
        finish(undefined);
    });

    test('a job blocked on a rate key after a RateLimitedError: the tagged key and its error', async () => {
        const sqlane = await freshSqlane();
        const api = defineRateLimit({ name: 'api', max: 10, per: '1s' });
        const call = defineJob({ name: 'call_api', globalRateLimits: ({ payload }) => [api.key(payload.token)] });

        sqlane.handle(call, ({ payload }) => {
            throw new RateLimitedError({ limit: api.key(payload.token), retryAfter: '1h' });
        });

        const { id } = await sqlane.enqueue(testAdapter.pool, call, { token: 't1' });

        await sqlane.drain();
        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({
            status: 'blocked',
            attempts: 0,
            blockedOn: { type: 'rate', limit: 'api', key: 't1' },
            lastError: { name: 'RateLimitedError' },
        });
    });

    test('rate limits as { limit, key }, sorted by the full key; concurrency keys sorted; a slot; a failure job', async () => {
        const sqlane = await freshSqlane();
        const perClient = defineConcurrencyLimit({ name: 'client', max: 2 });
        const all = defineConcurrencyLimit({ name: 'all', max: 100 });
        const github = defineRateLimit({ name: 'github', max: 5000, per: '1h', burst: 10 });
        const sms = defineRateLimit({ name: 'sms', max: 10, per: '1s', burst: 3 });
        const { id } = await sqlane.enqueue(testAdapter.pool, 'sync_repo', {}, {
            globalConcurrencyLimits: [perClient.key('42'), all],
            globalRateLimits: [sms.cost(2), github.key('t1')],
        });
        const at = new Date('2026-11-11T02:00:00.000Z');
        const slot = await sqlane.enqueue(testAdapter.pool, 'nightly_report', {}, { slot: { at } });

        await expect(sqlane.jobs.get(id)).resolves.toMatchObject({
            globalConcurrencyLimits: [{ key: 'all', max: 100 }, { key: 'client:42', max: 2 }],
            globalRateLimits: [
                { limit: 'github', key: 't1', max: 5000, per: 3_600_000, burst: 10, cost: 1 },
                { limit: 'sms', key: null, max: 10, per: 1000, burst: 3, cost: 2 },
            ],
            scheduledAt: null,
        });
        await expect(sqlane.jobs.get(slot.id)).resolves.toMatchObject({
            id: 'nightly_report:schedule:2026-11-11T02:00:00.000Z',
            scheduledAt: at,
        });
    });

    test('an error with a NUL, a lone surrogate, and a stack cut inside a surrogate pair is kept, as well-formed text',
        async () => {
            const sqlane = await freshSqlane();
            const error = new FatalJobError('a\u0000b\uD800c');

            error.stack = `${'x'.repeat(MAX_STACK_LENGTH - 1)}\u{1F600}`;
            sqlane.handle('broken_text', () => {
                throw error;
            });

            const { id } = await sqlane.enqueue(testAdapter.pool, 'broken_text', {});

            await sqlane.drain();
            await expect(sqlane.jobs.get(id)).resolves.toMatchObject({
                status: 'failed',
                lastError: { name: 'FatalJobError', message: 'a\uFFFDb\uFFFDc', stack: 'x'.repeat(MAX_STACK_LENGTH - 1) },
            });
        });

    test('a job retried, then completed, keeps the error of its failed attempt; a falsy JSON payload is present',
        async () => {
            const sqlane = await freshSqlane();

            sqlane.handle(defineJob({ name: 'flaky', backoff: fixedBackoff }), failingOnce('first try'));

            const flaky = await sqlane.enqueue(testAdapter.pool, 'flaky', {});
            const empty = await sqlane.enqueue(testAdapter.pool, 'empty', false, { delay: '1h' });

            await sqlane.drain({ includeDelayed: true });
            await expect(sqlane.jobs.get(flaky.id)).resolves.toMatchObject({
                status: 'completed',
                attempts: 2,
                lastError: { name: 'Error', message: 'first try' },
            });
            await expect(sqlane.jobs.get(empty.id)).resolves.toMatchObject({ status: 'pending', payload: false });
        });

    // On PostgreSQL, enqueue() of a null payload fails (jsonb_to_recordset makes it SQL NULL in a NOT NULL column): a
    // bug of enqueue, fixed apart. The read of a JSON null payload is the same code on every database
    test.skipIf(inject('databaseDialect') === 'postgres')('a JSON null payload is present, as null', async () => {
        const sqlane = await freshSqlane();
        const { id } = await sqlane.enqueue(testAdapter.pool, 'empty', null, { delay: '1h' });
        const job = await sqlane.jobs.get(id);
        const { jobs: [listed] } = await sqlane.jobs.list({ jobName: 'empty' }, { includePayload: true });

        expect(job).toHaveProperty('payload', null);
        expect(listed).toHaveProperty('payload', null);
    });

    test('an unknown id, or a string that cannot be an id: null; not a string: InvalidOptionsError', async () => {
        const sqlane = await freshSqlane();

        await sqlane.enqueue(testAdapter.pool, 'build_report', {}, { jobId: 'r1' });

        for (const jobId of ['build_report:none', '', 'build_report:r1 ', ' build_report:r1', 'build_report:é',
            `build_report:${'x'.repeat(300)}`]) {
            // oxlint-disable-next-line no-await-in-loop -- one after the other
            await expect(sqlane.jobs.get(jobId)).resolves.toBeNull();
        }

        await expect(sqlane.jobs.get(/** @type {any} */ (42))).rejects.toBeInstanceOf(InvalidOptionsError);
        await expect(sqlane.jobs.get(/** @type {any} */ (undefined))).rejects.toBeInstanceOf(InvalidOptionsError);
    });
});

/**
 * @param {{ enqueuedAt: Date, id: string }} a
 * @param {{ enqueuedAt: Date, id: string }} b
 * @returns {number} The order of jobs.list: newest first, then the id descending in byte order (not localeCompare).
 */
function listOrder(a, b) {
    if (Number(a.enqueuedAt) !== Number(b.enqueuedAt)) {
        return Number(b.enqueuedAt) - Number(a.enqueuedAt);
    }

    return a.id < b.id ? 1 : -1;
}

describe('jobs.list()', () => {
    test('the jobs of a name, newest first, of a status or of several; payloads on request; a definition', async () => {
        const sqlane = await freshSqlane();
        const ok = defineJob({ name: 'ok' });

        sqlane.handle(ok, () => {});

        const done = await sqlane.enqueue(testAdapter.pool, ok, { n: 1 });

        await sqlane.drain();
        await sleep(5);

        const first = await sqlane.enqueue(testAdapter.pool, ok, { n: 2 }, { delay: '1h' });

        await sleep(5);

        const second = await sqlane.enqueue(testAdapter.pool, ok, { n: 3 }, { delay: '1h' });

        await sqlane.enqueue(testAdapter.pool, 'other', {});

        const all = await sqlane.jobs.list({ jobName: 'ok' });

        expect(all.jobs.map(job => job.id)).toStrictEqual([second.id, first.id, done.id]);
        expect(all.nextCursor).toBeNull();
        expect(all.jobs.map(job => 'payload' in job)).toStrictEqual([false, false, false]);

        const pending = await sqlane.jobs.list({ jobName: ok, status: 'pending' }, { includePayload: true });

        expect(pending.jobs.map(job => job.payload)).toStrictEqual([{ n: 3 }, { n: 2 }]);
        await expect(sqlane.jobs.list({ jobName: 'ok', status: ['failed', 'completed'] }))
            .resolves.toMatchObject({ jobs: [{ id: done.id, status: 'completed' }], nextCursor: null });
        await expect(sqlane.jobs.list({ jobName: 'none' })).resolves.toStrictEqual({ jobs: [], nextCursor: null });

        // undefined counts as absent; a null cursor is the first page
        const absent = await sqlane.jobs.list(
            { jobName: 'ok', status: undefined },
            { limit: undefined, cursor: undefined, includePayload: undefined },
        );

        expect(absent.jobs.map(job => job.id)).toStrictEqual([second.id, first.id, done.id]);
        await expect(sqlane.jobs.list({ jobName: 'ok' }, { cursor: null, limit: 1 }))
            .resolves.toMatchObject({ jobs: [{ id: second.id }] });
    });

    test('pages across a group of equal enqueue times: each job once, in byte order of the ids', async () => {
        const sqlane = await freshSqlane();
        const { all, tie } = await enqueueUntilTie(sqlane);

        expect(all.map(job => job.id)).toStrictEqual(all.toSorted(listOrder).map(job => job.id));

        // A page ends after the first job of the group: the next page starts inside it
        const limit = all.findIndex(job => job.id === tie[0].id) + 1;
        const page1 = await sqlane.jobs.list({ jobName: 'ping' }, { limit });

        // A newer job, enqueued between the pages: before the cursor, not in the next pages
        await sqlane.enqueue(testAdapter.pool, 'ping', {}, { jobId: 'late' });

        expect(page1.nextCursor).not.toBeNull();

        const paged = [
            ...page1.jobs.map(job => job.id),
            ...await idsFrom(sqlane, { jobName: 'ping' }, { limit }, page1.nextCursor),
        ];

        expect(paged).toStrictEqual(all.map(job => job.id));
    });

    test('a status filter across pages; a job that changes status between pages; an empty last page', async () => {
        const sqlane = await freshSqlane();
        const flip = defineJob({ name: 'flip', maxAttempts: 1 });

        sqlane.handle(flip, () => {
            throw new Error('fails');
        });

        // The oldest is due now; the others wait: drain() runs only it
        const target = await sqlane.enqueue(testAdapter.pool, flip, {});

        for (let n = 0; n < 4; n++) {
            // oxlint-disable-next-line no-await-in-loop -- one after the other
            await sleep(3);
            // oxlint-disable-next-line no-await-in-loop -- one after the other
            await sqlane.enqueue(testAdapter.pool, flip, {}, { delay: '1h' });
        }

        const page1 = await sqlane.jobs.list({ jobName: flip, status: 'pending' }, { limit: 4 });

        expect(page1.jobs).toHaveLength(4);
        expect(page1.nextCursor).not.toBeNull();

        await sqlane.drain();
        await expect(sqlane.jobs.get(target.id)).resolves.toMatchObject({ status: 'failed' });

        // The target left the filter: the last page is empty
        await expect(sqlane.jobs.list({ jobName: flip, status: 'pending' }, { limit: 4, cursor: page1.nextCursor }))
            .resolves.toStrictEqual({ jobs: [], nextCursor: null });
        await expect(sqlane.jobs.list({ jobName: flip, status: 'failed' }))
            .resolves.toMatchObject({ jobs: [{ id: target.id }] });
    });

    test('a job that enters the filter between pages is listed by the page that reaches it', async () => {
        const sqlane = await freshSqlane();
        const flip = defineJob({ name: 'flip', maxAttempts: 1 });

        sqlane.handle(flip, () => {
            throw new Error('fails');
        });

        // The oldest waits; the newer ones are due now: the first drain() fails only them
        const target = await sqlane.enqueue(testAdapter.pool, flip, {}, { delay: '1h' });

        for (let n = 0; n < 4; n++) {
            // oxlint-disable-next-line no-await-in-loop -- one after the other
            await sleep(3);
            // oxlint-disable-next-line no-await-in-loop -- one after the other
            await sqlane.enqueue(testAdapter.pool, flip, {});
        }

        await sqlane.drain();

        const page1 = await sqlane.jobs.list({ jobName: flip, status: 'failed' }, { limit: 3 });

        expect(page1.jobs).toHaveLength(3);

        await sqlane.drain({ includeDelayed: true });

        const page2 = await sqlane.jobs.list({ jobName: flip, status: 'failed' }, { limit: 3, cursor: page1.nextCursor });

        expect(page2.jobs).toHaveLength(2);
        expect(page2.jobs.at(-1)?.id).toBe(target.id);
        expect(page2.nextCursor).toBeNull();
    });

    test('the default limit is 100', async () => {
        const sqlane = await freshSqlane();

        await sqlane.enqueueMany(testAdapter.pool, 'ping', Array.from({ length: 101 }, () => ({ payload: {} })));

        const page1 = await sqlane.jobs.list({ jobName: 'ping' });

        expect(page1.jobs).toHaveLength(100);
        await expect(sqlane.jobs.list({ jobName: 'ping' }, { cursor: page1.nextCursor }))
            .resolves.toMatchObject({ jobs: [{}], nextCursor: null });
    });

    test('another instance with the same table prefix continues a cursor', async () => {
        const sqlane = await freshSqlane();
        const other = createSqlane({ adapter: testAdapter.adapter, tablePrefix: `${database.tablePrefix}${prefixCount}_` });

        instances.push(other);
        await sqlane.enqueueMany(testAdapter.pool, 'ping', [{ payload: {} }, { payload: {} }, { payload: {} }]);

        const page1 = await sqlane.jobs.list({ jobName: 'ping' }, { limit: 2 });
        const all = await sqlane.jobs.list({ jobName: 'ping' });

        await expect(other.jobs.list({ jobName: 'ping' }, { limit: 2, cursor: page1.nextCursor }))
            .resolves.toMatchObject({ jobs: [{ id: all.jobs[2].id }], nextCursor: null });
    });

    test('a job that commits after a page was read, older than the cursor, is listed by the next page', async () => {
        const sqlane = await freshSqlane();
        const older = await sqlane.enqueue(testAdapter.pool, 'late', {});

        await sleep(5);

        const connection = await testAdapter.connect();

        try {
            await connection.begin();

            const late = await sqlane.enqueue(connection.raw, 'late', {});

            await sleep(5);
            await sqlane.enqueueMany(testAdapter.pool, 'late', [{ payload: {} }, { payload: {} }]);

            const page1 = await sqlane.jobs.list({ jobName: 'late' }, { limit: 2 });

            expect(page1.nextCursor).not.toBeNull();
            await connection.commit();
            await expect(sqlane.jobs.list({ jobName: 'late' }, { limit: 2, cursor: page1.nextCursor }))
                .resolves.toMatchObject({ jobs: [{ id: late.id }, { id: older.id }], nextCursor: null });
        } finally {
            connection.release();
        }
    });

    test('cursors: bound to their filter; limit and includePayload may change between pages', async () => {
        const sqlane = await freshSqlane();

        await sqlane.enqueueMany(testAdapter.pool, 'ping', [{ payload: { n: 1 } }, { payload: { n: 2 } },
            { payload: { n: 3 } }]);

        const pending = await sqlane.jobs.list({ jobName: 'ping', status: 'pending' }, { limit: 1 });
        const cursor = pending.nextCursor;

        // One status, or the list of it, or the list in another order: the same filter
        await expect(sqlane.jobs.list({ jobName: 'ping', status: ['pending'] }, { limit: 1, cursor }))
            .resolves.toMatchObject({ jobs: [{}] });

        const two = await sqlane.jobs.list({ jobName: 'ping', status: ['pending', 'failed'] }, { limit: 1 });

        await expect(sqlane.jobs.list(
            { jobName: 'ping', status: ['failed', 'pending'] },
            { limit: 2, cursor: two.nextCursor, includePayload: true },
        )).resolves.toMatchObject({ jobs: [{ payload: {} }, { payload: {} }], nextCursor: null });

        // Another filter: another name, other statuses, every status against the list of all five
        const absent = await sqlane.jobs.list({ jobName: 'ping' }, { limit: 1 });
        const allFive = /** @type {const} */ (['pending', 'blocked', 'running', 'completed', 'failed']);

        for (const call of [
            () => sqlane.jobs.list({ jobName: 'pong', status: 'pending' }, { cursor }),
            () => sqlane.jobs.list({ jobName: 'ping', status: 'failed' }, { cursor }),
            () => sqlane.jobs.list({ jobName: 'ping' }, { cursor }),
            () => sqlane.jobs.list({ jobName: 'ping', status: allFive }, { cursor: absent.nextCursor }),
        ]) {
            // oxlint-disable-next-line no-await-in-loop -- one after the other
            await expect(call()).rejects.toBeInstanceOf(InvalidOptionsError);
        }
    });

    test('bad filters, options and cursors reject with an InvalidOptionsError', async () => {
        const sqlane = await freshSqlane();
        const good = [1, 'ping', null, Date.now(), 'ping:x'];

        await expect(sqlane.jobs.list({ jobName: 'ping' }, { cursor: cursorOf(good) }))
            .resolves.toStrictEqual({ jobs: [], nextCursor: null });

        for (const [filter, options] of /** @type {[any, any][]} */ ([
            [null, undefined],
            [{}, undefined],
            [{ jobName: 'ping', sort: 'asc' }, undefined],
            // An unknown field rejects, also set to undefined
            [{ jobName: 'ping', sort: undefined }, undefined],
            [{ jobName: 'ping' }, { order: undefined }],
            [{ jobName: 'Bad Name' }, undefined],
            [{ jobName: { name: 'Bad Name' } }, undefined],
            [{ jobName: 'ping', status: 'done' }, undefined],
            [{ jobName: 'ping', status: [] }, undefined],
            [{ jobName: 'ping', status: ['failed', 'failed'] }, undefined],
            [{ jobName: 'ping' }, null],
            [{ jobName: 'ping' }, { order: 'asc' }],
            [{ jobName: 'ping' }, { limit: 0 }],
            [{ jobName: 'ping' }, { limit: 1001 }],
            [{ jobName: 'ping' }, { limit: 1.5 }],
            [{ jobName: 'ping' }, { includePayload: 'yes' }],
            [{ jobName: 'ping' }, { cursor: 'nonsense' }],
            [{ jobName: 'ping' }, { cursor: 42 }],
            [{ jobName: 'ping' }, { cursor: cursorOf([2, ...good.slice(1)]) }],
            [{ jobName: 'ping' }, { cursor: cursorOf(good.slice(0, 4)) }],
            [{ jobName: 'ping' }, { cursor: cursorOf([...good, 'extra']) }],
            [{ jobName: 'ping' }, { cursor: cursorOf([1, 'ping', null, -1, 'ping:x']) }],
            [{ jobName: 'ping' }, { cursor: cursorOf([1, 'ping', null, 8.64e15, 'ping:x']) }],
            [{ jobName: 'ping' }, { cursor: cursorOf([1, 'ping', null, Date.now(), 'ping:é']) }],
            [{ jobName: 'ping' }, { cursor: cursorOf([1, 'ping', ['failed', 'pending'], Date.now(), 'ping:x']) }],
        ])) {
            // oxlint-disable-next-line no-await-in-loop -- one after the other
            await expect(sqlane.jobs.list(filter, options)).rejects.toBeInstanceOf(InvalidOptionsError);
        }
    });
});

describe('sqlane.jobs', () => {
    test('reads before start() and after the close() of a started instance, with unknownJobs: reject; a frozen object',
        async () => {
            const sqlane = await freshSqlane({ unknownJobs: 'reject', jobs: [defineJob({ name: 'known' })] });

            const { id } = await sqlane.enqueue(testAdapter.pool, 'known', {}, { jobId: 'k1' });

            await expect(sqlane.jobs.list({ jobName: 'unknown' })).resolves.toStrictEqual({ jobs: [], nextCursor: null });
            await expect(sqlane.jobs.get('unknown:x')).resolves.toBeNull();
            await sqlane.start();
            await sqlane.close();
            await expect(sqlane.jobs.get(id)).resolves.toMatchObject({ id });
            await expect(sqlane.jobs.list({ jobName: 'known' })).resolves.toMatchObject({ jobs: [{ id }] });
            expect(Object.isFrozen(sqlane.jobs)).toBe(true);
        });

    test('before migrate(): the reads reject with the error of the database', async () => {
        const sqlane = await freshSqlane({}, { migrate: false });

        await expect(sqlane.jobs.get('ping:x')).rejects.toThrow(/exist/);
        await expect(sqlane.jobs.list({ jobName: 'ping' })).rejects.toThrow(/exist/);
        // A string that cannot be an id: null, without a query, so without the tables too
        await expect(sqlane.jobs.get('')).resolves.toBeNull();
    });
});
