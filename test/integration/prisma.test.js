import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, afterEach, beforeAll, expect, inject, test } from 'vitest';
import { connectTestDatabase } from '../support/test_database.js';
import { prismaAdapter } from '../../src/adapters/prisma.js';
import { createSqlane, defineJob } from '../../src/index.js';

/** @typedef {import('../../src/adapters/prisma.js').PrismaClientLike} PrismaClientLike */
/** @typedef {import('../../src/types.js').Sqlane<PrismaClientLike, never>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */

const dialect = inject('databaseDialect');

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {any} The app's Prisma client */
let prisma;
/** @type {any} The queue's own Prisma client */
let queuePrisma;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];

/** @returns {Promise<any>} A Prisma client of the generated client of the dialect. */
async function createPrisma() {
    // MariaDB: the client of the mysql provider
    const provider = dialect === 'postgres' ? 'postgres' : 'mysql';
    const clientPath = new URL(`../prisma/${provider}/generated/client.ts`, import.meta.url);

    if (!existsSync(clientPath)) {
        throw new Error('The Prisma client of the tests is missing: run `pnpm prisma:generate`');
    }

    const { PrismaClient } = await import(clientPath.href);
    const url = new URL(inject('databaseUrl'));
    const adapter = dialect !== 'postgres'
        ? new PrismaMariaDb({
                host: url.hostname,
                port: Number(url.port),
                user: url.username,
                password: url.password,
                database: url.pathname.slice(1),
                // MySQL 8 authentication without TLS
                allowPublicKeyRetrieval: true,
                connectionLimit: 4,
            })
        : new PrismaPg({ connectionString: url.href, max: 4 });

    return new PrismaClient({ adapter });
}

beforeAll(async () => {
    database = await connectTestDatabase();
    prisma = await createPrisma();
    queuePrisma = await createPrisma();
});

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await prisma?.$disconnect();
    await queuePrisma?.$disconnect();
    await database?.close();
});

/**
 * A sqlane instance over Prisma, on tables of its own, migrated through Prisma.
 * @param {Partial<import('../../src/types.js').SqlaneOptions<any, never>>} [options]
 * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
 */
async function freshSqlane(options = {}) {
    prefixCount++;

    const p = `${database.tablePrefix}${prefixCount}_`;
    /** @type {SqlaneEvent[]} */
    const events = [];
    const sqlane = createSqlane({
        adapter: prismaAdapter(queuePrisma, { dialect }),
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

test('migrate() through Prisma: the tables, once', async () => {
    const { sqlane } = await freshSqlane();

    await expect(sqlane.migrate()).resolves.toStrictEqual({ applied: [] });
});

test('enqueue in an interactive transaction: the job commits with it, and rolls back with it', async () => {
    const { sqlane, p } = await freshSqlane();

    await prisma.$transaction(async (/** @type {any} */ tx) => {
        await expect(sqlane.enqueue(tx, 'ping', { n: 1 }, { jobId: 'a' }))
            .resolves.toStrictEqual({ id: 'ping:a', created: true });
        await expect(statuses(p)).resolves.toStrictEqual([]);
    });
    await expect(prisma.$transaction(async (/** @type {any} */ tx) => {
        await sqlane.enqueue(tx, 'ping', { n: 2 }, { jobId: 'b' });
        throw new Error('rollback');
    })).rejects.toThrow('rollback');

    await expect(statuses(p)).resolves.toStrictEqual(['pending']);
    await expect(sqlane.enqueue(prisma, 'ping', { n: 3 }, { jobId: 'a' })).resolves.toMatchObject({ created: false });
});

test('a client: a transaction of its own', async () => {
    const { sqlane, p } = await freshSqlane();

    await sqlane.enqueueMany(prisma, 'ping', [{ payload: { n: 1 } }, { payload: { n: 2 } }]);
    await expect(statuses(p)).resolves.toStrictEqual(['pending', 'pending']);
});

test('a worker runs a job enqueued in a transaction', async () => {
    const { sqlane, p, events } = await freshSqlane({ pollInterval: '10s' });

    sqlane.handle('ping', () => {});
    await sqlane.start();
    await prisma.$transaction(async (/** @type {any} */ tx) => {
        await sqlane.enqueue(tx, 'ping', {});
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
    await sqlane.enqueueMany(prisma, report, [{ payload: { id: 1 } }, { payload: { id: 1 } }]);
    await sqlane.enqueue(prisma, failing, {});

    await expect(sqlane.drain({ includeDelayed: true }))
        .resolves.toStrictEqual({ completed: 3, retried: 1, failed: 1 });
    expect(failures).toStrictEqual(['failing']);
    await expect(sqlane.getStats()).resolves.toMatchObject([{ name: 'failing', pending: 0, failed: 1 }]);
    expect((await statuses(p)).toSorted()).toStrictEqual(['completed', 'completed', 'completed', 'failed']);
});
