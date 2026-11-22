import { setTimeout as sleep } from 'node:timers/promises';
import { QueryTypes, Sequelize } from 'sequelize';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import { connectTestDatabase } from '../support/test_database.js';
import { checkSchedules } from './helpers/schedule_checks.js';
import { dialectOptions } from './helpers/test_adapter.js';
import { sequelizeAdapter } from '../../src/adapters/sequelize.js';
import { createSqlane, defineConcurrencyLimit, defineJob } from '../../src/index.js';
import { poolTransactionIsolation, readCommitted, readsAcrossCommit } from './helpers/isolation.js';
import { preparedAfterAJob, SQLANE_STATEMENTS_SQL } from './helpers/prepared_statements.js';
import { checkJobsBulk } from './helpers/jobs_bulk_checks.js';
import { checkJobsRead } from './helpers/jobs_read_checks.js';
import { checkSchemaChanges, SCHEMA_CHANGES } from './helpers/schema_checks.js';
import { checkStartTimes } from './helpers/start_time_checks.js';

/** @typedef {import('../../src/adapters/sequelize.js').SequelizeConnection} SequelizeConnection */
/** @typedef {import('../../src/types.js').Sqlane<SequelizeConnection>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */

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

/** The Sequelize dialects of the database: MariaDB through mysql2 (mysql) and through the mariadb driver (mariadb) */
const SEQUELIZE_DIALECTS = /** @type {const} */ ({
    mysql: ['mysql'],
    mariadb: ['mysql', 'mariadb'],
    postgres: ['postgres'],
})[inject('databaseDialect')];

/**
 * @param {number} max The connections of its pool.
 * @returns {Sequelize} A Sequelize of the "postgres" dialect on the test database.
 */
function createPostgresSequelize(max) {
    return new Sequelize(inject('databaseUrl'), { dialect: 'postgres', logging: false, pool: { max } });
}

