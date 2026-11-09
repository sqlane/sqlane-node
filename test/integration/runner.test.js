import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
    createSqlane,
    defineJob,
    DrainTimeoutError,
    FatalJobError,
    JobTimeoutError,
    RetryJobError,
    ShutdownError,
} from '../../src/index.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @typedef {import('../../src/types.js').Sqlane<any, any>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */

/** Fast timers: the tests wait milliseconds, not minutes */
const TIMINGS = { leaseMs: 5000, renewIntervalMs: 500, recoveryIntervalMs: 500, missingPayloadGraceMs: 60_000 };
const fixedBackoff = /** @type {const} */ ({ type: 'fixed', delay: 10, jitter: 0 });

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
 * A sqlane instance on tables of its own, migrated.
 * @param {Partial<import('../../src/types.js').SqlaneOptions<any, any>>} [options]
 * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
 */
async function freshSqlane(options = {}) {
    prefixCount++;

    const p = `${database.tablePrefix}${prefixCount}_`;
    /** @type {SqlaneEvent[]} */
    const events = [];
    const sqlane = createSqlane(/** @type {any} */ ({
        adapter: testAdapter.adapter,
        tablePrefix: p,
        pollInterval: '100ms',
        onEvent: (/** @type {SqlaneEvent} */ event) => events.push(event),
        timings: TIMINGS,
        ...options,
    }));

    instances.push(sqlane);
    await sqlane.migrate();

    return { sqlane, p, events };
}

/**
 * @param {string} p
 * @returns {Promise<{ id: string, job_name: string, status: string, attempts: number }[]>}
 */
async function readJobs(p) {
    return (await database.query(`SELECT id, job_name, status, attempts FROM ${p}jobs ORDER BY created_at, id`))
        .map(row => ({
            id: String(row.id),
            job_name: String(row.job_name),
            status: String(row.status),
            attempts: Number(row.attempts),
        }));
}

/**
 * Waits until the condition holds.
 * @param {() => boolean | Promise<boolean>} condition
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
 * A handler that throws on its first calls, then succeeds.
 * @param {number} failures
 * @param {(call: number) => unknown} makeError
 * @returns {{ handler: import('../../src/types.js').Handler, calls: () => number }}
 */
function failingFirst(failures, makeError) {
    let calls = 0;

    return {
        handler: () => {
            calls++;

            if (calls <= failures) {
                throw makeError(calls);
            }
        },
        calls: () => calls,
    };
}

/**
 * A handler whose first call ignores its signal for a while, then keeps the signal reason.
 * @param {number} ms
 * @returns {{ handler: import('../../src/types.js').Handler, reasons: unknown[] }}
 */
function slowFirst(ms) {
    /** @type {unknown[]} */
    const reasons = [];
    let calls = 0;

    return {
        handler: async ({ signal }) => {
            calls++;

            if (calls === 1) {
                await sleep(ms);
                reasons.push(signal.reason);
            }
        },
        reasons,
    };
}

/**
 * Counts the handlers that run at the same time.
 * @returns {{ enter: () => void, leave: () => void, max: () => number }}
 */
function concurrencyMeter() {
    let current = 0;
    let max = 0;

    return {
        enter: () => {
            current++;
            max = Math.max(max, current);
        },
        leave: () => {
            current--;
        },
        max: () => max,
    };
}

