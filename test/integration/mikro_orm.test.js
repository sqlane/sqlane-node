import { setTimeout as sleep } from 'node:timers/promises';
import { MikroORM as MySqlMikroORM } from '@mikro-orm/mysql';
import { MikroORM as PostgreSqlMikroORM } from '@mikro-orm/postgresql';
import { MySqlMikroORM as MySqlMikroORM6, PostgreSqlMikroORM as PostgreSqlMikroORM6 } from '../mikro-orm-6/index.js';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import { connectTestDatabase } from '../support/test_database.js';
import { mikroOrmAdapter } from '../../src/adapters/mikro_orm.js';
import { createSqlane, defineJob } from '../../src/index.js';

/** @typedef {import('../../src/types.js').Sqlane<any, never>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];
/** @type {any[]} */
const orms = [];

beforeAll(async () => {
    database = await connectTestDatabase();
});

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await Promise.all(orms.map(orm => orm.close()));
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

describe.each([
    { version: '7', mysql: MySqlMikroORM, postgres: PostgreSqlMikroORM },
    { version: '6', mysql: MySqlMikroORM6, postgres: PostgreSqlMikroORM6 },
])('mikro-orm $version', ({ mysql, postgres }) => {
    const dialect = inject('databaseDialect');
    /** @type {any} The app's MikroORM */
    let orm;
    /** @type {any} The queue's own MikroORM */
    let queueOrm;

    /** @returns {Promise<any>} An initialized MikroORM on the test database. */
    async function createOrm() {
        const created = await /** @type {any} */ (dialect === 'postgres' ? postgres : mysql).init({
            clientUrl: inject('databaseUrl'),
            entities: [],
            discovery: { warnWhenNoEntities: false },
            pool: { min: 0, max: 4 },
        });

        orms.push(created);

        return created;
    }

    beforeAll(async () => {
        orm = await createOrm();
        queueOrm = await createOrm();
    });

    /**
     * A sqlane instance over MikroORM, on tables of its own, migrated.
     * @param {Partial<import('../../src/types.js').SqlaneOptions<any, never>>} [options]
     * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
     */
    async function freshSqlane(options = {}) {
        prefixCount++;

        const p = `${database.tablePrefix}${prefixCount}_`;
        /** @type {SqlaneEvent[]} */
        const events = [];
        const sqlane = createSqlane({
            adapter: mikroOrmAdapter(queueOrm.em, { dialect }),
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

        await orm.em.transactional(async (/** @type {any} */ em) => {
            await expect(sqlane.enqueue(em, 'ping', { n: 1 }, { jobId: 'a' }))
                .resolves.toStrictEqual({ id: 'ping:a', created: true });
            await expect(statuses(p)).resolves.toStrictEqual([]);
        });
        await expect(orm.em.transactional(async (/** @type {any} */ em) => {
            await sqlane.enqueue(em, 'ping', { n: 2 }, { jobId: 'b' });
            throw new Error('rollback');
        })).rejects.toThrow('rollback');

        await expect(statuses(p)).resolves.toStrictEqual(['pending']);
        await expect(sqlane.enqueue(orm.em, 'ping', { n: 3 }, { jobId: 'a' }))
            .resolves.toMatchObject({ created: false });
    });

    test('the global EntityManager inside em.transactional(): its transaction', async () => {
        const { sqlane, p } = await freshSqlane();

        await expect(orm.em.transactional(async () => {
            await sqlane.enqueue(orm.em, 'ping', {}, { jobId: 'rolled_back' });
            throw new Error('rollback');
        })).rejects.toThrow('rollback');
        await orm.em.transactional(async () => {
            await sqlane.enqueue(orm.em, 'ping', {}, { jobId: 'committed' });
            await expect(statuses(p)).resolves.toStrictEqual([]);
        });

        await expect(statuses(p)).resolves.toStrictEqual(['pending']);
    });

    test('an EntityManager outside a transaction: a transaction of its own', async () => {
        const { sqlane, p } = await freshSqlane();

        await sqlane.enqueue(orm.em, 'ping', {});
        await sqlane.enqueueMany(orm.em.fork(), 'ping', [{ payload: { n: 1 } }, { payload: { n: 2 } }]);
        await expect(statuses(p)).resolves.toStrictEqual(['pending', 'pending', 'pending']);
    });

    test.each([
        {
            how: 'em.transactional()',
            /**
             * @param {(em: any) => Promise<void>} func
             * @returns {Promise<void>}
             */
            run: func => orm.em.transactional(func),
        },
        {
            how: 'the global EntityManager in em.transactional()',
            /**
             * @param {(em: any) => Promise<void>} func
             * @returns {Promise<void>}
             */
            run: func => orm.em.transactional(() => func(orm.em)),
        },
        {
            how: 'begin() and commit() of a fork',
            /** @param {(em: any) => Promise<void>} func */
            run: async (func) => {
                const fork = orm.em.fork();

                await fork.begin();
                await func(fork);
                await fork.commit();
            },
        },
    ])('the commit wakes the worker at once: $how', async ({ run }) => {
        const { sqlane, events } = await freshSqlane({ pollInterval: '10s' });

        sqlane.handle('ping', () => {});
        await sqlane.start();
        await sleep(100);
        await run(async (em) => {
            await sqlane.enqueue(em, 'ping', {});
            // The re-probes after the enqueue: 20, 50, 100, 200, then 500 ms
            await sleep(300);
        });

        const committedAt = Date.now();

        await waitFor(() => events.some(event => event.type === 'claimed'));
        expect(Date.now() - committedAt).toBeLessThan(150);
    });

    test('a nested transaction (a savepoint): the job runs after the outer commit, never after an outer rollback', async () => {
        const { sqlane, p, events } = await freshSqlane();

        sqlane.handle('ping', () => {});
        await sqlane.start();

        await expect(orm.em.transactional(async (/** @type {any} */ outer) => {
            await outer.transactional(async (/** @type {any} */ inner) => {
                await sqlane.enqueue(inner, 'ping', {}, { jobId: 'rolled_back' });
            });
            throw new Error('rollback');
        })).rejects.toThrow('rollback');
        await orm.em.transactional(async (/** @type {any} */ outer) => {
            await outer.transactional(async (/** @type {any} */ inner) => {
                await sqlane.enqueue(inner, 'ping', {}, { jobId: 'committed' });
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
        /** @type {unknown[]} */
        const failures = [];

        sqlane.handle(report, () => {});
        sqlane.handle(failing, () => {
            throw new Error('always');
        });
        sqlane.handle(reportFailed, ({ payload }) => {
            failures.push(payload.job.name);
        });
        await sqlane.enqueueMany(orm.em, report, [{ payload: { id: 1 } }, { payload: { id: 1 } }]);
        await sqlane.enqueue(orm.em, failing, {});

        await expect(sqlane.drain({ includeDelayed: true }))
            .resolves.toStrictEqual({ completed: 3, retried: 1, failed: 1 });
        expect(failures).toStrictEqual(['failing']);
        await expect(sqlane.getStats()).resolves.toMatchObject([{ name: 'failing', pending: 0, failed: 1 }]);
        expect((await statuses(p)).toSorted()).toStrictEqual(['completed', 'completed', 'completed', 'failed']);
    });
});
