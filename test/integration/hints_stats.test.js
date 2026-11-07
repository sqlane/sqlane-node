import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import { pgAdapter } from '../../src/adapters/pg.js';
import { createSqlane, defineJob } from '../../src/index.js';
import { createStore } from '../../src/store/store.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from './helpers/test_database.js';

/** @typedef {import('../../src/types.js').Sqlane<any, any>} Sqlane */

const TIMINGS = { leaseMs: 5000, renewIntervalMs: 500, recoveryIntervalMs: 500 };

/** @type {import('./helpers/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];

beforeAll(async () => {
    database = await connectTestDatabase();
    testAdapter = createTestAdapter();
});

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await testAdapter?.close();
    await database?.close();
});

/** @returns {string} A table prefix of its own. */
function nextPrefix() {
    prefixCount++;

    return `${database.tablePrefix}${prefixCount}_`;
}

/**
 * @param {string} tablePrefix
 * @param {Record<string, unknown>} [options]
 * @returns {Sqlane}
 */
function sqlaneOn(tablePrefix, options = {}) {
    const sqlane = createSqlane(/** @type {any} */ ({
        adapter: testAdapter.adapter,
        tablePrefix,
        timings: TIMINGS,
        ...options,
    }));

    instances.push(sqlane);

    return sqlane;
}

/**
 * A pub/sub in memory, shared by the instances of a test, as Redis would be.
 * @returns {import('../../src/types.js').Hint & { published: string[] }}
 */
function memoryHint() {
    const bus = new EventEmitter();
    /** @type {string[]} */
    const published = [];

    return {
        published,
        publish: async (channel, message) => {
            published.push(message);
            bus.emit(channel, message);
        },
        subscribe: async (channel, onMessage) => {
            bus.on(channel, onMessage);

            return async () => {
                bus.off(channel, onMessage);
            };
        },
    };
}

/**
 * @param {string} p
 * @returns {Promise<string[]>} The statuses, in the order of creation.
 */
async function statuses(p) {
    return (await database.query(`SELECT status FROM ${p}jobs ORDER BY created_at, id`)).map(row => String(row.status));
}

/**
 * @param {() => Promise<boolean>} condition
 * @param {number} timeoutMs
 * @returns {Promise<number>} The milliseconds it took.
 */
async function timeUntil(condition, timeoutMs) {
    const startedAt = Date.now();

    // oxlint-disable-next-line no-await-in-loop -- polls
    while (!await condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('timeUntil: timed out');
        }

        // oxlint-disable-next-line no-await-in-loop -- polls
        await sleep(10);
    }

    return Date.now() - startedAt;
}

test('getStats: the counts of each name', async () => {
    const p = nextPrefix();
    const sqlane = sqlaneOn(p);
    const store = createStore(testAdapter.adapter, p);

    await sqlane.migrate();
    await sqlane.enqueueMany(testAdapter.pool, 'a', [
        { payload: {}, options: { runAt: new Date(Date.now() - 5000) } },
        { payload: {}, options: { runAt: new Date(Date.now() - 1000) } },
        { payload: {}, options: { delay: '1h' } },
    ]);

    const { id: runningId } = await sqlane.enqueue(testAdapter.pool, 'b', {});
    const { id: failedId } = await sqlane.enqueue(testAdapter.pool, 'b', {});
    const claimed = await store.claim({
        candidateIds: [runningId, failedId],
        lockToken: 'TOKEN',
        lockedBy: 'test',
        leaseMs: 60_000,
        pick: locked => locked,
    });

    await store.markTimedOut(/** @type {any} */ (claimed.find(job => job.id === runningId)));
    await store.failJob(/** @type {any} */ (claimed.find(job => job.id === failedId)), {
        error: { name: 'Error', message: 'x' },
        buildFailureJob: () => {
            throw new Error('none');
        },
    });

    const stats = await sqlane.getStats();

    expect(stats).toMatchObject([
        { name: 'a', pending: 3, due: 2, running: 0, stuck: 0, failed: 0 },
        { name: 'b', pending: 0, due: 0, running: 1, stuck: 1, failed: 1, oldestDueAgeMs: null },
    ]);
    expect(stats[0].oldestDueAgeMs).toBeGreaterThanOrEqual(4500);
});

