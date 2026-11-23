import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
    createSqlane,
    defineConcurrencyLimit,
    defineLane,
    defineRateLimit,
    DrainTimeoutError,
    FatalJobError,
    JobTimeoutError,
    RateLimitedError,
    RetryJobError,
    ShutdownError,
} from '../../src/index.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @typedef {import('../../src/types.js').Sqlane<any>} Sqlane */
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
 * @param {Partial<import('../../src/types.js').SqlaneOptions<any>>} [options]
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
    await sqlane.schema.migrate();

    return { sqlane, p, events };
}

/**
 * @param {string} p
 * @returns {Promise<{ id: string, lane: string, status: string, attempts: number }[]>}
 */
async function readJobs(p) {
    return (await database.query(`SELECT id, lane, status, attempts FROM ${p}jobs ORDER BY created_at, id`))
        .map(row => ({
            id: String(row.id),
            lane: String(row.lane),
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

        sqlane.lanes.add('build_report', (context) => {
            contexts.push(context);
        });
        await sqlane.start();

        const { id } = await sqlane.enqueue(testAdapter.pool, 'build_report', { reportId: 'r1' });

        // The event comes after the write commits: wait for the event, not for the row
        await waitFor(() => events.some(event => event.type === 'completed'));
        await expect(readJobs(p)).resolves.toMatchObject([{ status: 'completed' }]);
        expect(contexts).toMatchObject([{
            payload: { reportId: 'r1' },
            job: { id, lane: 'build_report', attempt: 1, maxAttempts: 3, globalConcurrencyLimits: [] },
        }]);
        expect(contexts[0].signal.aborted).toBe(false);
        expect(events.map(event => event.type)).toStrictEqual(['claimed', 'completed']);
    });

    test('a job enqueued in this process starts at once, not at the next poll', async () => {
        const { sqlane, p } = await freshSqlane({ pollInterval: '10s' });

        sqlane.lanes.add('ping', () => {});
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

        sqlane.lanes.add('ping', ({ job }) => {
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

        sqlane.lanes.add(defineLane({ name: 'flaky', backoff: fixedBackoff }), flaky.handler);
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'flaky', {});
        await waitFor(async () => (await readJobs(p))[0]?.status === 'completed');

        expect(flaky.calls()).toBe(3);
        await expect(readJobs(p)).resolves.toMatchObject([{ attempts: 3 }]);
    });

    test('after the last attempt: failed, and its failure job runs with the failed job', async () => {
        const reportFailed = defineLane({ name: 'report_failed' });
        const { sqlane, p } = await freshSqlane({ lanes: [reportFailed] });
        /** @type {unknown[]} */
        const failures = [];

        sqlane.lanes.add(defineLane({ name: 'build', maxAttempts: 2, backoff: fixedBackoff, failureLane: 'report_failed' }), () => {
            throw new Error('broken');
        });
        sqlane.lanes.add(reportFailed, ({ payload }) => {
            failures.push(payload);
        });
        await sqlane.start();

        const { id } = await sqlane.enqueue(testAdapter.pool, 'build', { reportId: 'r1' });

        await waitFor(() => failures.length === 1);
        expect(failures[0]).toMatchObject({
            job: { id, lane: 'build', payload: { reportId: 'r1' }, attempt: 2, maxAttempts: 2 },
            error: { name: 'Error', message: 'broken' },
        });
        await expect(readJobs(p)).resolves.toMatchObject([
            { lane: 'build', status: 'failed', attempts: 2 },
            { lane: 'report_failed', status: expect.stringMatching(/running|completed/) },
        ]);
    });

    test('FatalJobError: fails at once; RetryJobError: retries after its delay', async () => {
        const { sqlane, p, events } = await freshSqlane();

        sqlane.lanes.add('fatal', () => {
            throw new FatalJobError('no such report');
        });
        sqlane.lanes.add('limited', failingFirst(1, () => new RetryJobError('rate limited', { delay: '300ms' })).handler);
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'fatal', {});
        await sqlane.enqueue(testAdapter.pool, 'limited', {});
        await waitFor(async () => (await readJobs(p)).every(job => ['failed', 'completed'].includes(job.status)));

        await expect(readJobs(p)).resolves.toMatchObject([
            { lane: 'fatal', status: 'failed', attempts: 1 },
            { lane: 'limited', status: 'completed', attempts: 2 },
        ]);
        expect(events.find(event => event.type === 'retried')).toMatchObject({ lane: 'limited', delayMs: 300 });
    });
});

