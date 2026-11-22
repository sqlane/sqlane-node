// The due time and the start time of a run, in JobInfo and in the claimed event: through the public API, on each claim
// path and each database. `startedAt` is the database time of the claim, as JobRecord.startedAt shows it.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
    createSqlane,
    defineConcurrencyLimit,
    defineJob,
    defineRateLimit,
    FatalJobError,
    RateLimitedError,
} from '../../src/index.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @typedef {import('../../src/types.js').Sqlane<any>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */
/** @typedef {import('../../src/types.js').JobInfo} JobInfo */

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
 * A migrated instance on tables of its own.
 * @param {Partial<import('../../src/types.js').SqlaneOptions<any>>} [options]
 * @returns {Promise<{ sqlane: Sqlane, events: SqlaneEvent[], p: string }>}
 */
async function fresh(options = {}) {
    const p = nextPrefix();
    const { sqlane, events } = sqlaneOn(p, options);

    await sqlane.schema.migrate();

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
 * @param {string} column
 * @returns {string} The epoch ms of a time column, in SQL.
 */
function epochMs(column) {
    return database.family === 'postgres'
        ? `(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`
        : `TIMESTAMPDIFF(MICROSECOND, '1970-01-01', ${column}) DIV 1000`;
}

/**
 * @returns {string} The database time, in SQL.
 */
function nowSql() {
    return database.family === 'postgres' ? 'clock_timestamp()' : 'UTC_TIMESTAMP(3)';
}

/**
 * @param {unknown} error
 * @returns {(info: JobInfo, run: number) => void} A body that throws the error at the first run.
 */
function throwFirst(error) {
    return (_, run) => {
        if (run === 1) {
            throw error;
        }
    };
}

/**
 * @returns {{ body: (info: JobInfo, run: number) => unknown, release: () => void }} A body that holds its first run
 *     until the release.
 */
function holdFirst() {
    const { promise, resolve } = Promise.withResolvers();

    return { body: (_, run) => (run === 1 ? promise : undefined), release: () => resolve(undefined) };
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
 * @param {SqlaneEvent[]} events
 * @param {string} jobId
 * @returns {any[]} The claimed events of the job, in order.
 */
function claimedOf(events, jobId) {
    return events.filter(event => event.type === 'claimed' && event.jobId === jobId);
}

/**
 * A handler that records the JobInfo of each run, and the JobRecord read while it runs.
 * @param {Sqlane} sqlane
 * @param {(info: JobInfo, run: number) => unknown} [body] After the reads.
 * @returns {{ handler: import('../../src/types.js').Handler, runs: { info: JobInfo, record: any }[] }}
 */
function recording(sqlane, body = () => {}) {
    /** @type {{ info: JobInfo, record: any }[]} */
    const runs = [];

    return {
        runs,
        handler: async ({ job }) => {
            const record = await sqlane.jobs.get(job.id);

            runs.push({ info: job, record });

            return body(job, runs.length);
        },
    };
}

/**
 * The event of a run and its JobInfo agree, and its start time is the job's startedAt.
 * @param {any} event
 * @param {{ info: JobInfo, record: any }} run
 */
function expectOneTime(event, run) {
    expect(event.runAt).toBeInstanceOf(Date);
    expect(event.startedAt).toBeInstanceOf(Date);
    expect(event.enqueuedAt).toBeInstanceOf(Date);
    expect(run.info.runAt).toStrictEqual(event.runAt);
    expect(run.info.startedAt).toStrictEqual(event.startedAt);
    expect(run.info.enqueuedAt).toStrictEqual(event.enqueuedAt);
    expect(run.record.startedAt).toStrictEqual(event.startedAt);
    expect(run.record.runAt).toStrictEqual(event.runAt);
    expect(Number(event.runAt)).toBeLessThanOrEqual(Number(event.startedAt));
}

describe('the first run, on each claim path', () => {
    test('names without limits: one name, and two names', async () => {
        const { sqlane, events } = await fresh();
        const a = recording(sqlane);
        const b = recording(sqlane);

        sqlane.handle('only_a', a.handler);
        sqlane.handle('only_b', b.handler);

        const first = await sqlane.enqueue(testAdapter.pool, 'only_a', {});
        const second = await sqlane.enqueue(testAdapter.pool, 'only_b', {});

        // Both due before the start: one claim of two names
        await sqlane.start();
        await waitFor(() => a.runs.length + b.runs.length === 2);
        expect(claimedOf(events, first.id)).toHaveLength(1);
        expectOneTime(claimedOf(events, first.id)[0], a.runs[0]);
        expectOneTime(claimedOf(events, second.id)[0], b.runs[0]);

        // One name due: the claim of one name
        const third = await sqlane.enqueue(testAdapter.pool, 'only_a', {});

        await waitFor(() => a.runs.length === 2);
        expectOneTime(claimedOf(events, third.id)[0], a.runs[1]);
    });

    test('a name with a global concurrency limit: the job takes a slot', async () => {
        const { sqlane, events } = await fresh();
        const order = defineConcurrencyLimit({ name: 'order', max: 2 });
        const sync = defineJob({ name: 'sync', timeout: '10s', globalConcurrencyLimits: () => [order.key(1)] });
        const run = recording(sqlane);

        sqlane.handle(sync, run.handler);
        await sqlane.start();

        const { id } = await sqlane.enqueue(testAdapter.pool, sync, {});

        await waitFor(() => run.runs.length === 1);
        expect(claimedOf(events, id)).toHaveLength(1);
        expectOneTime(claimedOf(events, id)[0], run.runs[0]);
    });

    test('a name with a global rate limit: the job takes its quota', async () => {
        const { sqlane, events } = await fresh();
        const api = defineRateLimit({ name: 'api', max: 10, per: '1s' });
        const call = defineJob({ name: 'call', globalRateLimits: () => [api.key('t1')] });
        const run = recording(sqlane);

        sqlane.handle(call, run.handler);
        await sqlane.start();

        const { id } = await sqlane.enqueue(testAdapter.pool, call, {});

        await waitFor(() => run.runs.length === 1);
        expect(claimedOf(events, id)).toHaveLength(1);
        expectOneTime(claimedOf(events, id)[0], run.runs[0]);
    });
});

test('runAt given with the runAt option is the due time of the run', async () => {
    const { sqlane, events } = await fresh();
    const run = recording(sqlane);
    const runAt = new Date(Date.now() + 300);

    sqlane.handle('later', run.handler);
    await sqlane.start();

    const { id } = await sqlane.enqueue(testAdapter.pool, 'later', {}, { runAt });

    await waitFor(() => run.runs.length === 1);
    expect(claimedOf(events, id)[0].runAt).toStrictEqual(runAt);
    expectOneTime(claimedOf(events, id)[0], run.runs[0]);
});

test('after a retry: the due time of the backoff', async () => {
    const { sqlane, events } = await fresh();
    const flaky = defineJob({ name: 'flaky', backoff: { type: 'fixed', delay: 200, jitter: 0 } });
    const run = recording(sqlane, throwFirst(new Error('boom')));

    sqlane.handle(flaky, run.handler);
    await sqlane.start();

    const { id } = await sqlane.enqueue(testAdapter.pool, flaky, {});

    await waitFor(() => run.runs.length === 2);

    const [first, second] = claimedOf(events, id);

    expectOneTime(second, run.runs[1]);
    // The retry's due time: its database time, after the first start, plus the delay
    expect(Number(second.runAt) - Number(first.startedAt)).toBeGreaterThanOrEqual(200);
    expect(second.enqueuedAt).toStrictEqual(first.enqueuedAt);
});

test('after a release on close: the due time of the release', async () => {
    const p = nextPrefix();
    const { sqlane: first, events: firstEvents } = sqlaneOn(p);

    await first.schema.migrate();
    first.handle('long', ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', resolve);
    }));
    await first.start();

    const { id } = await first.enqueue(testAdapter.pool, 'long', {});

    await waitFor(() => claimedOf(firstEvents, id).length === 1);
    await first.close({ deadline: '50ms', exitsBy: '100ms' });

    const released = await first.jobs.get(id);
    const [claimed] = claimedOf(firstEvents, id);

    // exitsBy + 2 s after the close, by the database clock
    expect(Number(released?.runAt) - Number(claimed.startedAt)).toBeGreaterThanOrEqual(2000);

    // Due at once, so that the next run comes now; the run's due time is the stored one
    await raw(`UPDATE ${p}jobs SET run_at = ${nowSql()} WHERE id = ?`, [id]);

    const due = await first.jobs.get(id);
    const { sqlane: second, events } = sqlaneOn(p);
    const run = recording(second);

    second.handle('long', run.handler);
    await second.start();
    await waitFor(() => run.runs.length === 1);
    expect(claimedOf(events, id)[0].runAt).toStrictEqual(due?.runAt);
    expectOneTime(claimedOf(events, id)[0], run.runs[0]);
});