describe('hints', () => {
    test('a hint wakes the other process: the job starts at once, not at its next poll', async () => {
        const p = nextPrefix();
        const hint = memoryHint();
        const producer = sqlaneOn(p, { hint });
        const worker = sqlaneOn(p, { hint, pollInterval: '10s' });

        await producer.migrate();
        worker.handle('ping', () => {});
        await worker.start();
        await sleep(100);

        const connection = await testAdapter.connect();

        try {
            await connection.begin();
            await producer.enqueue(connection.raw, 'ping', {});
            await sleep(30);
            await connection.commit();
        } finally {
            connection.release();
        }

        await expect(timeUntil(async () => (await statuses(p))[0] === 'completed', 5000))
            .resolves.toBeLessThan(2000);
        expect(hint.published).toContain('ping');
    });

    test('a hint that fails does not fail the enqueue', async () => {
        const p = nextPrefix();
        /** @type {unknown[]} */
        const errors = [];
        const producer = sqlaneOn(p, {
            hint: {
                publish: async () => {
                    throw new Error('redis is down');
                },
                subscribe: async () => async () => {},
            },
            onEvent: (/** @type {import('../../src/types.js').SqlaneEvent} */ event) => {
                errors.push(event);
            },
        });

        await producer.migrate();
        await expect(producer.enqueue(testAdapter.pool, 'ping', {})).resolves.toMatchObject({ created: true });
        await sleep(20);
        expect(errors).toMatchObject([{ type: 'error', operation: 'hint_publish' }]);
    });

    test('freed mutex keys wake the other processes', async () => {
        const p = nextPrefix();
        const hint = memoryHint();
        // Two names with one key: each process handles one, so the second job can only run in the second process
        const firstJob = defineJob({ name: 'sync_first', mutexKeys: () => ['order:1'], timeout: '5s' });
        const secondJob = defineJob({ name: 'sync_second', mutexKeys: () => ['order:1'], timeout: '5s' });
        const first = sqlaneOn(p, { hint, pollInterval: '10s' });
        const second = sqlaneOn(p, { hint, pollInterval: '10s' });
        /** @type {(() => void) | null} */
        let finishFirst = null;

        await first.migrate();
        first.handle(firstJob, () => new Promise((resolve) => {
            finishFirst = () => resolve(undefined);
        }));
        second.handle(secondJob, () => {});

        await first.enqueue(testAdapter.pool, firstJob, {});
        await first.start();
        await timeUntil(async () => (await statuses(p))[0] === 'running', 5000);
        await second.start();
        await second.enqueue(testAdapter.pool, secondJob, {});
        await sleep(200);
        // The second job waits for the key, until the second process polls in 10 s
        await expect(statuses(p)).resolves.toStrictEqual(['running', 'pending']);
        /** @type {() => void} */ (/** @type {unknown} */ (finishFirst))();

        await expect(timeUntil(async () => (await statuses(p)).every(status => status === 'completed'), 5000))
            .resolves.toBeLessThan(2000);
    });

    test.runIf(inject('databaseDialect') === 'postgres')('PostgreSQL NOTIFY: delivered on commit', async () => {
        const p = nextPrefix();
        const adapter = pgAdapter(testAdapter.pool, { notify: true });
        const producer = sqlaneOn(p, { adapter });
        const worker = sqlaneOn(p, { adapter, pollInterval: '10s' });

        await producer.migrate();
        worker.handle('ping', () => {});
        await worker.start();
        await sleep(200);

        const connection = await testAdapter.connect();

        try {
            await connection.begin();
            await producer.enqueue(connection.raw, 'ping', {});
            await sleep(300);
            // Not delivered before the commit
            await expect(statuses(p)).resolves.toStrictEqual([]);
            await connection.commit();
        } finally {
            connection.release();
        }

        await expect(timeUntil(async () => (await statuses(p))[0] === 'completed', 5000))
            .resolves.toBeLessThan(1000);
    });
});