describe('the async context of a handler', () => {
    test('a job enqueued in this process runs in the context of start(), not in the context of the enqueue',
        async () => {
            const { sqlane, events } = await freshSqlane({ pollInterval: '10s' });
            /** @type {AsyncLocalStorage<{ owner: string }>} */
            const storage = new AsyncLocalStorage();
            /** @type {unknown[]} */
            const stores = [];

            sqlane.lanes.add('ping', () => {
                stores.push(storage.getStore());
            });
            await storage.run({ owner: 'worker' }, () => sqlane.start());
            // The first turn has probed nothing; the next poll is 10 s away: the enqueue wakes the handler
            await sleep(100);
            await storage.run({ owner: 'request' }, () => sqlane.enqueue(testAdapter.pool, 'ping', {}));
            await waitFor(() => events.some(event => event.type === 'completed'), 3000);

            expect(stores).toStrictEqual([{ owner: 'worker' }]);
        });

    test('drain() runs the jobs in its own context', async () => {
        const { sqlane } = await freshSqlane();
        /** @type {AsyncLocalStorage<{ owner: string }>} */
        const storage = new AsyncLocalStorage();
        /** @type {unknown[]} */
        const stores = [];

        sqlane.lanes.add('ping', () => {
            stores.push(storage.getStore());
        });
        await storage.run({ owner: 'request' }, () => sqlane.enqueue(testAdapter.pool, 'ping', {}));
        await storage.run({ owner: 'test' }, () => sqlane.drain());

        expect(stores).toStrictEqual([{ owner: 'test' }]);
    });
});

