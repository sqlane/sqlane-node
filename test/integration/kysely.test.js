import { setTimeout as sleep } from 'node:timers/promises';
import * as kysely029 from 'kysely';
import * as kysely028 from 'kysely-0.28';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { createPool } from 'mysql2';
import { Pool } from 'pg';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import { connectTestDatabase } from '../support/test_database.js';
import { kyselyAdapter } from '../../src/adapters/kysely.js';
import { createSqlane, defineJob } from '../../src/index.js';

/** @typedef {import('../../src/adapters/kysely.js').KyselyConnection} KyselyConnection */
/** @typedef {import('../../src/types.js').Sqlane<KyselyConnection, never>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */
/** @typedef {typeof kysely029} KyselyModule */

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];
/** @type {import('kysely').Kysely<any>[]} */
const dbs = [];

beforeAll(async () => {
    database = await connectTestDatabase();
});

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await Promise.all(dbs.map(db => db.destroy()));
    await database?.close();
});

/**
 * A Kysely instance on the test database, with the CamelCasePlugin: sqlane must not see its renamed columns.
 * @param {KyselyModule} k
 * @param {boolean} [postgresJs] PostgreSQL through kysely-postgres-js, not pg.
 * @returns {import('kysely').Kysely<any>}
 */
function createDb(k, postgresJs = false) {
    const url = inject('databaseUrl');
    /** @type {import('kysely').Dialect} */
    let dialect;

    if (inject('databaseDialect') !== 'postgres') {
        dialect = new k.MysqlDialect({ pool: createPool({ uri: url, connectionLimit: 4 }) });
    } else if (postgresJs) {
        dialect = new PostgresJSDialect({ postgres: postgres(url, { max: 4, onnotice: () => {} }) });
    } else {
        dialect = new k.PostgresDialect({ pool: new Pool({ connectionString: url, max: 4 }) });
    }
    const db = new k.Kysely({ dialect, plugins: [new k.CamelCasePlugin()] });

    dbs.push(/** @type {any} */ (db));

    return /** @type {any} */ (db);
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
    { version: '0.29', k: kysely029, postgresJs: false },
    { version: '0.28', k: /** @type {KyselyModule} */ (/** @type {unknown} */ (kysely028)), postgresJs: false },
    // kysely-postgres-js: PostgreSQL only, Kysely 0.29+
    ...inject('databaseDialect') === 'postgres' ? [{ version: '0.29, postgres.js', k: kysely029, postgresJs: true }] : [],
])('kysely $version', ({ k, postgresJs }) => {
    /** @type {import('kysely').Kysely<any>} The app's Kysely */
    let db;
    /** @type {import('kysely').Kysely<any>} The queue's own Kysely */
    let queueDb;

    beforeAll(() => {
        db = createDb(k, postgresJs);
        queueDb = createDb(k, postgresJs);
    });

    /**
     * A sqlane instance over Kysely, on tables of its own, migrated.
     * @param {Partial<import('../../src/types.js').SqlaneOptions<any, never>>} [options]
     * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
     */
    async function freshSqlane(options = {}) {
        prefixCount++;

        const p = `${database.tablePrefix}${prefixCount}_`;
        /** @type {SqlaneEvent[]} */
        const events = [];
        const sqlane = createSqlane({
            adapter: kyselyAdapter(queueDb, { dialect: inject('databaseDialect') }),
            tablePrefix: p,
            onEvent: event => events.push(event),
            ...options,
        });

        instances.push(sqlane);
        await sqlane.migrate();

        return { sqlane, p, events };
    }

    test('enqueue in a transaction: the job commits with it, and rolls back with it', async () => {
        const { sqlane, p } = await freshSqlane();

        await db.transaction().execute(async (trx) => {
            await expect(sqlane.enqueue(trx, 'ping', { n: 1 }, { jobId: 'a' }))
                .resolves.toStrictEqual({ id: 'ping:a', created: true });
            await expect(statuses(p)).resolves.toStrictEqual([]);
        });
        await expect(db.transaction().execute(async (trx) => {
            await sqlane.enqueue(trx, 'ping', { n: 2 }, { jobId: 'b' });
            throw new Error('rollback');
        })).rejects.toThrow('rollback');

        await expect(statuses(p)).resolves.toStrictEqual(['pending']);
        await expect(sqlane.enqueue(db, 'ping', { n: 3 }, { jobId: 'a' })).resolves.toMatchObject({ created: false });
    });

    test('a controlled transaction, and a Kysely instance (a transaction of its own)', async () => {
        const { sqlane, p } = await freshSqlane();
        const trx = await db.startTransaction().execute();

        await sqlane.enqueue(trx, 'ping', {}, { jobId: 'controlled' });
        await trx.commit().execute();
        await sqlane.enqueueMany(db, 'ping', [{ payload: { n: 1 } }, { payload: { n: 2 } }]);

        await expect(statuses(p)).resolves.toHaveLength(3);
    });

    test('a worker runs a job enqueued in a transaction', async () => {
        const { sqlane, p, events } = await freshSqlane({ pollInterval: '10s' });

        sqlane.handle('ping', () => {});
        await sqlane.start();
        await db.transaction().execute(async (trx) => {
            await sqlane.enqueue(trx, 'ping', {});
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
        await expect(sqlane.getStats()).resolves.toMatchObject([{ name: 'failing', pending: 0, failed: 1 }]);
        expect((await statuses(p)).toSorted()).toStrictEqual(['completed', 'completed', 'completed', 'failed']);
    });
});