describe('start()', () => {
    test('runs a job: the handler gets the payload and the job; the job completes', async () => {
        const { sqlane, p, events } = await freshSqlane();
        /** @type {import('../../src/types.js').HandlerContext[]} */
        const contexts = [];

        sqlane.handle('build_report', (context) => {
            contexts.push(context);
        });
        await sqlane.start();

        const { id } = await sqlane.enqueue(testAdapter.pool, 'build_report', { reportId: 'r1' });

        // The event comes after the write commits: wait for the event, not for the row
        await waitFor(() => events.some(event => event.type === 'completed'));
        await expect(readJobs(p)).resolves.toMatchObject([{ status: 'completed' }]);
        expect(contexts).toMatchObject([{
            payload: { reportId: 'r1' },
            job: { id, name: 'build_report', attempt: 1, maxAttempts: 3, mutexKeys: [] },
        }]);
        expect(contexts[0].signal.aborted).toBe(false);
        expect(events.map(event => event.type)).toStrictEqual(['claimed', 'completed']);
    });

    test('a job enqueued in this process starts at once, not at the next poll', async () => {
        const { sqlane, p } = await freshSqlane({ pollInterval: '10s' });

        sqlane.handle('ping', () => {});
        await sqlane.start();
        // The first turn has probed nothing; the next poll is 10 s away
        await sleep(100);

        const connection = await testAdapter.connect();
        const startedAt = Date.now();

        try {
            await connection.begin();
            await sqlane.enqueue(connection.raw, 'ping', {});
            await sleep(30);
            await connection.commit();
        } finally {
            connection.release();
        }

        await waitFor(async () => (await readJobs(p))[0]?.status === 'completed', 3000);
        expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    test('a job enqueued soon after another one starts at once too', async () => {
        const { sqlane, events } = await freshSqlane({ pollInterval: '10s' });
        /** @type {Map<string, number>} */
        const startedAt = new Map();

        sqlane.handle('ping', ({ job }) => {
            startedAt.set(job.id, Date.now());
        });
        await sqlane.start();
        await sleep(100);
        await sqlane.enqueue(testAdapter.pool, 'ping', {});
        await waitFor(() => events.some(event => event.type === 'completed'));
        // The re-probes of the first enqueue are at 500 ms, then 1 s from it: the second one must not wait for them
        await sleep(250);

        const enqueuedAt = Date.now();
        const { id } = await sqlane.enqueue(testAdapter.pool, 'ping', {});

        await waitFor(() => startedAt.has(id), 3000);
        expect(Number(startedAt.get(id)) - enqueuedAt).toBeLessThan(150);
    });

    test('retries by the backoff, then completes', async () => {
        const { sqlane, p } = await freshSqlane();
        const flaky = failingFirst(2, call => new Error(`fail ${call}`));

        sqlane.handle(defineJob({ name: 'flaky', backoff: fixedBackoff }), flaky.handler);
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'flaky', {});
        await waitFor(async () => (await readJobs(p))[0]?.status === 'completed');

        expect(flaky.calls()).toBe(3);
        await expect(readJobs(p)).resolves.toMatchObject([{ attempts: 2 }]);
    });

    test('after the last attempt: failed, and its failure job runs with the failed job', async () => {
        const reportFailed = defineJob({ name: 'report_failed' });
        const { sqlane, p } = await freshSqlane({ jobs: [reportFailed] });
        /** @type {unknown[]} */
        const failures = [];

        sqlane.handle(defineJob({ name: 'build', maxAttempts: 2, backoff: fixedBackoff, failureJob: 'report_failed' }), () => {
            throw new Error('broken');
        });
        sqlane.handle(reportFailed, ({ payload }) => {
            failures.push(payload);
        });
        await sqlane.start();

        const { id } = await sqlane.enqueue(testAdapter.pool, 'build', { reportId: 'r1' });

        await waitFor(() => failures.length === 1);
        expect(failures[0]).toMatchObject({
            job: { id, name: 'build', payload: { reportId: 'r1' }, attempt: 2, maxAttempts: 2 },
            error: { name: 'Error', message: 'broken' },
        });
        await expect(readJobs(p)).resolves.toMatchObject([
            { job_name: 'build', status: 'failed', attempts: 2 },
            { job_name: 'report_failed', status: expect.stringMatching(/running|completed/) },
        ]);
    });

    test('FatalJobError: fails at once; RetryJobError: retries after its delay', async () => {
        const { sqlane, p, events } = await freshSqlane();

        sqlane.handle('fatal', () => {
            throw new FatalJobError('no such report');
        });
        sqlane.handle('limited', failingFirst(1, () => new RetryJobError('rate limited', { delay: '300ms' })).handler);
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'fatal', {});
        await sqlane.enqueue(testAdapter.pool, 'limited', {});
        await waitFor(async () => (await readJobs(p)).every(job => ['failed', 'completed'].includes(job.status)));

        await expect(readJobs(p)).resolves.toMatchObject([
            { job_name: 'fatal', status: 'failed', attempts: 1 },
            { job_name: 'limited', status: 'completed', attempts: 1 },
        ]);
        expect(events.find(event => event.type === 'retried')).toMatchObject({ jobName: 'limited', delayMs: 300 });
    });
});