describe('concurrency', () => {
    test('the local limit of a name, a shared local limit and the cap of the instance', async () => {
        const { sqlane, p } = await freshSqlane({ localMaxConcurrency: 3 });
        const solo = defineConcurrencyLimit({ name: 'solo', max: 1 });
        const shared = defineConcurrencyLimit({ name: 'shared', max: 2 });
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

        sqlane.lanes.add(defineLane({ name: 'solo', localConcurrencyLimits: [solo] }), slowHandler(privateMeter));
        sqlane.lanes.add(defineLane({ name: 'shared_a', localConcurrencyLimits: [shared] }), slowHandler(sharedMeter));
        sqlane.lanes.add(defineLane({ name: 'shared_b', localConcurrencyLimits: [shared] }), slowHandler(sharedMeter));
        sqlane.lanes.add('free', slowHandler(concurrencyMeter()));

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

    test('a busy name and a wake of more than 100 other names: each job runs once (the probe of all names gives the '
        + 'names of the claim too)', async () => {
        const { sqlane, p, events } = await freshSqlane({ localMaxConcurrency: 8, pollInterval: '10s' });
        const names = Array.from({ length: 150 }, (_, at) => `n${String(at).padStart(3, '0')}`);
        /** @type {string[]} The ids of the jobs that started */
        const runs = [];
        /** @type {import('../../src/types.js').Handler} */
        const count = ({ job }) => {
            runs.push(job.id);
        };

        // The busy name fills the instance: its claims fill the free slots, so it stays in the backlog, claimed at once
        sqlane.lanes.add('busy', async (context) => {
            count(context);
            await sleep(20);
        });

        for (const name of names) {
            sqlane.lanes.add(name, count);
        }

        await sqlane.start();
        await sqlane.enqueueMany(testAdapter.pool, 'busy', Array.from({ length: 300 }, () => ({ payload: {} })));

        // Enqueues of 150 names in this process: their re-probes wake them all at once, a probe of more than 100
        // names, which reads all names
        for (const name of names) {
            // oxlint-disable-next-line no-await-in-loop -- one enqueue after the other
            await sqlane.enqueue(testAdapter.pool, name, {});
        }

        await waitFor(async () => (await readJobs(p)).every(job => job.status === 'completed'), 30_000);

        // The ids that started more than once
        expect(runs.filter((id, at) => runs.indexOf(id) !== at)).toStrictEqual([]);
        expect(runs).toHaveLength(300 + names.length);
        expect(events.filter(event => event.type === 'error')).toStrictEqual([]);
    }, 40_000);

    test('a global limit of 1: the jobs of a key run one at a time, other keys in parallel', async () => {
        const { sqlane, p } = await freshSqlane();
        const perKey = new Map([['order:1', concurrencyMeter()], ['order:2', concurrencyMeter()]]);
        const allMeter = concurrencyMeter();
        const order = defineConcurrencyLimit({ name: 'order', max: 1 });
        const sync = defineLane({
            name: 'sync',
            globalConcurrencyLimits: ({ payload }) => [order.key(payload.orderId)],
            timeout: '5s',
        });

        sqlane.lanes.add(sync, async ({ job }) => {
            const key = job.globalConcurrencyLimits[0].key;
            const meter = /** @type {ReturnType<typeof concurrencyMeter>} */ (perKey.get(key));

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

    test('a backlog of 600 jobs on a full key, more than a search reads: the jobs of another key still run', async () => {
        const { sqlane, p } = await freshSqlane();
        const client = defineConcurrencyLimit({ name: 'client', max: 1 });
        const send = defineLane({
            name: 'send',
            globalConcurrencyLimits: ({ payload }) => [client.key(payload.clientId)],
            timeout: '30s',
        });
        const held = Promise.withResolvers();
        /** @type {Record<string, Promise<unknown>>} The flood waits; the other key runs at once */
        const gates = { flood: held.promise, other: Promise.resolve() };
        /** @type {string[]} */
        const done = [];

        sqlane.lanes.add(send, async ({ payload }) => {
            await gates[payload.clientId];
            done.push(payload.clientId);
        });
        await sqlane.enqueueMany(testAdapter.pool, send, Array.from({ length: 600 }, () => ({
            payload: { clientId: 'flood' },
        })));
        await sqlane.enqueueMany(testAdapter.pool, send, [1, 2, 3].map(() => ({ payload: { clientId: 'other' } })));
        const countsOf = async () => (await database.query(
            `SELECT status, count(*) AS count FROM ${p}jobs GROUP BY status ORDER BY status`,
        )).map(row => [row.status, Number(row.count)]);

        await sqlane.start();
        // The completions commit before their events: wait for the rows
        await waitFor(async () => JSON.stringify(await countsOf()).includes('["completed",3]'), 10_000);

        expect(done).toStrictEqual(['other', 'other', 'other']);
        await expect(countsOf()).resolves.toStrictEqual([
            ['blocked', 599], ['completed', 3], ['running', 1],
        ]);
        held.resolve(undefined);
        await sqlane.close({ deadline: '1s' });
    });
});

/**
 * @param {string} p
 * @returns {Promise<Record<string, number>>} The jobs by status.
 */
async function statusCounts(p) {
    const rows = await database.query(`SELECT status, count(*) AS count FROM ${p}jobs GROUP BY status`);

    return Object.fromEntries(rows.map(row => [String(row.status), Number(row.count)]));
}

describe('global rate limits', () => {
    test('the jobs blocked on a rate key start at their time, by its timer, without a poll', async () => {
        const { sqlane, p } = await freshSqlane(/** @type {any} */ ({
            pollInterval: '10s',
            timings: { ...TIMINGS, recoveryIntervalMs: 60_000 },
        }));
        // One start each 100 ms
        const smooth = defineRateLimit({ name: 'smooth', max: 10, per: '1s' });
        const tick = defineLane({ name: 'tick', globalRateLimits: () => [smooth] });
        /** @type {number[]} */
        const starts = [];

        sqlane.lanes.add(tick, () => {
            starts.push(Date.now());
        });
        await sqlane.enqueueMany(testAdapter.pool, tick, [1, 2, 3, 4].map(n => ({ payload: { n } })));
        await sqlane.start();
        await waitFor(async () => (await statusCounts(p)).completed === 4, 3000);

        for (const [at, start] of starts.slice(1).entries()) {
            // The database clock spaces the claims by 100 ms; the handlers start a few ms after them
            expect(start - starts[at]).toBeGreaterThanOrEqual(85);
        }

        // The timer, not the poll
        expect(/** @type {number} */ (starts.at(-1)) - starts[0]).toBeLessThan(2000);
    });

    test('a flood on one rate key does not hold the other keys of the name', async () => {
        const { sqlane, p } = await freshSqlane();
        const account = defineRateLimit({ name: 'account', max: 3, per: '1h', burst: 3 });
        const call = defineLane({ name: 'call', globalRateLimits: ({ payload }) => [account.key(payload.account)] });
        /** @type {string[]} */
        const done = [];

        sqlane.lanes.add(call, ({ payload }) => {
            done.push(payload.account);
        });
        // More than a search reads
        await sqlane.enqueueMany(testAdapter.pool, call, Array.from({ length: 600 }, () => ({
            payload: { account: 'flood' },
        })));
        await sqlane.enqueueMany(testAdapter.pool, call, [1, 2, 3].map(() => ({ payload: { account: 'other' } })));
        await sqlane.start();
        await waitFor(async () => (await statusCounts(p)).completed === 6, 10_000);

        expect(done.filter(key => key === 'other')).toHaveLength(3);
        await expect(statusCounts(p)).resolves.toStrictEqual({ blocked: 597, completed: 6 });
    });

    test('two processes never start more than the quota', async () => {
        const { sqlane, p } = await freshSqlane();
        const other = createSqlane(/** @type {any} */ ({
            adapter: testAdapter.adapter,
            tablePrefix: p,
            pollInterval: '100ms',
            timings: TIMINGS,
        }));
        const quota = defineRateLimit({ name: 'quota', max: 3, per: '1h', burst: 3 });
        const call = defineLane({ name: 'call', globalRateLimits: () => [quota] });

        instances.push(other);

        for (const each of [sqlane, other]) {
            each.lanes.add(call, () => {});
        }

        await sqlane.enqueueMany(testAdapter.pool, call, Array.from({ length: 12 }, (_, n) => ({ payload: { n } })));
        await Promise.all([sqlane.start(), other.start()]);
        await waitFor(async () => (await statusCounts(p)).completed === 3, 3000);
        await sleep(300);
        await expect(statusCounts(p)).resolves.toStrictEqual({ blocked: 9, completed: 3 });
    });

    test('a process that stopped with its timer: the sweep of another one unblocks the jobs', async () => {
        const { sqlane, p } = await freshSqlane();
        const other = createSqlane(/** @type {any} */ ({
            adapter: testAdapter.adapter,
            tablePrefix: p,
            pollInterval: '10s',
            timings: TIMINGS,
        }));
        const smooth = defineRateLimit({ name: 'smooth', max: 10, per: '1s' });
        const tick = defineLane({ name: 'tick', globalRateLimits: () => [smooth] });

        instances.push(other);

        for (const each of [sqlane, other]) {
            each.lanes.add(tick, () => {});
        }

        await sqlane.enqueueMany(testAdapter.pool, tick, [1, 2, 3].map(n => ({ payload: { n } })));
        await sqlane.start();
        await waitFor(async () => (await statusCounts(p)).completed === 1, 3000);
        await sqlane.close();
        await other.start();
        // The sweep runs each 500 ms here; then the timer of the other process
        await waitFor(async () => (await statusCounts(p)).completed === 3, 5000);
        await expect(statusCounts(p)).resolves.toStrictEqual({ completed: 3 });
    });

    test('drain() waits for the jobs blocked on a rate key of this process', async () => {
        const { sqlane } = await freshSqlane();
        // One start each 50 ms
        const smooth = defineRateLimit({ name: 'smooth', max: 20, per: '1s' });
        const tick = defineLane({ name: 'tick', globalRateLimits: () => [smooth] });

        sqlane.lanes.add(tick, () => {});
        await sqlane.enqueueMany(testAdapter.pool, tick, [1, 2, 3, 4].map(n => ({ payload: { n } })));
        await expect(sqlane.drain()).resolves.toStrictEqual({ completed: 4, retried: 0, failed: 0 });
    });
});

describe('local rate limits', () => {
    test('two names share a limit: its burst at once, then one start per per / max, by a timer, without a poll', async () => {
        const { sqlane, p } = await freshSqlane(/** @type {any} */ ({
            pollInterval: '10s',
            timings: { ...TIMINGS, recoveryIntervalMs: 60_000 },
        }));
        // 10 per s, bursts of 2: one each 100 ms after the burst
        const disk = defineRateLimit({ name: 'disk', max: 10, per: '1s', burst: 2 });
        /** @type {{ name: string, at: number }[]} */
        const starts = [];

        for (const name of ['read', 'write']) {
            sqlane.lanes.add(defineLane({ name, localRateLimits: [disk] }), ({ job }) => {
                starts.push({ name: job.lane, at: Date.now() });
            });
            // oxlint-disable-next-line no-await-in-loop -- two names
            await sqlane.enqueueMany(testAdapter.pool, name, [1, 2, 3].map(n => ({ payload: { n } })));
        }

        await sqlane.start();
        await waitFor(async () => (await statusCounts(p)).completed === 6, 3000);

        const times = starts.map(start => start.at).toSorted((a, b) => a - b);

        expect(new Set(starts.map(start => start.name))).toStrictEqual(new Set(['read', 'write']));
        // The burst
        expect(times[1] - times[0]).toBeLessThan(50);

        // Then one each 100 ms: the k-th start is not before the first + (k - 1) × 100 ms. Not the gap between two
        // starts: a start that its claim delays makes the next gap shorter, and the quota allows it
        for (let at = 2; at < times.length; at++) {
            expect(times[at] - times[0]).toBeGreaterThanOrEqual(((at - 1) * 100) - 15);
        }

        // The timer, not the poll
        expect(/** @type {number} */ (times.at(-1)) - times[0]).toBeLessThan(1500);
    });

    test('a name over its limit is not claimed: its jobs stay pending, for the other processes', async () => {
        const { sqlane, p } = await freshSqlane();
        const other = createSqlane(/** @type {any} */ ({
            adapter: testAdapter.adapter,
            tablePrefix: p,
            pollInterval: '100ms',
            timings: TIMINGS,
        }));
        const hourly = defineRateLimit({ name: 'hourly', max: 1, per: '1h' });
        const report = defineLane({ name: 'report', localRateLimits: [hourly] });

        instances.push(other);
        sqlane.lanes.add(report, () => {});
        other.lanes.add(report, () => {});
        await sqlane.enqueueMany(testAdapter.pool, report, [1, 2, 3].map(n => ({ payload: { n } })));
        await sqlane.start();
        await waitFor(async () => (await statusCounts(p)).completed === 1);
        await sleep(300);
        await expect(statusCounts(p)).resolves.toStrictEqual({ completed: 1, pending: 2 });

        // Each process counts its own starts
        await other.start();
        await waitFor(async () => (await statusCounts(p)).completed === 2);
        await sleep(300);
        await expect(statusCounts(p)).resolves.toStrictEqual({ completed: 2, pending: 1 });
    });

    test('drain() waits for a local rate limit that admits the due jobs before its timeout', async () => {
        const { sqlane } = await freshSqlane();
        // One start each 50 ms
        const disk = defineRateLimit({ name: 'disk', max: 20, per: '1s' });
        const scan = defineLane({ name: 'scan', localRateLimits: [disk] });

        sqlane.lanes.add(scan, () => {});
        await sqlane.enqueueMany(testAdapter.pool, scan, [1, 2, 3, 4].map(n => ({ payload: { n } })));
        await expect(sqlane.drain()).resolves.toStrictEqual({ completed: 4, retried: 0, failed: 0 });
    });
});

/**
 * @param {SqlaneEvent[]} events
 * @returns {Extract<SqlaneEvent, { type: 'rate_limited' }> | undefined}
 */
function rateLimitedEvent(events) {
    return /** @type {Extract<SqlaneEvent, { type: 'rate_limited' }> | undefined} */ (
        events.find(event => event.type === 'rate_limited')
    );
}

/**
 * Handles the jobs: the first call of all throws the error; each call records its start.
 * @param {Sqlane} sqlane
 * @param {import('../../src/types.js').LaneDefinition<any>[]} jobs
 * @param {() => Error} makeError
 * @returns {{ name: string, payload: any, at: number }[]} The starts.
 */
function throwFirst(sqlane, jobs, makeError) {
    /** @type {{ name: string, payload: any, at: number }[]} */
    const starts = [];

    for (const job of jobs) {
        sqlane.lanes.add(job, ({ job: { lane }, payload }) => {
            starts.push({ name: lane, payload, at: Date.now() });

            if (starts.length === 1) {
                throw makeError();
            }
        });
    }

    return starts;
}

describe('RateLimitedError', () => {
    // Plenty of quota: only the error holds the key
    const api = defineRateLimit({ name: 'api', max: 100, per: '1s', burst: 100 });
    const call = defineLane({
        name: 'call',
        globalRateLimits: ({ payload }) => [api.key(payload.account)],
        timeout: '5s',
    });

    test('on a global key: the job is blocked on it, without an attempt; the key starts no job before retryAfter, '
        + 'other keys run', async () => {
        const { sqlane, p, events } = await freshSqlane();
        const starts = throwFirst(sqlane, [call], () => new RateLimitedError({ limit: api.key('a1'), retryAfter: '300ms' }));

        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, call, { account: 'a1', n: 1 });
        await waitFor(() => Boolean(rateLimitedEvent(events)));

        const limitedAt = Date.now();
        const event = /** @type {{ retryAt: Date }} */ (rateLimitedEvent(events));

        expect(event).toMatchObject({
            lane: 'call',
            attempt: 1,
            limit: 'api',
            key: 'a1',
            scope: 'global',
            durationMs: expect.any(Number),
            error: expect.any(RateLimitedError),
        });
        expect(event.retryAt.getTime() - limitedAt).toBeGreaterThan(250);
        expect(event.retryAt.getTime() - limitedAt).toBeLessThanOrEqual(310);
        await expect(readJobs(p)).resolves.toMatchObject([{ status: 'blocked', attempts: 0 }]);
        await sqlane.enqueue(testAdapter.pool, call, { account: 'a1', n: 2 });
        await sqlane.enqueue(testAdapter.pool, call, { account: 'a2', n: 3 });
        await waitFor(async () => (await statusCounts(p)).completed === 3, 3000);

        const late = starts.slice(1).filter(start => start.payload.account === 'a1');

        // The job again first, then the other one of the key
        expect(late.map(start => start.payload.n)).toStrictEqual([1, 2]);

        for (const start of late) {
            expect(start.at - limitedAt).toBeGreaterThanOrEqual(250);
        }

        expect(/** @type {{ at: number }} */ (starts.find(start => start.payload.account === 'a2')).at - limitedAt)
            .toBeLessThan(250);
        await expect(readJobs(p)).resolves.toMatchObject([
            { status: 'completed', attempts: 1 },
            { status: 'completed', attempts: 1 },
            { status: 'completed', attempts: 1 },
        ]);
        expect(events.map(each => each.type)).not.toContain('retried');
    });

    test('without a limit: all the global keys of the job wait; it is blocked on the first', async () => {
        const { sqlane, p, events } = await freshSqlane();
        const starts = throwFirst(sqlane, [call], () => new RateLimitedError({ retryAfter: '200ms' }));

        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, call, { account: 'a1', n: 1 }, {
            globalRateLimits: [api.key('a1'), api.key('a0')],
        });
        await waitFor(() => Boolean(rateLimitedEvent(events)));

        const limitedAt = Date.now();

        expect(rateLimitedEvent(events)).toMatchObject({ limit: 'api', key: 'a0', scope: 'global' });
        await expect(readJobs(p)).resolves.toMatchObject([{ status: 'blocked', attempts: 0 }]);
        await waitFor(async () => (await statusCounts(p)).completed === 1);
        expect(/** @type {{ at: number }} */ (starts[1]).at - limitedAt).toBeGreaterThanOrEqual(150);
    });

    test('on a local limit: paused in this process; the job is pending at once, without an attempt', async () => {
        const { sqlane, p, events } = await freshSqlane();
        const disk = defineRateLimit({ name: 'disk', max: 100, per: '1s', burst: 100 });
        const starts = throwFirst(
            sqlane,
            ['scan', 'index'].map(name => defineLane({ name, localRateLimits: [disk] })),
            () => new RateLimitedError({ limit: disk, retryAfter: '300ms' }),
        );

        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'scan', {});
        await waitFor(() => Boolean(rateLimitedEvent(events)));

        const limitedAt = Date.now();

        expect(rateLimitedEvent(events)).toMatchObject({ lane: 'scan', attempt: 1, limit: 'disk', key: null, scope: 'local' });
        await expect(readJobs(p)).resolves.toMatchObject([{ status: 'pending', attempts: 0 }]);
        // Another name of the limit waits too
        await sqlane.enqueue(testAdapter.pool, 'index', {});
        await waitFor(async () => (await statusCounts(p)).completed === 2, 3000);

        for (const start of starts.slice(1)) {
            expect(start.at - limitedAt).toBeGreaterThanOrEqual(250);
        }

        await expect(readJobs(p)).resolves.toMatchObject([
            { status: 'completed', attempts: 1 },
            { status: 'completed', attempts: 1 },
        ]);
    });

    test('on a limit that is not the job\'s, or a job without rate limits: retried after retryAfter, with an attempt',
        async () => {
            const { sqlane, p, events } = await freshSqlane();
            const elsewhere = defineRateLimit({ name: 'elsewhere', max: 1, per: '1s' });

            throwFirst(sqlane, [call], () => new RateLimitedError({ limit: elsewhere, retryAfter: '100ms' }));
            sqlane.lanes.add('plain', failingFirst(1, () => new RateLimitedError({ retryAfter: '50ms' })).handler);
            await sqlane.start();
            await sqlane.enqueue(testAdapter.pool, call, { account: 'a1', n: 1 });
            await sqlane.enqueue(testAdapter.pool, 'plain', {});
            await waitFor(async () => (await statusCounts(p)).completed === 2, 3000);

            await expect(readJobs(p)).resolves.toMatchObject([
                { lane: 'call', status: 'completed', attempts: 2 },
                { lane: 'plain', status: 'completed', attempts: 2 },
            ]);
            // The two jobs run at once: their events come in either order
            const retried = events.filter(event => event.type === 'retried')
                .toSorted((a, b) => a.lane.localeCompare(b.lane));

            expect(retried).toMatchObject([
                { lane: 'call', delayMs: 100 },
                { lane: 'plain', delayMs: 50 },
            ]);
            expect(rateLimitedEvent(events)).toBeUndefined();
        });
});

/**
 * The adapter of the tests, whose claim statements fail with a deadlock while `failures.left` is above 0.
 * @param {{ left: number }} failures
 * @returns {import('../../src/types.js').Adapter<any>}
 */
function failingClaims(failures) {
    const { adapter } = testAdapter;
    /**
     * @param {import('../../src/types.js').Executor} executor
     * @returns {import('../../src/types.js').Executor}
     */
    const wrap = executor => ({
        ...executor,
        query: async (sql, params) => {
            if (failures.left > 0 && sql.includes('SKIP LOCKED') && sql.includes('\'pending\'')) {
                failures.left--;

                throw Object.assign(new Error('Deadlock found when trying to get lock'), {
                    code: 'ER_LOCK_DEADLOCK',
                    errno: 1213,
                });
            }

            return executor.query(sql, params);
        },
    });

    return {
        ...adapter,
        queue: wrap(adapter.queue),
        queueTransaction: func => adapter.queueTransaction(executor => func(wrap(executor))),
    };
}

describe('a transient error of a claim', () => {
    test('retried at once: no error event, no back-off', async () => {
        const failures = { left: 2 };
        /** @type {string[]} The retries at once (their debug logs) and the errors (their error logs), in order */
        const logged = [];
        const logger = {
            debug: () => logged.push('retry'),
            info: () => {},
            warn: () => {},
            error: () => logged.push('error'),
        };
        const { sqlane, events } = await freshSqlane({ adapter: failingClaims(failures), logger });

        sqlane.lanes.add('a', () => {});
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'a', {});
        await waitFor(() => events.some(event => event.type === 'completed'));

        expect(failures.left).toBe(0);
        // A back-off comes only after an error: none here
        expect(logged).toStrictEqual(['retry', 'retry']);
        expect(events.filter(event => event.type === 'error')).toStrictEqual([]);
    });

    test('still failing after 3 retries: an error event, the back-off, then the job runs', async () => {
        const failures = { left: 4 };
        const { sqlane, events } = await freshSqlane({ adapter: failingClaims(failures) });

        sqlane.lanes.add('a', () => {});
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'a', {});
        await waitFor(() => events.some(event => event.type === 'completed'));

        expect(failures.left).toBe(0);
        expect(events.filter(event => event.type === 'error')).toMatchObject([
            { operation: 'dispatch', error: { errno: 1213 } },
        ]);
    });
});

test('a timeout: the signal aborts; the job keeps running until the handler settles, then it is retried', async () => {
    const { sqlane, p, events } = await freshSqlane();
    const slow = slowFirst(300);

    sqlane.lanes.add(defineLane({ name: 'slow', backoff: fixedBackoff, timeout: '50ms' }), slow.handler);
    await sqlane.start();
    await sqlane.enqueue(testAdapter.pool, 'slow', {});
    await waitFor(() => events.some(event => event.type === 'timed_out'));

    await expect(readJobs(p)).resolves.toMatchObject([{ status: 'running' }]);
    await waitFor(async () => (await readJobs(p))[0]?.status === 'completed');
    expect(slow.reasons[0]).toBeInstanceOf(JobTimeoutError);
    await expect(readJobs(p)).resolves.toMatchObject([{ attempts: 2 }]);
});

describe('close()', () => {
    test('release: a handler that does not finish by the deadline is released, without an attempt', async () => {
        const { sqlane, p, events } = await freshSqlane();
        /** @type {unknown[]} */
        const reasons = [];

        sqlane.lanes.add('long', async ({ signal }) => {
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

        sqlane.lanes.add('long', () => sleep(1000));
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'long', {});
        await waitFor(async () => (await readJobs(p))[0]?.status === 'running');
        await sqlane.close({ deadline: '50ms', mode: 'abandon' });

        await expect(readJobs(p)).resolves.toMatchObject([{ status: 'running', attempts: 0 }]);
    });

    test('waits for the running handlers until the deadline', async () => {
        const { sqlane, p } = await freshSqlane();

        sqlane.lanes.add('short', () => sleep(100));
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'short', {});
        await waitFor(async () => (await readJobs(p))[0]?.status === 'running');
        await sqlane.close({ deadline: '5s' });

        await expect(readJobs(p)).resolves.toMatchObject([{ status: 'completed' }]);
    });
});

describe('drain()', () => {
    test('runs the due jobs of the added lanes until none is left', async () => {
        const { sqlane, p } = await freshSqlane();
        let calls = 0;

        sqlane.lanes.add('ping', () => {
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
        const failed = defineLane({ name: 'build_failed' });
        const { sqlane } = await freshSqlane({ lanes: [failed] });
        let failureRuns = 0;

        sqlane.lanes.add(defineLane({ name: 'build', failureLane: 'build_failed' }), () => {
            throw new Error('broken');
        });
        sqlane.lanes.add(failed, () => {
            failureRuns++;
        });
        await sqlane.enqueue(testAdapter.pool, 'build', {});

        await expect(sqlane.drain({ includeDelayed: true }))
            .resolves.toStrictEqual({ completed: 1, retried: 2, failed: 1 });
        expect(failureRuns).toBe(1);
    });

    test('rejects with DrainTimeoutError when it does not finish in time', async () => {
        const { sqlane } = await freshSqlane();

        sqlane.lanes.add('long', () => sleep(500));
        await sqlane.enqueue(testAdapter.pool, 'long', {});

        await expect(sqlane.drain({ timeout: '100ms' })).rejects.toThrow(DrainTimeoutError);
    });
});