test('after a stall: the due time that stall recovery stored', async () => {
    const p = nextPrefix();
    const timings = { ...TIMINGS, leaseMs: 1000, renewIntervalMs: 200 };
    const { sqlane: first, events: firstEvents } = sqlaneOn(p, /** @type {any} */ ({ timings }));

    await first.schema.migrate();
    first.handle('stuck', () => sleep(60_000));
    await first.start();

    const { id } = await first.enqueue(testAdapter.pool, 'stuck', {});

    await waitFor(() => claimedOf(firstEvents, id).length === 1);
    // Its lease is not renewed any more: it ends, and another process recovers the job
    await first.close({ deadline: 0, mode: 'abandon' });

    const { sqlane: recovery } = sqlaneOn(p, /** @type {any} */ ({ timings: { ...timings, recoveryIntervalMs: 100 } }));

    await recovery.start();
    await waitFor(async () => (await recovery.jobs.get(id))?.stalls === 1, 8000);

    const stalled = await recovery.jobs.get(id);

    // Due 30 s after the stall
    expect(Number(stalled?.runAt) - Number(claimedOf(firstEvents, id)[0].startedAt)).toBeGreaterThanOrEqual(25_000);
    await raw(`UPDATE ${p}jobs SET run_at = ${nowSql()} WHERE id = ?`, [id]);

    const due = await recovery.jobs.get(id);
    const { sqlane: second, events } = sqlaneOn(p);
    const run = recording(second);

    second.handle('stuck', run.handler);
    await second.start();
    await waitFor(() => run.runs.length === 1);
    expect(claimedOf(events, id)[0].runAt).toStrictEqual(due?.runAt);
    expectOneTime(claimedOf(events, id)[0], run.runs[0]);
});

