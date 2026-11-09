// Sequelize with CLS: a file of its own, as `Sequelize.useCLS()` is global (each test file runs in a module registry of
// its own).
import { setTimeout as sleep } from 'node:timers/promises';
import { createNamespace } from 'cls-hooked';
import { Sequelize } from 'sequelize';
import { afterAll, afterEach, beforeAll, expect, inject, test } from 'vitest';
import { connectTestDatabase } from '../support/test_database.js';
import { sequelizeAdapter } from '../../src/adapters/sequelize.js';
import { createSqlane } from '../../src/index.js';

/** @typedef {import('../../src/adapters/sequelize.js').SequelizeConnection} SequelizeConnection */
/** @typedef {import('../../src/types.js').Sqlane<SequelizeConnection, never>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */

Sequelize.useCLS(createNamespace('sqlane-test'));

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {any} The app's Sequelize */
let sequelize;
/** @type {any} The queue's own Sequelize */
let queueSequelize;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];

/** @returns {Sequelize} */
function createSequelize() {
    return new Sequelize(inject('databaseUrl'), { dialect: inject('databaseDialect'), logging: false, pool: { max: 4 } });
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
 * @param {Partial<import('../../src/types.js').SqlaneOptions<any, never>>} [options]
 * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>}
 */
async function freshSqlane(options = {}) {
    prefixCount++;

    const p = `${database.tablePrefix}${prefixCount}_`;
    /** @type {SqlaneEvent[]} */
    const events = [];
    const sqlane = createSqlane({
        adapter: sequelizeAdapter(queueSequelize),
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

test('enqueue on the instance joins the CLS transaction: it rolls back with it', async () => {
    const { sqlane, p } = await freshSqlane();

    await expect(sequelize.transaction(async () => {
        await sqlane.enqueue(sequelize, 'ping', {}, { jobId: 'rolled_back' });
        throw new Error('rollback');
    })).rejects.toThrow('rollback');
    await sequelize.transaction(async () => {
        await sqlane.enqueue(sequelize, 'ping', {}, { jobId: 'committed' });
        // Not visible before the commit of the CLS transaction
        await expect(statuses(p)).resolves.toStrictEqual([]);
    });

    await expect(statuses(p)).resolves.toStrictEqual(['pending']);
});

test('the commit of the CLS transaction wakes the worker at once', async () => {
    const { sqlane, events } = await freshSqlane({ pollInterval: '10s' });

    sqlane.handle('ping', () => {});
    await sqlane.start();
    await sleep(100);
    await sequelize.transaction(async () => {
        await sqlane.enqueue(sequelize, 'ping', {});
        // The re-probes after the enqueue: 20, 50, 100, 200, then 500 ms
        await sleep(300);
    });

    const committedAt = Date.now();

    await waitFor(() => events.some(event => event.type === 'claimed'));
    expect(Date.now() - committedAt).toBeLessThan(150);
});

test('outside a CLS transaction: a transaction of its own', async () => {
    const { sqlane, p } = await freshSqlane();

    await sqlane.enqueue(sequelize, 'ping', {});
    await expect(statuses(p)).resolves.toStrictEqual(['pending']);
});
