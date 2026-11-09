import { setTimeout as sleep } from 'node:timers/promises';
import * as typeorm1 from 'typeorm';
import * as typeorm03 from 'typeorm-0.3';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import { connectTestDatabase } from '../support/test_database.js';
import { typeOrmAdapter } from '../../src/adapters/typeorm.js';
import { createSqlane, defineJob } from '../../src/index.js';

/** @typedef {import('../../src/types.js').Sqlane<any, never>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];
/** @type {any[]} */
const dataSources = [];

beforeAll(async () => {
    database = await connectTestDatabase();
});

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await Promise.all(dataSources.map(dataSource => dataSource.destroy()));
    await database?.close();
});

/**
 * An initialized DataSource on the test database.
 * @param {any} module The module of TypeORM.
 * @returns {Promise<any>}
 */
async function createDataSource(module) {
    const isMysql = inject('databaseDialect') === 'mysql';
    const dataSource = new module.DataSource({
        type: isMysql ? 'mysql' : 'postgres',
        url: inject('databaseUrl'),
        ...isMysql ? { connectorPackage: 'mysql2', extra: { connectionLimit: 4 } } : { extra: { max: 4 } },
        logging: false,
    });

    await dataSource.initialize();
    dataSources.push(dataSource);

    return dataSource;
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

describe.each([
    { version: '1.x', module: typeorm1 },
    { version: '0.3', module: typeorm03 },
])('typeorm $version', ({ module }) => {
    /** @type {any} The app's DataSource */
    let dataSource;
    /** @type {any} The queue's own DataSource */
    let queueDataSource;

    beforeAll(async () => {
        dataSource = await createDataSource(module);
        queueDataSource = await createDataSource(module);
    });

    /**
     * A sqlane instance over TypeORM, on tables of its own, migrated.
     * @param {Partial<import('../../src/types.js').SqlaneOptions<any, never>>} [options]
     * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
     */
    async function freshSqlane(options = {}) {
        prefixCount++;

        const p = `${database.tablePrefix}${prefixCount}_`;
        /** @type {SqlaneEvent[]} */
        const events = [];
        const sqlane = createSqlane({
            adapter: typeOrmAdapter(queueDataSource),
            tablePrefix: p,
            onEvent: event => events.push(event),
            ...options,
        });

        instances.push(sqlane);
        await sqlane.migrate();

        return { sqlane, p, events };
    }

    test('enqueue with the EntityManager of a transaction: the job commits with it, and rolls back with it', async () => {
        const { sqlane, p } = await freshSqlane();

        await dataSource.transaction(async (/** @type {any} */ manager) => {
            await expect(sqlane.enqueue(manager, 'ping', { n: 1 }, { jobId: 'a' }))
                .resolves.toStrictEqual({ id: 'ping:a', created: true });
            await expect(statuses(p)).resolves.toStrictEqual([]);
        });
        await expect(dataSource.transaction(async (/** @type {any} */ manager) => {
            await sqlane.enqueue(manager, 'ping', { n: 2 }, { jobId: 'b' });
            throw new Error('rollback');
        })).rejects.toThrow('rollback');

        await expect(statuses(p)).resolves.toStrictEqual(['pending']);
        await expect(sqlane.enqueue(dataSource, 'ping', { n: 3 }, { jobId: 'a' }))
            .resolves.toMatchObject({ created: false });
    });

    test('a DataSource and its manager: a transaction of their own', async () => {
        const { sqlane, p } = await freshSqlane();

        await sqlane.enqueue(dataSource, 'ping', {});
        await sqlane.enqueueMany(dataSource.manager, 'ping', [{ payload: { n: 1 } }, { payload: { n: 2 } }]);
        await expect(statuses(p)).resolves.toStrictEqual(['pending', 'pending', 'pending']);
    });

    test('the commit wakes the worker at once: the job does not wait for a re-probe', async () => {
        const { sqlane, events } = await freshSqlane({ pollInterval: '10s' });

        sqlane.handle('ping', () => {});
        await sqlane.start();
        await sleep(100);
        await dataSource.transaction(async (/** @type {any} */ manager) => {
            await sqlane.enqueue(manager, 'ping', {});
            // The re-probes after the enqueue: 20, 50, 100, 200, then 500 ms
            await sleep(300);
        });

        const committedAt = Date.now();

        await waitFor(() => events.some(event => event.type === 'claimed'));
        expect(Date.now() - committedAt).toBeLessThan(150);
    });

    test('a QueryRunner, with a savepoint: the job runs after the outer commit, never after an outer rollback', async () => {
        const { sqlane, p, events } = await freshSqlane({ pollInterval: '10s' });
        const rolledBack = dataSource.createQueryRunner();
        const committed = dataSource.createQueryRunner();

        sqlane.handle('ping', () => {});
        await sqlane.start();

        try {
            await rolledBack.startTransaction();
            await rolledBack.startTransaction();
            await sqlane.enqueue(rolledBack, 'ping', {}, { jobId: 'rolled_back' });
            // The release of the savepoint: not the commit
            await rolledBack.commitTransaction();
            await rolledBack.rollbackTransaction();

            await committed.startTransaction();
            await committed.startTransaction();
            await sqlane.enqueue(committed, 'ping', {}, { jobId: 'committed' });
            await committed.commitTransaction();
            await committed.commitTransaction();
        } finally {
            await rolledBack.release();
            await committed.release();
        }

        await waitFor(() => events.some(event => event.type === 'completed'));
        await expect(statuses(p)).resolves.toStrictEqual(['completed']);
    });

    test('drain: retries, mutex keys and a failure job', async () => {
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
        await sqlane.enqueueMany(dataSource, report, [{ payload: { id: 1 } }, { payload: { id: 1 } }]);
        await sqlane.enqueue(dataSource, failing, {});

        await expect(sqlane.drain({ includeDelayed: true }))
            .resolves.toStrictEqual({ completed: 3, retried: 1, failed: 1 });
        expect(failures).toStrictEqual(['failing']);
        await expect(sqlane.getStats()).resolves.toMatchObject([{ name: 'failing', pending: 0, failed: 1 }]);
        expect((await statuses(p)).toSorted()).toStrictEqual(['completed', 'completed', 'completed', 'failed']);
    });
});