test('after jobs.retry(): the due time of the retry', async () => {
    const p = nextPrefix();
    const { sqlane: first } = sqlaneOn(p);

    await first.schema.migrate();
    first.handle('broken', () => {
        throw new FatalJobError('boom');
    });

    const { id } = await first.enqueue(testAdapter.pool, 'broken', {});

    await first.drain();

    const failed = await first.jobs.get(id);

    await first.jobs.retry({ jobIds: [id] });

    const retried = await first.jobs.get(id);

    expect(Number(retried?.runAt)).toBeGreaterThanOrEqual(Number(failed?.finishedAt));

    const { sqlane: second, events } = sqlaneOn(p);
    const run = recording(second);

    second.handle('broken', run.handler);
    await second.start();
    await waitFor(() => run.runs.length === 1);
    expect(claimedOf(events, id)[0].runAt).toStrictEqual(retried?.runAt);
    expectOneTime(claimedOf(events, id)[0], run.runs[0]);
});

test('after an unblock: the job keeps its due time; its start delay includes its wait on the key', async () => {
    const { sqlane, events } = await fresh();
    const order = defineConcurrencyLimit({ name: 'order', max: 1 });
    const sync = defineJob({ name: 'sync', timeout: '10s', globalConcurrencyLimits: () => [order.key(1)] });
    const { body, release } = holdFirst();
    const run = recording(sqlane, body);

    sqlane.handle(sync, run.handler);
    await sqlane.start();

    const holder = await sqlane.enqueue(testAdapter.pool, sync, {});

    await waitFor(() => run.runs.length === 1);

    const { id } = await sqlane.enqueue(testAdapter.pool, sync, {});

    await waitFor(async () => (await sqlane.jobs.get(id))?.status === 'blocked');

    const blocked = await sqlane.jobs.get(id);

    await sleep(300);
    release();
    await waitFor(() => run.runs.length === 2);

    const [claimed] = claimedOf(events, id);

    expect(claimedOf(events, holder.id)).toHaveLength(1);
    expect(claimed.runAt).toStrictEqual(blocked?.runAt);
    expect(Number(claimed.startedAt) - Number(claimed.runAt)).toBeGreaterThanOrEqual(300);
    expectOneTime(claimed, run.runs[1]);
});

