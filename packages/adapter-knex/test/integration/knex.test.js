import { setTimeout as sleep } from 'node:timers/promises';
import knexLib from 'knex';
import { afterAll, afterEach, beforeAll, expect, inject, test } from 'vitest';
import { createSqlane, defineJob } from '@sqlane/core';
import { connectTestDatabase } from '@sqlane/testing/database';
import { knexAdapter } from '../../src/index.js';

/** @typedef {import('@sqlane/core').Sqlane<import('../../src/index.js').KnexConnection, never>} Sqlane */
/** @typedef {import('@sqlane/core').SqlaneEvent} SqlaneEvent */

/** @type {import('@sqlane/testing/database').TestDatabaseConnection} */
let database;
/** @type {import('knex').Knex} The app's knex */
let knex;
/** @type {import('knex').Knex} The queue's own knex */
let queueKnex;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];

/** @returns {import('knex').Knex} */
function createKnex() {
    return knexLib({
        client: inject('databaseDialect') === 'mysql' ? 'mysql2' : 'pg',
        connection: inject('databaseUrl'),
        pool: { min: 0, max: 4 },
    });
}

beforeAll(async () => {
    database = await connectTestDatabase();
    knex = createKnex();
    queueKnex = createKnex();
});

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await knex?.destroy();
    await queueKnex?.destroy();
    await database?.close();
});

/**
 * A sqlane instance over knex, on tables of its own, migrated.
 * @param {Partial<import('@sqlane/core').SqlaneOptions<any, never>>} [options]
 * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
 */
async function freshSqlane(options = {}) {
    prefixCount++;

    const p = `${database.tablePrefix}${prefixCount}_`;
    /** @type {SqlaneEvent[]} */
    const events = [];
    const sqlane = createSqlane({
        adapter: knexAdapter(queueKnex),
        tablePrefix: p,
        onEvent: event => events.push(event),
        ...options,
    });

    instances.push(sqlane);
    await sqlane.migrate();

    return { sqlane, p, events };
}

/**
 * @param {string} p
 * @returns {Promise<string[]>} The statuses, in the order of the ids.
 */
async function statuses(p) {
    return (await database.query(`SELECT status FROM ${p}jobs ORDER BY id`)).map(row => String(row.status));
}

/**
 * Waits until the condition holds.
 * @param {() => boolean | Promise<boolean>} condition
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

test('enqueue in a knex transaction: the job commits with it, and rolls back with it', async () => {
    const { sqlane, p } = await freshSqlane();

    await knex.transaction(async (trx) => {
        await expect(sqlane.enqueue(trx, 'ping', { n: 1 }, { jobId: 'a' })).resolves.toStrictEqual({
            id: 'ping:a',
            created: true,
        });
        // Not visible outside the transaction
        await expect(statuses(p)).resolves.toStrictEqual([]);
    });
    await expect(knex.transaction(async (trx) => {
        await sqlane.enqueue(trx, 'ping', { n: 2 }, { jobId: 'b' });
        throw new Error('rollback');
    })).rejects.toThrow('rollback');

    await expect(statuses(p)).resolves.toStrictEqual(['pending']);
    // The dedupe sees the committed job
    await expect(sqlane.enqueue(knex, 'ping', { n: 3 }, { jobId: 'a' })).resolves.toMatchObject({ created: false });
});

test('enqueue on a knex instance: a transaction of its own', async () => {
    const { sqlane, p } = await freshSqlane();

    await sqlane.enqueueMany(knex, 'ping', [{ payload: { n: 1 } }, { payload: { n: 2 } }]);
    await expect(statuses(p)).resolves.toStrictEqual(['pending', 'pending']);
});

test('the commit wakes the worker at once: the job does not wait for a re-probe', async () => {
    const { sqlane, events } = await freshSqlane({ pollInterval: '10s' });

    sqlane.handle('ping', () => {});
    await sqlane.start();
    await sleep(100);

    let committedAt = 0;

    await knex.transaction(async (trx) => {
        await sqlane.enqueue(trx, 'ping', {});
        // The re-probes after the enqueue: 20, 50, 100, 200, then 500 ms
        await sleep(300);
    });
    committedAt = Date.now();
    await waitFor(() => events.some(event => event.type === 'claimed'));
    expect(Date.now() - committedAt).toBeLessThan(150);
});

test('a nested transaction: the job runs after the outer commit, and never after an outer rollback', async () => {
    const { sqlane, p, events } = await freshSqlane({ pollInterval: '10s' });

    sqlane.handle('ping', () => {});
    await sqlane.start();
    await expect(knex.transaction(async (outer) => {
        await outer.transaction(async (inner) => {
            await sqlane.enqueue(inner, 'ping', {}, { jobId: 'rolled_back' });
        });
        throw new Error('outer rollback');
    })).rejects.toThrow('outer rollback');
    await knex.transaction(async (outer) => {
        await outer.transaction(async (inner) => {
            await sqlane.enqueue(inner, 'ping', {}, { jobId: 'committed' });
        });
    });

    await waitFor(() => events.some(event => event.type === 'completed'));
    await expect(statuses(p)).resolves.toStrictEqual(['completed']);
});

test('drain: retries, mutex keys and a failure job, over knex', async () => {
    const report = defineJob({ name: 'report', mutexKeys: payload => [`r:${payload.id}`], timeout: '5s' });
    const reportFailed = defineJob({ name: 'report_failed' });
    const failing = defineJob({
        name: 'failing',
        maxAttempts: 2,
        backoff: { type: 'fixed', delay: 10, jitter: 0 },
        failureJob: reportFailed,
    });
    const { sqlane, p } = await freshSqlane({ jobs: [report, reportFailed, failing] });
    /** @type {unknown[]} */
    const failures = [];

    sqlane.handle(report, () => {});
    sqlane.handle(failing, () => {
        throw new Error('always');
    });
    sqlane.handle(reportFailed, ({ payload }) => {
        failures.push(payload.job.name);
    });
    await sqlane.enqueueMany(knex, report, [{ payload: { id: 1 } }, { payload: { id: 1 } }]);
    await sqlane.enqueue(knex, failing, {});

    await expect(sqlane.drain({ includeDelayed: true }))
        .resolves.toStrictEqual({ completed: 3, retried: 1, failed: 1 });
    expect(failures).toStrictEqual(['failing']);
    // The names with pending, running or failed jobs
    await expect(sqlane.getStats()).resolves.toMatchObject([{ name: 'failing', pending: 0, failed: 1 }]);
    expect((await statuses(p)).toSorted()).toStrictEqual(['completed', 'completed', 'completed', 'failed']);
});
