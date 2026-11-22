import { setTimeout as sleep } from 'node:timers/promises';
import knexLib from 'knex';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import { createSqlane, defineConcurrencyLimit, defineJob } from '../../src/index.js';
import { connectTestDatabase } from '../support/test_database.js';
import { checkSchedules } from './helpers/schedule_checks.js';
import { dialectOptions } from './helpers/test_adapter.js';
import { knexAdapter } from '../../src/adapters/knex.js';
import { poolTransactionIsolation, readCommitted, readsAcrossCommit } from './helpers/isolation.js';
import { preparedAfterAJob, SQLANE_STATEMENTS_SQL } from './helpers/prepared_statements.js';
import { checkJobsBulk } from './helpers/jobs_bulk_checks.js';
import { checkJobsRead } from './helpers/jobs_read_checks.js';
import { checkSchemaChanges, SCHEMA_CHANGES } from './helpers/schema_checks.js';
import { checkStartTimes } from './helpers/start_time_checks.js';

/** @typedef {import('../../src/types.js').Sqlane<import('../../src/adapters/knex.js').KnexConnection>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */

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

/** The knex clients of the database: MariaDB through mysql2 and through the mariadb driver */
const CLIENTS = { mysql: ['mysql2'], mariadb: ['mysql2', 'mariadb'], postgres: ['pg'] }[inject('databaseDialect')];

describe.each(CLIENTS)('knex, client %s', (client) => {
    const adapterOptions = dialectOptions();
    /** @type {import('../support/test_database.js').TestDatabaseConnection} */
    let database;
    /** @type {import('knex').Knex} The app's knex */
    let knex;
    /** @type {import('knex').Knex} The queue's own knex */
    let queueKnex;
    let prefixCount = 0;
    /** @type {Sqlane[]} */
    let instances = [];

    /**
     * @param {string} [url] Default: the test database.
     * @returns {import('knex').Knex}
     */
    function createKnex(url = inject('databaseUrl')) {
        return knexLib({
            client,
            connection: url,
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
     * @param {Partial<import('../../src/types.js').SqlaneOptions<any>>} [options]
     * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
     */
    async function freshSqlane(options = {}) {
        prefixCount++;

        const p = `${database.tablePrefix}${prefixCount}_`;
        /** @type {SqlaneEvent[]} */
        const events = [];
        const sqlane = createSqlane({
            // The mariadb client tells MariaDB; mysql2 needs the option
            adapter: knexAdapter(queueKnex, adapterOptions),
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

        await expect(checkJobsRead(sqlane, knex)).resolves.toHaveLength(3);
    });

    test('the schema through the adapter: rollback(), migrate() again, drop()', async () => {
        const { sqlane, p } = await freshSqlane();

        await expect(checkSchemaChanges(sqlane, p)).resolves.toStrictEqual(SCHEMA_CHANGES);
    });

    test('the start time of a run: the event, JobInfo, JobRecord and its slots agree', async () => {
        const { sqlane, p, events } = await freshSqlane();

        await expect(checkStartTimes(sqlane, knex, { p, database, events })).resolves.toBeUndefined();
    });

    test('sqlane.jobs: retry, cancel and remove through the adapter', async () => {
        const { sqlane } = await freshSqlane();

        await expect(checkJobsBulk(
            sqlane,
            knex,
            func => knex.transaction(trx => func(trx)),
        )).resolves.toBeUndefined();
    });

    test('the queue transaction is READ COMMITTED', async () => {
        await expect(readsAcrossCommit(knexAdapter(queueKnex, adapterOptions), database))
            .resolves.toStrictEqual([0, 1]);
    });

    test('poolTransaction: a transaction of its own at READ COMMITTED on a pool; null in a transaction', async () => {
        const adapter = knexAdapter(queueKnex, adapterOptions);

        await expect(poolTransactionIsolation(adapter, database, knex, async (url) => {
            const other = createKnex(url);

            return { pool: other, close: () => other.destroy() };
        }))
            .resolves.toStrictEqual(readCommitted(database));
        await knex.transaction(async (trx) => {
            expect(adapter.poolTransaction?.(trx, async () => 1)).toBeNull();
        });
    });

    test('enqueue in a knex transaction: the job commits with it, and rolls back with it', async () => {
        const { sqlane, p } = await freshSqlane();

        await knex.transaction(async (trx) => {
            await expect(sqlane.enqueue(trx, 'ping', { n: 1 }, { dedupeKey: 'a' })).resolves.toStrictEqual({
                id: 'ping:a',
                created: true,
            });
            // Not visible outside the transaction
            await expect(statuses(p)).resolves.toStrictEqual([]);
        });
        await expect(knex.transaction(async (trx) => {
            await sqlane.enqueue(trx, 'ping', { n: 2 }, { dedupeKey: 'b' });
            throw new Error('rollback');
        })).rejects.toThrow('rollback');

        await expect(statuses(p)).resolves.toStrictEqual(['pending']);
        // The dedupe sees the committed job
        await expect(sqlane.enqueue(knex, 'ping', { n: 3 }, { dedupeKey: 'a' })).resolves.toMatchObject({ created: false });
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
                await sqlane.enqueue(inner, 'ping', {}, { dedupeKey: 'rolled_back' });
            });
            throw new Error('outer rollback');
        })).rejects.toThrow('outer rollback');
        await knex.transaction(async (outer) => {
            await outer.transaction(async (inner) => {
                await sqlane.enqueue(inner, 'ping', {}, { dedupeKey: 'committed' });
            });
        });

        await waitFor(() => events.some(event => event.type === 'completed'));
        await expect(statuses(p)).resolves.toStrictEqual(['completed']);
    });

    test('drain: retries, global limits and a failure job, over knex', async () => {
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
        await expect(sqlane.jobs.stats()).resolves.toMatchObject([
            { name: 'failing', pending: 0, failed: 1, completed: 0 },
            { name: 'report', pending: 0, completed: 2 },
            { name: 'report_failed', pending: 0, completed: 1 },
        ]);
        expect((await statuses(p)).toSorted()).toStrictEqual(['completed', 'completed', 'completed', 'failed']);
    });

    test.runIf(client === 'pg').each([
        { prepare: true, named: true },
        { prepare: false, named: false },
        { prepare: undefined, named: false },
    ])('prepare: $prepare: named prepared statements on the connections of sqlane: $named', async ({ prepare, named }) => {
        // One connection each: pg_prepared_statements is of the session that reads it
        const onePool = { client, connection: inject('databaseUrl'), pool: { min: 0, max: 1 } };
        const queueOne = knexLib(onePool);
        const appOne = knexLib(onePool);

        prefixCount++;

        const sqlane = createSqlane({
            adapter: knexAdapter(queueOne, { dialect: 'postgres', prepare }),
            tablePrefix: `${database.tablePrefix}${prefixCount}_`,
        });

        try {
            /**
             * @param {string} sql
             * @returns {Promise<Record<string, unknown>[]>}
             */
            const query = async sql => (await queueOne.raw(sql)).rows;
            const queueStatements = await preparedAfterAJob(sqlane, queueOne, query);
            // The caller's transaction: on the app's connection
            const appStatements = await appOne.transaction(async (trx) => {
                await sqlane.enqueue(trx, 'ping', {});

                return (await trx.raw(SQLANE_STATEMENTS_SQL)).rows[0].statements;
            });

            expect(queueStatements > 0).toBe(named);
            expect(appStatements > 0).toBe(named);
        } finally {
            await sqlane.close({ deadline: 0, mode: 'abandon' });
            await queueOne.destroy();
            await appOne.destroy();
        }
    });
});
