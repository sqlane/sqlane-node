// The runner of a process and its mounts, on each database: mounts after start(), unmounts with jobs in flight, local
// pauses, schedules without their handler.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { createSqlane, defineHandler, defineLane, defineSchedule, FatalJobError } from '../../src/index.js';
import { createRunner } from '../../src/create_runner.js';
import { connectTestDatabase } from '../support/test_database.js';
import { createTestAdapter } from './helpers/test_adapter.js';

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
let prefixCount = 0;
/** @type {import('../../src/types.js').Sqlane<any>[]} */
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
 * A sqlane on tables of its own, migrated, and its runner.
 * @returns {Promise<{ sqlane: import('../../src/types.js').Sqlane<any>, runner: import('../../src/sqlane.js').Runner,
 *     p: string, events: import('../../src/types.js').SqlaneEvent[] }>}
 */
async function freshRunner() {
    prefixCount++;

    const p = `${database.tablePrefix}m${prefixCount}_`;
    /** @type {import('../../src/types.js').SqlaneEvent[]} */
    const events = [];
    const sqlane = createSqlane({
        adapter: testAdapter.adapter,
        tablePrefix: p,
        pollInterval: '60s',
        onEvent: event => events.push(event),
    });

    instances.push(sqlane);
    await sqlane.schema.migrate();

    return { sqlane, runner: createRunner(sqlane), p, events };
}

/**
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

/** Moves the cursors of the schedules 2 hours back */
const BACK_2_HOURS = {
    postgres: (/** @type {string} */ p) => `UPDATE ${p}schedules SET last_slot_at = last_slot_at - interval '2 hours'`,
    mysql: (/** @type {string} */ p) => `UPDATE ${p}schedules SET last_slot_at = last_slot_at - INTERVAL 2 HOUR`,
};

/**
 * @param {string} p
 * @returns {Promise<{ id: string, lane: string, status: string }[]>}
 */
async function readJobs(p) {
    return (await database.query(`SELECT id, lane, status FROM ${p}jobs ORDER BY created_at, id`))
        .map(row => ({ id: String(row.id), lane: String(row.lane), status: String(row.status) }));
}

test('a mount after start() claims the due jobs of its lane at once, before the next poll', async () => {
    const { sqlane, runner } = await freshRunner();
    const report = defineLane({ name: 'report' });
    /** @type {string[]} */
    const ran = [];

    await sqlane.enqueue(testAdapter.pool, report, {}, { dedupeKey: 'r1' });
    await runner.start();
    await sleep(100);
    runner.mount([defineHandler(report, ({ job }) => {
        ran.push(job.id);
    })]);
    await waitFor(() => ran.length === 1, 3000);
    expect(ran).toStrictEqual(['report:r1']);
});

test('a job that fails for good after the unmount of its handler: the failure lane of the old definition', async () => {
    const { sqlane, runner, p } = await freshRunner();
    const oldFailed = defineLane({ name: 'old_failed' });
    const newFailed = defineLane({ name: 'new_failed' });
    const oldReport = defineLane({ name: 'report', failureLane: oldFailed, maxAttempts: 1 });
    const newReport = defineLane({ name: 'report', failureLane: newFailed, maxAttempts: 1 });
    const held = Promise.withResolvers();
    let started = false;
    const mount = runner.mount([defineHandler(oldReport, async () => {
        started = true;
        await held.promise;
        throw new FatalJobError('no');
    })]);

    await runner.start();
    await sqlane.enqueue(testAdapter.pool, oldReport, {}, { dedupeKey: 'r1' });
    await waitFor(() => started);
    mount.unmount();
    runner.mount([defineHandler(newReport, () => {})]);
    expect(runner.getStatus(newReport)).toMatchObject({ mounted: true, running: 1 });
    held.resolve(undefined);
    await waitFor(async () => (await readJobs(p)).some(job => job.lane === 'old_failed'));
    expect((await readJobs(p)).map(job => job.lane)).not.toContain('new_failed');
});

test('a schedule mounted without the handler of its lane fires: its jobs wait for a process that handles the lane',
    async () => {
        const { runner, p } = await freshRunner();
        const tick = defineSchedule(defineLane({ name: 'tick' }), { key: 'a', every: '1s' });

        runner.mount([tick]);
        await runner.start();
        await waitFor(async () => (await readJobs(p)).length > 0, 5000);
        expect((await readJobs(p))[0]).toMatchObject({ lane: 'tick', status: 'pending' });
    }, 10_000);

