import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import { pgAdapter } from '../../src/adapters/pg.js';
import { createSqlane, defineConcurrencyLimit, defineLane } from '../../src/index.js';
import { createStore } from '../../src/store/store.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';
import { handle, testLane, runnerOf } from '../support/runners.js';

/** @typedef {import('../../src/types.js').Sqlane<any>} Sqlane */

const TIMINGS = { leaseMs: 5000, renewIntervalMs: 500, recoveryIntervalMs: 500 };

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
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

test('lanes.stats: the counts of each name', async () => {
    const p = nextPrefix();
    const sqlane = sqlaneOn(p);
    const store = createStore(testAdapter.adapter, p);

    await sqlane.schema.migrate();
    await sqlane.enqueueMany(testAdapter.pool, testLane('a'), [
        // Wide margins: runAt comes from the clock of this host, and the database compares it with its own
        { payload: {}, options: { runAt: new Date(Date.now() - 60_000) } },
        { payload: {}, options: { runAt: new Date(Date.now() - 30_000) } },
        { payload: {}, options: { delay: '1h' } },
    ]);

    const ids = await Promise.all([1, 2, 3, 4].map(async () => (await sqlane.enqueue(testAdapter.pool, testLane('b'), {})).id));
    const [runningId, failedId, ...completedIds] = ids;
    const { jobs: claimed } = await store.claim({
        candidateIds: ids,
        fullIds: [],
        lockToken: 'TOKEN',
        lockedBy: 'test',
        leaseMs: 60_000,
        pick: locked => locked,
    });

    await store.markTimedOut(/** @type {any} */ (claimed.find(job => job.id === runningId)));
    await store.failJob(/** @type {any} */ (claimed.find(job => job.id === failedId)), {
        error: { name: 'Error', message: 'x' },
        failureJob: { lane: null, build: () => { throw new Error('none'); } },
        attemptUsed: true,
    });
    await store.completeJobs(claimed.filter(job => completedIds.includes(job.id)));

    const stats = await sqlane.lanes.stats();

    expect(stats).toStrictEqual([
        {
            name: 'a',
            pending: 3,
            blocked: 0,
            due: 2,
            running: 0,
            stuck: 0,
            failed: 0,
            completed: 0,
            oldestDueAgeMs: expect.any(Number),
            pausedGlobally: false,
        },
        {
            name: 'b',
            pending: 0,
            blocked: 0,
            due: 0,
            running: 1,
            stuck: 1,
            failed: 1,
            completed: 2,
            oldestDueAgeMs: null,
            pausedGlobally: false,
        },
    ]);
    expect(stats[0].oldestDueAgeMs).toBeGreaterThanOrEqual(50_000);
});

test('lanes.stats: a name with only completed jobs has an entry', async () => {
    const p = nextPrefix();
    const sqlane = sqlaneOn(p);

    await sqlane.schema.migrate();
    await sqlane.enqueue(testAdapter.pool, testLane('done'), {});
    runnerOf(sqlane).mount([handle('done', () => {})]);
    await runnerOf(sqlane).drain();

    await expect(sqlane.lanes.stats()).resolves.toStrictEqual([{
        name: 'done',
        pending: 0,
        blocked: 0,
        due: 0,
        running: 0,
        stuck: 0,
        failed: 0,
        completed: 1,
        oldestDueAgeMs: null,
        pausedGlobally: false,
    }]);
});

