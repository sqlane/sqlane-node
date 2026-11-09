import { setTimeout as sleep } from 'node:timers/promises';
import { Sequelize } from 'sequelize';
import { afterAll, afterEach, beforeAll, expect, inject, test } from 'vitest';
import { connectTestDatabase } from '../support/test_database.js';
import { sequelizeAdapter } from '../../src/adapters/sequelize.js';
import { createSqlane, defineJob } from '../../src/index.js';

/** @typedef {import('../../src/adapters/sequelize.js').SequelizeConnection} SequelizeConnection */
/** @typedef {import('../../src/types.js').Sqlane<SequelizeConnection, never>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {Sequelize} The app's Sequelize */
let sequelize;
/** @type {Sequelize} The queue's own Sequelize */
let queueSequelize;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];

/** @returns {Sequelize} */
function createSequelize() {
    return new Sequelize(inject('databaseUrl'), {
        dialect: inject('databaseDialect'),
        logging: false,
        pool: { max: 4 },
    });
}

beforeAll(async () => {
    database = await connectTestDatabase();
    sequelize = createSequelize();
    queueSequelize = createSequelize();
});

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await sequelize?.close();
    await queueSequelize?.close();
    await database?.close();
});

/**
 * A sqlane instance over Sequelize, on tables of its own, migrated.
 * @param {Partial<import('../../src/types.js').SqlaneOptions<any, never>>} [options]
 * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
 */
async function freshSqlane(options = {}) {
    prefixCount++;

    const p = `${database.tablePrefix}${prefixCount}_`;
    /** @type {SqlaneEvent[]} */
    const events = [];
    const sqlane = createSqlane({
        adapter: sequelizeAdapter(/** @type {any} */ (queueSequelize)),
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

test('enqueue in a transaction: the job commits with it, and rolls back with it', async () => {
    const { sqlane, p } = await freshSqlane();
    /** @type {any} */
    const app = sequelize;

    await sequelize.transaction(async (t) => {
        await expect(sqlane.enqueue(/** @type {any} */ (t), 'ping', { n: 1 }, { jobId: 'a' }))
            .resolves.toStrictEqual({ id: 'ping:a', created: true });
        await expect(statuses(p)).resolves.toStrictEqual([]);
    });
    await expect(sequelize.transaction(async (t) => {
        await sqlane.enqueue(/** @type {any} */ (t), 'ping', { n: 2 }, { jobId: 'b' });
        throw new Error('rollback');
    })).rejects.toThrow('rollback');

    await expect(statuses(p)).resolves.toStrictEqual(['pending']);
    await expect(sqlane.enqueue(app, 'ping', { n: 3 }, { jobId: 'a' })).resolves.toMatchObject({ created: false });
});

test('an unmanaged transaction, and an instance (a transaction of its own)', async () => {
    const { sqlane, p } = await freshSqlane();
    const t = await sequelize.transaction();

    await sqlane.enqueue(/** @type {any} */ (t), 'ping', {}, { jobId: 'unmanaged' });
    await t.commit();
    await sqlane.enqueueMany(/** @type {any} */ (sequelize), 'ping', [{ payload: { n: 1 } }, { payload: { n: 2 } }]);

    await expect(statuses(p)).resolves.toHaveLength(3);
});

test('the commit wakes the worker at once: the job does not wait for a re-probe', async () => {
    const { sqlane, events } = await freshSqlane({ pollInterval: '10s' });

    sqlane.handle('ping', () => {});
    await sqlane.start();
    await sleep(100);
    await sequelize.transaction(async (t) => {
        await sqlane.enqueue(/** @type {any} */ (t), 'ping', {});
        // The re-probes after the enqueue: 20, 50, 100, 200, then 500 ms
        await sleep(300);
    });

    const committedAt = Date.now();

    await waitFor(() => events.some(event => event.type === 'claimed'));
    expect(Date.now() - committedAt).toBeLessThan(150);
});

test('a nested transaction: the job runs after the outer commit, and never after an outer rollback', async () => {
    const { sqlane, p, events } = await freshSqlane({ pollInterval: '10s' });

    sqlane.handle('ping', () => {});
    await sqlane.start();
    await expect(sequelize.transaction(async (outer) => {
        await sequelize.transaction({ transaction: outer }, async (inner) => {
            await sqlane.enqueue(/** @type {any} */ (inner), 'ping', {}, { jobId: 'rolled_back' });
        });
        throw new Error('outer rollback');
    })).rejects.toThrow('outer rollback');
    await sequelize.transaction(async (outer) => {
        await sequelize.transaction({ transaction: outer }, async (inner) => {
            await sqlane.enqueue(/** @type {any} */ (inner), 'ping', {}, { jobId: 'committed' });
        });
    });

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
    /** @type {any} */
    const app = sequelize;
    /** @type {unknown[]} */
    const failures = [];

    sqlane.handle(report, () => {});
    sqlane.handle(failing, () => {
        throw new Error('always');
    });
    sqlane.handle(reportFailed, ({ payload }) => {
        failures.push(payload.job.name);
    });
    await sqlane.enqueueMany(app, report, [{ payload: { id: 1 } }, { payload: { id: 1 } }]);
    await sqlane.enqueue(app, failing, {});

    await expect(sqlane.drain({ includeDelayed: true }))
        .resolves.toStrictEqual({ completed: 3, retried: 1, failed: 1 });
    expect(failures).toStrictEqual(['failing']);
    await expect(sqlane.getStats()).resolves.toMatchObject([{ name: 'failing', pending: 0, failed: 1 }]);
    expect((await statuses(p)).toSorted()).toStrictEqual(['completed', 'completed', 'completed', 'failed']);
});