describe('concurrency', () => {
    test('a private lane, a shared lane and the process concurrency', async () => {
        const { sqlane, p } = await freshSqlane({ concurrency: 3, lanes: { shared: { concurrency: 2 } } });
        const privateMeter = concurrencyMeter();
        const sharedMeter = concurrencyMeter();
        const allMeter = concurrencyMeter();
        /**
         * @param {ReturnType<typeof concurrencyMeter>} meter
         * @returns {() => Promise<void>}
         */
        const slowHandler = meter => async () => {
            meter.enter();
            allMeter.enter();
            await sleep(50);
            meter.leave();
            allMeter.leave();
        };

        sqlane.handle('solo', slowHandler(privateMeter), { concurrency: 1 });
        sqlane.handle('shared_a', slowHandler(sharedMeter), { lane: 'shared' });
        sqlane.handle('shared_b', slowHandler(sharedMeter), { lane: 'shared' });
        sqlane.handle('free', slowHandler(concurrencyMeter()));

        for (const name of ['solo', 'shared_a', 'shared_b', 'free']) {
            // oxlint-disable-next-line no-await-in-loop -- a few enqueues
            await sqlane.enqueueMany(testAdapter.pool, name, Array.from({ length: 4 }, () => ({ payload: {} })));
        }

        await sqlane.start();
        await waitFor(async () => (await readJobs(p)).every(job => job.status === 'completed'), 10_000);

        expect(privateMeter.max()).toBe(1);
        expect(sharedMeter.max()).toBe(2);
        expect(allMeter.max()).toBe(3);
    });

    test('mutex keys: the jobs of a key run one at a time, other keys in parallel', async () => {
        const { sqlane, p } = await freshSqlane();
        const perKey = new Map([['order:1', concurrencyMeter()], ['order:2', concurrencyMeter()]]);
        const allMeter = concurrencyMeter();

        sqlane.handle(defineJob({ name: 'sync', mutexKeys: payload => [`order:${payload.orderId}`], timeout: '5s' }), async ({ job }) => {
            const meter = /** @type {ReturnType<typeof concurrencyMeter>} */ (perKey.get(job.mutexKeys[0]));

            meter.enter();
            allMeter.enter();
            await sleep(40);
            meter.leave();
            allMeter.leave();
        });
        await sqlane.enqueueMany(testAdapter.pool, 'sync', [1, 2, 1, 2, 1, 2].map(orderId => ({ payload: { orderId } })));
        await sqlane.start();
        await waitFor(async () => (await readJobs(p)).every(job => job.status === 'completed'), 10_000);

        expect(perKey.get('order:1')?.max()).toBe(1);
        expect(perKey.get('order:2')?.max()).toBe(1);
        expect(allMeter.max()).toBe(2);
    });
});

test('a timeout: the signal aborts; the job keeps running until the handler settles, then it is retried', async () => {
    const { sqlane, p, events } = await freshSqlane();
    const slow = slowFirst(300);

    sqlane.handle(defineJob({ name: 'slow', backoff: fixedBackoff, timeout: '50ms' }), slow.handler);
    await sqlane.start();
    await sqlane.enqueue(testAdapter.pool, 'slow', {});
    await waitFor(() => events.some(event => event.type === 'timed_out'));

    await expect(readJobs(p)).resolves.toMatchObject([{ status: 'running' }]);
    await waitFor(async () => (await readJobs(p))[0]?.status === 'completed');
    expect(slow.reasons[0]).toBeInstanceOf(JobTimeoutError);
    await expect(readJobs(p)).resolves.toMatchObject([{ attempts: 1 }]);
});

