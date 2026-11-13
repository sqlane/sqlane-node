import { setTimeout as sleep } from 'node:timers/promises';
import * as drizzle1Mysql from 'drizzle-orm-1/mysql2';
import * as drizzle1Pg from 'drizzle-orm-1/node-postgres';
import * as drizzle1PgJs from 'drizzle-orm-1/postgres-js';
import * as drizzleMysql from 'drizzle-orm/mysql2';
import * as drizzlePg from 'drizzle-orm/node-postgres';
import * as drizzlePgJs from 'drizzle-orm/postgres-js';
import { createPool } from 'mysql2/promise';
import { Pool } from 'pg';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import { connectTestDatabase } from '../support/test_database.js';
import { mysqlFamilyOptions } from './helpers/test_adapter.js';
import { drizzleAdapter } from '../../src/adapters/drizzle.js';
import { createSqlane, defineJob } from '../../src/index.js';
import { readsAcrossCommit } from './helpers/isolation.js';

/** @typedef {import('../../src/adapters/drizzle.js').DrizzleConnection} DrizzleConnection */
/** @typedef {import('../../src/types.js').Sqlane<DrizzleConnection>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */
/** @typedef {(options: { client: any }) => any} DrizzleFactory */

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];
/** @type {{ end: () => Promise<void> }[]} */
const pools = [];

beforeAll(async () => {
    database = await connectTestDatabase();
});

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await Promise.all(pools.map(pool => pool.end()));
    await database?.close();
});

/**
 * A Drizzle database on a pool of its own.
 * @param {{ mysql: DrizzleFactory, postgres: DrizzleFactory }} factories
 * @param {boolean} postgresJs PostgreSQL through postgres.js, not node-postgres.
 * @returns {DrizzleConnection}
 */
function createDb(factories, postgresJs) {
    const url = inject('databaseUrl');
    const isMysql = inject('databaseDialect') !== 'postgres';
    if (isMysql) {
        const pool = createPool({ uri: url, connectionLimit: 4 });

        pools.push(pool);

        return factories.mysql({ client: pool });
    }

    const pool = postgresJs
        ? postgres(url, { max: 4, onnotice: () => {} })
        : new Pool({ connectionString: url, max: 4 });

    pools.push(pool);

    return factories.postgres({ client: pool });
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

const isPostgres = inject('databaseDialect') === 'postgres';

describe.each([
    { version: '0.45', factories: { mysql: drizzleMysql.drizzle, postgres: drizzlePg.drizzle }, postgresJs: false },
    { version: '1.0 rc', factories: { mysql: drizzle1Mysql.drizzle, postgres: drizzle1Pg.drizzle }, postgresJs: false },
    // postgres.js: PostgreSQL only
    ...[
        { version: '0.45, postgres.js', factories: { postgres: drizzlePgJs.drizzle }, postgresJs: true },
        { version: '1.0 rc, postgres.js', factories: { postgres: drizzle1PgJs.drizzle }, postgresJs: true },
    ].filter(() => isPostgres),
])('drizzle $version', ({ factories, postgresJs }) => {
    /** @type {DrizzleConnection} The app's Drizzle */
    let db;
    /** @type {DrizzleConnection} The queue's own Drizzle */
    let queueDb;

    beforeAll(() => {
        db = createDb(/** @type {any} */ (factories), postgresJs);
        queueDb = createDb(/** @type {any} */ (factories), postgresJs);
    });

    /**
     * A sqlane instance over Drizzle, on tables of its own, migrated.
     * @param {Partial<import('../../src/types.js').SqlaneOptions<any>>} [options]
     * @param {string} [prefix] The tables of another instance.
     * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
     */
    async function freshSqlane(options = {}, prefix = undefined) {
        prefixCount++;

        const p = prefix ?? `${database.tablePrefix}${prefixCount}_`;
        /** @type {SqlaneEvent[]} */
        const events = [];
        const sqlane = createSqlane({
            adapter: drizzleAdapter(queueDb, mysqlFamilyOptions()),
            tablePrefix: p,
            onEvent: event => events.push(event),
            ...options,
        });

        instances.push(sqlane);
        await sqlane.migrate();

        return { sqlane, p, events };
    }

    test('the queue transaction is READ COMMITTED', async () => {
        await expect(readsAcrossCommit(drizzleAdapter(queueDb, mysqlFamilyOptions()), database))
            .resolves.toStrictEqual([0, 1]);
    });

    test('enqueue in a transaction: the job commits with it, and rolls back with it', async () => {
        const { sqlane, p } = await freshSqlane();

        await db.transaction(async (tx) => {
            await expect(sqlane.enqueue(tx, 'ping', { n: 1 }, { jobId: 'a' }))
                .resolves.toStrictEqual({ id: 'ping:a', created: true });
            await expect(statuses(p)).resolves.toStrictEqual([]);
        });
        await expect(db.transaction(async (tx) => {
            await sqlane.enqueue(tx, 'ping', { n: 2 }, { jobId: 'b' });
            throw new Error('rollback');
        })).rejects.toThrow('rollback');

        await expect(statuses(p)).resolves.toStrictEqual(['pending']);
        await expect(sqlane.enqueue(db, 'ping', { n: 3 }, { jobId: 'a' })).resolves.toMatchObject({ created: false });
    });

    test('a nested transaction rolls back with the outer one; a database: a transaction of its own', async () => {
        const { sqlane, p } = await freshSqlane();

        await expect(db.transaction(async (outer) => {
            await outer.transaction(async (/** @type {DrizzleConnection} */ inner) => {
                await sqlane.enqueue(inner, 'ping', {}, { jobId: 'rolled_back' });
            });
            throw new Error('outer rollback');
        })).rejects.toThrow('outer rollback');
        await sqlane.enqueueMany(db, 'ping', [{ payload: { n: 1 } }, { payload: { n: 2 } }]);

        await expect(statuses(p)).resolves.toStrictEqual(['pending', 'pending']);
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
        await sqlane.enqueueMany(db, report, [{ payload: { id: 1 } }, { payload: { id: 1 } }]);
        await sqlane.enqueue(db, failing, {});

        await expect(sqlane.drain({ includeDelayed: true }))
            .resolves.toStrictEqual({ completed: 3, retried: 1, failed: 1 });
        expect(failures).toStrictEqual(['failing']);
        expect((await statuses(p)).toSorted()).toStrictEqual(['completed', 'completed', 'completed', 'failed']);
    });

    test.runIf(inject('databaseDialect') === 'postgres')('notify: another process wakes on the commit', async () => {
        const { sqlane: producer, p } = await freshSqlane({ adapter: drizzleAdapter(queueDb, { notify: true }) });
        const { sqlane: worker, events } = await freshSqlane({
            adapter: drizzleAdapter(queueDb, { notify: true }),
            pollInterval: '10s',
        }, p);

        worker.handle('ping', () => {});
        await worker.start();
        await sleep(200);
        await db.transaction(async (tx) => {
            await producer.enqueue(tx, 'ping', {});
        });

        const committedAt = Date.now();

        await waitFor(() => events.some(event => event.type === 'claimed'));
        expect(Date.now() - committedAt).toBeLessThan(1000);
    });
});