describe('hints', () => {
    test('a hint wakes the other process: the job starts at once, not at its next poll', async () => {
        const p = nextPrefix();
        const hint = memoryHint();
        const producer = sqlaneOn(p, { hint });
        const worker = sqlaneOn(p, { hint, pollInterval: '10s' });

        await producer.schema.migrate();
        runnerOf(worker).mount([handle('ping', () => {})]);
        await runnerOf(worker).start();
        await sleep(100);

        const connection = await testAdapter.connect();

        try {
            await connection.begin();
            await producer.enqueue(connection.raw, testLane('ping'), {});
            await sleep(30);
            await connection.commit();
        } finally {
            connection.release();
        }

        await expect(timeUntil(async () => (await statuses(p))[0] === 'completed', 5000))
            .resolves.toBeLessThan(2000);
        expect(hint.published).toContain('ping');
    });

    test('a handler woken by a hint runs in the context of start(), not in the context of the publisher', async () => {
        const p = nextPrefix();
        const hint = memoryHint();
        const producer = sqlaneOn(p, { hint });
        const worker = sqlaneOn(p, { hint, pollInterval: '10s' });
        /** @type {AsyncLocalStorage<{ owner: string }>} */
        const storage = new AsyncLocalStorage();
        /** @type {unknown[]} */
        const stores = [];

        await producer.schema.migrate();
        runnerOf(worker).mount([handle('ping', () => {
            stores.push(storage.getStore());
        })]);
        await storage.run({ owner: 'worker' }, () => runnerOf(worker).start());
        await sleep(100);
        // The memory hint delivers the message in the context of the enqueue
        await storage.run({ owner: 'request' }, () => producer.enqueue(testAdapter.pool, testLane('ping'), {}));

        await expect(timeUntil(async () => (await statuses(p))[0] === 'completed', 5000))
            .resolves.toBeLessThan(2000);
        expect(hint.published).toContain('ping');
        expect(stores).toStrictEqual([{ owner: 'worker' }]);
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

        await producer.schema.migrate();
        await expect(producer.enqueue(testAdapter.pool, testLane('ping'), {})).resolves.toMatchObject({ created: true });
        await sleep(20);
        expect(errors).toMatchObject([{ type: 'error', operation: 'hint_publish' }]);
    });

    test('a freed slot of a global limit wakes the other processes', async () => {
        const p = nextPrefix();
        const hint = memoryHint();
        // Two names with one key: each process handles one, so the second job can only run in the second process
        const order = defineConcurrencyLimit({ name: 'order', max: 1 });
        const firstJob = defineLane({ name: 'sync_first', globalConcurrencyLimits: () => [order.key(1)], timeout: '5s' });
        const secondJob = defineLane({ name: 'sync_second', globalConcurrencyLimits: () => [order.key(1)], timeout: '5s' });
        const first = sqlaneOn(p, { hint, pollInterval: '10s' });
        const second = sqlaneOn(p, { hint, pollInterval: '10s' });
        /** @type {(() => void) | null} */
        let finishFirst = null;

        await first.schema.migrate();
        runnerOf(first).mount([handle(firstJob, () => new Promise((resolve) => {
            finishFirst = () => resolve(undefined);
        }))]);
        runnerOf(second).mount([handle(secondJob, () => {})]);

        await first.enqueue(testAdapter.pool, firstJob, {});
        await runnerOf(first).start();
        await timeUntil(async () => (await statuses(p))[0] === 'running', 5000);
        await runnerOf(second).start();
        await second.enqueue(testAdapter.pool, secondJob, {});
        await sleep(200);
        // The second job is blocked on the key; the first process unblocks it, and its hint wakes the second process
        // before its poll in 10 s
        await expect(statuses(p)).resolves.toStrictEqual(['running', 'blocked']);
        /** @type {() => void} */ (/** @type {unknown} */ (finishFirst))();

        await expect(timeUntil(async () => (await statuses(p)).every(status => status === 'completed'), 5000))
            .resolves.toBeLessThan(2000);
    });

    test.runIf(inject('databaseDialect') === 'postgres')('PostgreSQL NOTIFY: delivered on commit', async () => {
        const p = nextPrefix();
        const adapter = pgAdapter(testAdapter.pool, { dialect: 'postgres', notify: true });
        const producer = sqlaneOn(p, { adapter });
        const worker = sqlaneOn(p, { adapter, pollInterval: '10s' });

        await producer.schema.migrate();
        runnerOf(worker).mount([handle('ping', () => {})]);
        await runnerOf(worker).start();
        await sleep(200);

        const connection = await testAdapter.connect();

        try {
            await connection.begin();
            await producer.enqueue(connection.raw, testLane('ping'), {});
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