describe('close()', () => {
    test('release: a handler that does not finish by the deadline is released, without an attempt', async () => {
        const { sqlane, p, events } = await freshSqlane();
        /** @type {unknown[]} */
        const reasons = [];

        sqlane.handle('long', async ({ signal }) => {
            await new Promise((resolve) => {
                signal.addEventListener('abort', resolve);
            });
            reasons.push(signal.reason);
            throw signal.reason;
        });
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'long', {});
        await waitFor(async () => (await readJobs(p))[0]?.status === 'running');
        await sqlane.close({ deadline: '100ms', exitsBy: '200ms' });

        expect(reasons[0]).toBeInstanceOf(ShutdownError);
        await expect(readJobs(p)).resolves.toMatchObject([{ status: 'pending', attempts: 0 }]);
        expect(events.map(event => event.type)).toContain('released');
    });

    test('abandon: nothing is written; the lease ends', async () => {
        const { sqlane, p } = await freshSqlane();

        sqlane.handle('long', () => sleep(1000));
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'long', {});
        await waitFor(async () => (await readJobs(p))[0]?.status === 'running');
        await sqlane.close({ deadline: '50ms', mode: 'abandon' });

        await expect(readJobs(p)).resolves.toMatchObject([{ status: 'running', attempts: 0 }]);
    });

    test('waits for the running handlers until the deadline', async () => {
        const { sqlane, p } = await freshSqlane();

        sqlane.handle('short', () => sleep(100));
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'short', {});
        await waitFor(async () => (await readJobs(p))[0]?.status === 'running');
        await sqlane.close({ deadline: '5s' });

        await expect(readJobs(p)).resolves.toMatchObject([{ status: 'completed' }]);
    });
});

describe('drain()', () => {
    test('runs the due jobs of the handled names until none is left', async () => {
        const { sqlane, p } = await freshSqlane();
        let calls = 0;

        sqlane.handle('ping', () => {
            calls++;
        });
        await sqlane.enqueueMany(testAdapter.pool, 'ping', [{ payload: {} }, { payload: {} }]);
        await sqlane.enqueue(testAdapter.pool, 'ping', {}, { delay: '1h' });
        await sqlane.enqueue(testAdapter.pool, 'not_handled', {});

        await expect(sqlane.drain()).resolves.toStrictEqual({ completed: 2, retried: 0, failed: 0 });
        expect(calls).toBe(2);
        await expect(readJobs(p)).resolves.toMatchObject([
            { status: 'completed' },
            { status: 'completed' },
            { status: 'pending' },
            { status: 'pending' },
        ]);
    });

    test('includeDelayed: "fails 3 times, then the failure job runs"', async () => {
        const failed = defineJob({ name: 'build_failed' });
        const { sqlane } = await freshSqlane({ jobs: [failed] });
        let failureRuns = 0;

        sqlane.handle(defineJob({ name: 'build', failureJob: 'build_failed' }), () => {
            throw new Error('broken');
        });
        sqlane.handle(failed, () => {
            failureRuns++;
        });
        await sqlane.enqueue(testAdapter.pool, 'build', {});

        await expect(sqlane.drain({ includeDelayed: true }))
            .resolves.toStrictEqual({ completed: 1, retried: 2, failed: 1 });
        expect(failureRuns).toBe(1);
    });

    test('rejects with DrainTimeoutError when it does not finish in time', async () => {
        const { sqlane } = await freshSqlane();

        sqlane.handle('long', () => sleep(500));
        await sqlane.enqueue(testAdapter.pool, 'long', {});

        await expect(sqlane.drain({ timeout: '100ms' })).rejects.toThrow(DrainTimeoutError);
    });
});