describe.each(SEQUELIZE_DIALECTS)('sequelize, dialect %s', (sequelizeDialect) => {
    const adapterOptions = dialectOptions();
    /** @type {import('../support/test_database.js').TestDatabaseConnection} */
    let database;
    /** @type {Sequelize} The app's Sequelize */
    let sequelize;
    /** @type {Sequelize} The queue's own Sequelize */
    let queueSequelize;
    let prefixCount = 0;
    /** @type {Sqlane[]} */
    let instances = [];

    /**
     * @param {string} [url] Default: the test database.
     * @returns {Sequelize}
     */
    function createSequelize(url = inject('databaseUrl')) {
        // The protocol of the URL picks the dialect of Sequelize
        return new Sequelize(url.replace(/^mysql:/, `${sequelizeDialect}:`), {
            dialect: sequelizeDialect,
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
     * @param {Partial<import('../../src/types.js').SqlaneOptions<any>>} [options]
     * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
     */
    async function freshSqlane(options = {}) {
        prefixCount++;

        const p = `${database.tablePrefix}${prefixCount}_`;
        /** @type {SqlaneEvent[]} */
        const events = [];
        const sqlane = createSqlane({
            adapter: sequelizeAdapter(/** @type {any} */ (queueSequelize), adapterOptions),
            tablePrefix: p,
            onEvent: event => events.push(event),
            ...options,
        });

        instances.push(sqlane);
        await sqlane.schema.migrate();

        return { sqlane, p, events };
    }

    /**
     * @param {string} p
     * @returns {Promise<string[]>} The statuses, in the order of the ids.
     */
    async function statuses(p) {
        return (await database.query(`SELECT status FROM ${p}jobs ORDER BY id`)).map(row => String(row.status));
    }

    test('schedules: start() without the table asks for schema.migrate(); a slot adds its job', async () => {
        const { sqlane, p } = await freshSqlane();

        await expect(checkSchedules(sqlane, p, database)).resolves.toMatch(/^tick:schedule:\d{4}-/);
    });

    test('sqlane.jobs: get and list through the adapter', async () => {
        const { sqlane } = await freshSqlane();

        await expect(checkJobsRead(sqlane, sequelize)).resolves.toHaveLength(3);
    });

    test('the schema through the adapter: rollback(), migrate() again, drop()', async () => {
        const { sqlane, p } = await freshSqlane();

        await expect(checkSchemaChanges(sqlane, p)).resolves.toStrictEqual(SCHEMA_CHANGES);
    });

    test('the start time of a run: the event, JobInfo, JobRecord and its slots agree', async () => {
        const { sqlane, p, events } = await freshSqlane();

        await expect(checkStartTimes(sqlane, sequelize, { p, database, events })).resolves.toBeUndefined();
    });

    test('sqlane.jobs: retry, cancel and remove through the adapter', async () => {
        const { sqlane } = await freshSqlane();

        await expect(checkJobsBulk(
            sqlane,
            sequelize,
            func => sequelize.transaction(t => func(t)),
        )).resolves.toBeUndefined();
    });

    test('the queue transaction is READ COMMITTED', async () => {
        await expect(readsAcrossCommit(sequelizeAdapter(/** @type {any} */ (queueSequelize), adapterOptions), database))
            .resolves.toStrictEqual([0, 1]);
    });

    test('poolTransaction: a transaction of its own at READ COMMITTED on a pool; null in a transaction', async () => {
        const adapter = sequelizeAdapter(/** @type {any} */ (queueSequelize), adapterOptions);

        await expect(poolTransactionIsolation(adapter, database, sequelize, async (url) => {
            const other = createSequelize(url);

            return { pool: other, close: () => other.close() };
        }))
            .resolves.toStrictEqual(readCommitted(database));
        await sequelize.transaction(async (/** @type {any} */ t) => {
            expect(adapter.poolTransaction?.(t, async () => 1)).toBeNull();
        });
    });

    test('enqueue in a transaction: the job commits with it, and rolls back with it', async () => {
        const { sqlane, p } = await freshSqlane();
        /** @type {any} */
        const app = sequelize;

        await sequelize.transaction(async (t) => {
            await expect(sqlane.enqueue(/** @type {any} */ (t), 'ping', { n: 1 }, { dedupeKey: 'a' }))
                .resolves.toStrictEqual({ id: 'ping:a', created: true });
            await expect(statuses(p)).resolves.toStrictEqual([]);
        });
        await expect(sequelize.transaction(async (t) => {
            await sqlane.enqueue(/** @type {any} */ (t), 'ping', { n: 2 }, { dedupeKey: 'b' });
            throw new Error('rollback');
        })).rejects.toThrow('rollback');

        await expect(statuses(p)).resolves.toStrictEqual(['pending']);
        await expect(sqlane.enqueue(app, 'ping', { n: 3 }, { dedupeKey: 'a' })).resolves.toMatchObject({ created: false });
    });

    test('an unmanaged transaction, and an instance (a transaction of its own)', async () => {
        const { sqlane, p } = await freshSqlane();
        const t = await sequelize.transaction();

        await sqlane.enqueue(/** @type {any} */ (t), 'ping', {}, { dedupeKey: 'unmanaged' });
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
                await sqlane.enqueue(/** @type {any} */ (inner), 'ping', {}, { dedupeKey: 'rolled_back' });
            });
            throw new Error('outer rollback');
        })).rejects.toThrow('outer rollback');
        await sequelize.transaction(async (outer) => {
            await sequelize.transaction({ transaction: outer }, async (inner) => {
                await sqlane.enqueue(/** @type {any} */ (inner), 'ping', {}, { dedupeKey: 'committed' });
            });
        });

        await waitFor(() => events.some(event => event.type === 'completed'));
        await expect(statuses(p)).resolves.toStrictEqual(['completed']);
    });

    test('drain: retries, global limits and a failure job', async () => {
        const reportLimit = defineConcurrencyLimit({ name: 'r', max: 1 });
        const report = defineJob({
            name: 'report',
            globalConcurrencyLimits: ({ payload }) => [reportLimit.key(payload.id)],
            timeout: '5s',
        });
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
        await expect(sqlane.jobs.stats()).resolves.toMatchObject([
            { name: 'failing', pending: 0, failed: 1, completed: 0 },
            { name: 'report', pending: 0, completed: 2 },
            { name: 'report_failed', pending: 0, completed: 1 },
        ]);
        expect((await statuses(p)).toSorted()).toStrictEqual(['completed', 'completed', 'completed', 'failed']);
    });

    test.runIf(sequelizeDialect === 'postgres').each([
        { prepare: true, named: true },
        { prepare: false, named: false },
        { prepare: undefined, named: false },
    ])('prepare: $prepare: named prepared statements on the connections of sqlane: $named', async ({ prepare, named }) => {
        // One connection each: pg_prepared_statements is of the session that reads it
        const queueOne = createPostgresSequelize(1);
        const appOne = createPostgresSequelize(1);

        prefixCount++;

        const sqlane = createSqlane({
            adapter: sequelizeAdapter(/** @type {any} */ (queueOne), { dialect: 'postgres', prepare }),
            tablePrefix: `${database.tablePrefix}${prefixCount}_`,
        });

        try {
            /**
             * @param {string} sql
             * @returns {Promise<Record<string, unknown>[]>}
             */
            const query = async sql => /** @type {Record<string, unknown>[]} */ (
                await queueOne.query(sql, { type: QueryTypes.SELECT })
            );
            const queueStatements = await preparedAfterAJob(sqlane, /** @type {any} */ (queueOne), query);
            // The caller's transaction: on the app's connection
            const appStatements = await appOne.transaction(async (t) => {
                await sqlane.enqueue(/** @type {any} */ (t), 'ping', {});

                const [row] = await appOne.query(SQLANE_STATEMENTS_SQL, { type: QueryTypes.SELECT, transaction: t });

                return /** @type {{ statements: number }} */ (row).statements;
            });

            expect(queueStatements > 0).toBe(named);
            expect(appStatements > 0).toBe(named);
        } finally {
            await sqlane.close({ deadline: 0, mode: 'abandon' });
            await queueOne.close();
            await appOne.close();
        }
    });
});