test('a local pause: this process claims none of its jobs, until resumeLocally()', async () => {
    const { sqlane, runner, p } = await freshRunner();
    const report = defineLane({ name: 'report' });
    /** @type {string[]} */
    const ran = [];

    runner.pauseLocally(report);
    runner.mount([defineHandler(report, ({ job }) => {
        ran.push(job.id);
    })]);
    await runner.start();
    await sqlane.enqueue(testAdapter.pool, report, {}, { dedupeKey: 'r1' });
    await sleep(300);
    expect(ran).toStrictEqual([]);
    await expect(readJobs(p)).resolves.toMatchObject([{ status: 'pending' }]);
    runner.resumeLocally(report);
    await waitFor(() => ran.length === 1, 3000);
    await expect(runner.drain()).rejects.toThrow('drain() after start()');
});

test('drain(): runs the jobs of the mounted lanes that no pause holds', async () => {
    const { sqlane, runner } = await freshRunner();
    const report = defineLane({ name: 'report' });
    const other = defineLane({ name: 'other' });

    runner.mount([defineHandler(report, () => {}), defineHandler(other, () => {})]);
    runner.pauseLocally(other);
    await sqlane.enqueue(testAdapter.pool, report, {});
    await sqlane.enqueue(testAdapter.pool, other, {});
    await expect(runner.drain()).resolves.toStrictEqual({ completed: 1, retried: 0, failed: 0 });
    runner.resumeLocally(other);
    await expect(runner.drain()).resolves.toStrictEqual({ completed: 1, retried: 0, failed: 0 });
});

test('schedules.runSlot() without a runner, then the fire of the same slot: one job, which the cursor records',
    async () => {
        const { sqlane, runner, p, events } = await freshRunner();
        const hourly = defineSchedule(defineLane({ name: 'tick' }), { key: 'a', every: '1h', overlap: 'skip' });
        // A process that registered the schedule before: its cursor goes 2 hours back, the latest slot is due, late
        const before = createSqlane({ adapter: testAdapter.adapter, tablePrefix: p });
        const beforeRunner = createRunner(before);

        instances.push(before);
        beforeRunner.mount([hourly]);
        await beforeRunner.start();
        await before.close({ deadline: 0 });
        await database.query(BACK_2_HOURS[database.family](p));

        const slot = Math.floor(Date.now() / 3_600_000) * 3_600_000;
        const jobId = `tick:schedule:a:${new Date(slot).toISOString()}`;

        await expect(sqlane.schedules.runSlot(hourly)).resolves.toStrictEqual({ id: jobId, created: true });
        runner.mount([hourly]);
        await runner.start();
        await waitFor(() => events.some(event => event.type === 'schedule_fired'));
        expect(events.filter(event => event.type === 'schedule_fired')).toMatchObject([{ jobId, late: true }]);
        // overlap: 'skip' checks the job of the cursor: the job of runSlot()
        await expect(database.query(`SELECT last_job_id FROM ${p}schedules`)).resolves.toStrictEqual([
            { last_job_id: jobId },
        ]);
        await expect(sqlane.schedules.runSlot(hourly, { at: new Date(slot) })).resolves.toStrictEqual({
            id: jobId,
            created: false,
        });
        await expect(readJobs(p)).resolves.toStrictEqual([{ id: jobId, lane: 'tick', status: 'pending' }]);
    });

test('schedules.runSlot(), then drain(): the job of the slot runs, with the payload of the schedule', async () => {
    const { sqlane, runner } = await freshRunner();
    const report = defineLane({ name: 'report' });
    const daily = defineSchedule(report, { key: 'daily', cron: '0 6 * * *', payload: { kind: 'full' } });
    /** @type {unknown[]} */
    const payloads = [];

    runner.mount([defineHandler(report, ({ payload }) => {
        payloads.push(payload);
    })]);
    await sqlane.schedules.runSlot(daily, { connection: testAdapter.pool });
    await expect(runner.drain()).resolves.toStrictEqual({ completed: 1, retried: 0, failed: 0 });
    expect(payloads).toStrictEqual([{ kind: 'full' }]);
});
