import { setTimeout as sleep } from 'node:timers/promises';
import postgres4 from 'postgres';
import postgres3 from 'postgres-3';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import { connectTestDatabase } from '@sqlane/testing/database';
import { postgresJsAdapter } from '../../src/adapters/postgres_js.js';
import { createSqlane, defineJob } from '../../src/index.js';

/** @typedef {import('../../src/adapters/postgres_js.js').PostgresJsConnection} PostgresJsConnection */
/** @typedef {import('../../src/types.js').Sqlane<PostgresJsConnection, never>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */

/** @type {import('@sqlane/testing/database').TestDatabaseConnection} */
let database;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];
/** @type {any[]} */
const pools = [];

beforeAll(async () => {
    database = await connectTestDatabase();
});

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await Promise.all(pools.map(sql => sql.end({ timeout: 1 })));
    await database?.close();
});

/**
 * @param {string} p
 * @returns {Promise<string[]>} The statuses, in the order of the ids.
 */
async function statuses(p) {
    return (await database.query(`SELECT status FROM ${p}jobs ORDER BY id`)).map(row => String(row.status));
}

/**
 * Waits until the condition holds.
 * @param {() => boolean} condition
 * @returns {Promise<void>}
 */
async function waitFor(condition) {
    const deadline = Date.now() + 5000;

    // oxlint-disable-next-line no-await-in-loop -- polls
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor: timed out');
        }

        // oxlint-disable-next-line no-await-in-loop -- polls
        await sleep(10);
    }
}

describe.runIf(inject('databaseDialect') === 'postgres').each([
    { version: '4', postgres: postgres4 },
    { version: '3.4', postgres: postgres3 },
])('postgres.js $version', ({ postgres }) => {
    /**
     * @param {object} [options]
     * @returns {any} A pool of postgres.js on the test database.
     */
    function createSql(options = {}) {
        const sql = /** @type {any} */ (postgres)(inject('databaseUrl'), { max: 4, onnotice: () => {}, ...options });

        pools.push(sql);

        return sql;
    }

    /** @type {any} The app's postgres.js */
    let sql;
    /** @type {any} The queue's own postgres.js */
    let queueSql;

    beforeAll(() => {
        sql = createSql();
        queueSql = createSql();
    });

    /**
     * A sqlane instance over postgres.js, on tables of its own, migrated.
     * @param {Partial<import('../../src/types.js').SqlaneOptions<any, never>>} [options]
     * @param {string} [prefix] The tables of another instance.
     * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
     */
    async function freshSqlane(options = {}, prefix = undefined) {
        prefixCount++;

        const p = prefix ?? `${database.tablePrefix}${prefixCount}_`;
        /** @type {SqlaneEvent[]} */
        const events = [];
        const sqlane = createSqlane({
            adapter: postgresJsAdapter(queueSql),
            tablePrefix: p,
            onEvent: event => events.push(event),
            ...options,
        });

        instances.push(sqlane);
        await sqlane.migrate();

        return { sqlane, p, events };
    }

    test('enqueue in sql.begin(): the job commits with it, and rolls back with it', async () => {
        const { sqlane, p } = await freshSqlane();

        await sql.begin(async (/** @type {any} */ tx) => {
            await expect(sqlane.enqueue(tx, 'ping', { n: 1 }, { jobId: 'a' }))
                .resolves.toStrictEqual({ id: 'ping:a', created: true });
            await expect(statuses(p)).resolves.toStrictEqual([]);
        });
        await expect(sql.begin(async (/** @type {any} */ tx) => {
            await sqlane.enqueue(tx, 'ping', { n: 2 }, { jobId: 'b' });
            throw new Error('rollback');
        })).rejects.toThrow('rollback');

        await expect(statuses(p)).resolves.toStrictEqual(['pending']);
        await expect(sqlane.enqueue(sql, 'ping', { n: 3 }, { jobId: 'a' })).resolves.toMatchObject({ created: false });
    });

    test('a savepoint rolls back with the outer transaction; the pool: a transaction of its own', async () => {
        const { sqlane, p } = await freshSqlane();

        await expect(sql.begin(async (/** @type {any} */ tx) => {
            await tx.savepoint(async (/** @type {any} */ inner) => {
                await sqlane.enqueue(inner, 'ping', {}, { jobId: 'rolled_back' });
            });
            throw new Error('outer rollback');
        })).rejects.toThrow('outer rollback');
        await sqlane.enqueueMany(sql, 'ping', [{ payload: { n: 1 } }, { payload: { n: 2 } }]);

        await expect(statuses(p)).resolves.toStrictEqual(['pending', 'pending']);
    });

    test('drain: retries, mutex keys, a failure job and the stats', async () => {
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
        const payloads = [];

        sqlane.handle(report, ({ payload }) => {
            payloads.push(payload);
        });
        sqlane.handle(failing, () => {
            throw new Error('always');
        });
        sqlane.handle(reportFailed, ({ payload }) => {
            payloads.push(payload.job.name);
        });
        await sqlane.enqueueMany(sql, report, [{ payload: { id: 1 } }, { payload: { id: 1 } }]);
        await sqlane.enqueue(sql, failing, {});

        await expect(sqlane.drain({ includeDelayed: true }))
            .resolves.toStrictEqual({ completed: 3, retried: 1, failed: 1 });
        expect(payloads).toStrictEqual([{ id: 1 }, { id: 1 }, 'failing']);
        await expect(sqlane.getStats()).resolves.toMatchObject([{ name: 'failing', pending: 0, failed: 1 }]);
        expect((await statuses(p)).toSorted()).toStrictEqual(['completed', 'completed', 'completed', 'failed']);
    });

    test('notify: another process wakes at the commit of the transaction', async () => {
        const { sqlane: producer, p } = await freshSqlane({ adapter: postgresJsAdapter(queueSql, { notify: true }) });
        const { sqlane: worker, events } = await freshSqlane({
            adapter: postgresJsAdapter(queueSql, { notify: true }),
            pollInterval: '10s',
        }, p);

        worker.handle('ping', () => {});
        await worker.start();
        await sleep(200);
        await sql.begin(async (/** @type {any} */ tx) => {
            await producer.enqueue(tx, 'ping', {});
            // The re-probes of the producer are for its own process: they cannot wake the worker
            await sleep(300);
        });

        const committedAt = Date.now();

        await waitFor(() => events.some(event => event.type === 'claimed'));
        expect(Date.now() - committedAt).toBeLessThan(150);
    });

    test('a transform of results: an error for the queue\'s postgres.js, none for the app\'s', async () => {
        const camel = createSql({ transform: /** @type {any} */ (postgres).camel });

        expect(() => postgresJsAdapter(camel)).toThrow('must not transform results');

        const { sqlane, p } = await freshSqlane();

        await camel.begin(async (/** @type {any} */ tx) => {
            await expect(sqlane.enqueue(tx, 'ping', { someKey: 1 }, { jobId: 'a' }))
                .resolves.toStrictEqual({ id: 'ping:a', created: true });
        });
        await expect(statuses(p)).resolves.toStrictEqual(['pending']);
    });
});