test('after a RateLimitedError on a global rate key: the rerun keeps the due time of the rate-limited run', async () => {
    const { sqlane, events } = await fresh();
    const api = defineRateLimit({ name: 'api', max: 100, per: '1s' });
    const call = defineJob({ name: 'call', globalRateLimits: () => [api.key('t1')] });
    const run = recording(sqlane, throwFirst(new RateLimitedError({ limit: api.key('t1'), retryAfter: '300ms' })));

    sqlane.handle(call, run.handler);
    await sqlane.start();

    const { id } = await sqlane.enqueue(testAdapter.pool, call, {});

    await waitFor(() => run.runs.length === 2);

    const [first, second] = claimedOf(events, id);

    expect(second.runAt).toStrictEqual(first.runAt);
    expect(Number(second.startedAt) - Number(second.runAt)).toBeGreaterThanOrEqual(300);
    expectOneTime(second, run.runs[1]);
});

test('drain({ includeDelayed }): the delayed job is due at the drain', async () => {
    const { sqlane, events } = await fresh();
    const run = recording(sqlane);

    sqlane.handle('delayed', run.handler);

    const { id } = await sqlane.enqueue(testAdapter.pool, 'delayed', {}, { delay: '1h' });

    await sqlane.drain({ includeDelayed: true });

    const [claimed] = claimedOf(events, id);

    expect(Number(claimed.runAt) - Number(claimed.enqueuedAt)).toBeLessThan(60_000);
    expectOneTime(claimed, run.runs[0]);
});

test('the slot of a run is taken at its start time', async () => {
    const { sqlane, p } = await fresh();
    const order = defineConcurrencyLimit({ name: 'order', max: 3 });
    const sync = defineJob({ name: 'sync', timeout: '10s', globalConcurrencyLimits: ({ payload }) => [order.key(payload.n), order] });
    /** @type {unknown[]} */
    const pairs = [];
    const run = recording(sqlane, async (info) => {
        const rows = await raw(`SELECT ${epochMs('s.created_at')} AS slot_ms, ${epochMs('j.started_at')} AS started_ms
            FROM ${p}concurrency_slots s JOIN ${p}jobs j ON j.id = s.job_id WHERE s.job_id = ?`, [info.id]);

        pairs.push(...rows.map(row => [Number(row.slot_ms), Number(row.started_ms), Number(info.startedAt)]));
    });

    sqlane.handle(sync, run.handler);
    await sqlane.start();
    await sqlane.enqueueMany(testAdapter.pool, sync, [{ payload: { n: 1 } }, { payload: { n: 2 } }]);
    // Two keys per job, two jobs: the reads of both handlers are done
    await waitFor(() => pairs.length === 4);
    expect(run.runs).toHaveLength(2);

    for (const [slotMs, startedMs, infoMs] of /** @type {number[][]} */ (pairs)) {
        expect(slotMs).toBe(startedMs);
        expect(infoMs).toBe(startedMs);
    }
});
