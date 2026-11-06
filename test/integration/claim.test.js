import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createSqlane, defineJob } from '../../src/index.js';
import { probeSql } from '../../src/store/mysql_worker.js';
import { createStore } from '../../src/store/store.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from './helpers/test_database.js';

/** @typedef {import('../../src/store/store.js').ClaimedJob} ClaimedJob */

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const LINGER_SQL = {
    mysql: p => `INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
                 VALUES (?, 'old', 'old', UTC_TIMESTAMP(3) + INTERVAL ? SECOND, UTC_TIMESTAMP(3))`,
    postgres: p => `INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
                    VALUES ($1, 'old', 'old', clock_timestamp() + $2 * interval '1 second', clock_timestamp())`,
};

const LEASE_MS = 240_000;

/** @type {import('./helpers/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
let prefixCount = 0;

beforeAll(async () => {
    database = await connectTestDatabase();
    testAdapter = createTestAdapter();
});

afterAll(async () => {
    await testAdapter?.close();
    await database?.close();
});

/**
 * Tables of their own for a test.
 * @returns {Promise<{
 *     p: string,
 *     sqlane: import('../../src/types.js').Sqlane<any, never>,
 *     store: import('../../src/store/store.js').Store,
 * }>}
 */
async function freshTables() {
    prefixCount++;

    const p = `${database.tablePrefix}${prefixCount}_`;
    const sqlane = createSqlane({ adapter: testAdapter.adapter, tablePrefix: p });

    await sqlane.migrate();

    return { p, sqlane, store: createStore(testAdapter.adapter, p) };
}

/**
 * @param {{ name: string }} a
 * @param {{ name: string }} b
 * @returns {number}
 */
function byName(a, b) {
    return a.name < b.name ? -1 : 1;
}

/**
 * @param {number} secondsAgo
 * @returns {Date}
 */
function ago(secondsAgo) {
    return new Date(Date.now() - (secondsAgo * 1000));
}

/**
 * Picks the locked jobs whose keys are free, oldest first; a passed-over job keeps its keys from the newer ones.
 * @param {ClaimedJob[]} locked
 * @param {Set<string>} busyKeys
 * @returns {ClaimedJob[]}
 */
function pickFree(locked, busyKeys) {
    const seen = new Set(busyKeys);

    return locked.filter((job) => {
        const free = job.mutexKeys.every(key => !seen.has(key));

        for (const key of job.mutexKeys) {
            seen.add(key);
        }

        return free;
    });
}

/**
 * @param {import('../../src/store/store.js').Store} store
 * @param {string[]} candidateIds
 * @param {string} lockToken
 * @returns {Promise<ClaimedJob[]>}
 */
function claimAll(store, candidateIds, lockToken) {
    return store.claim({ candidateIds, lockToken, lockedBy: `test:${lockToken}`, leaseMs: LEASE_MS, pick: pickFree });
}

/**
 * @param {string} p
 * @param {string} status
 * @returns {Promise<void>}
 */
async function setAllStatus(p, status) {
    await database.query(`UPDATE ${p}jobs SET status = '${status}'`);
}

describe('probe', () => {
    test('gives the pending names and the delay of their oldest job', async () => {
        const { sqlane, store } = await freshTables();

        await sqlane.enqueue(testAdapter.pool, 'due_now', {}, { runAt: ago(10) });
        await sqlane.enqueue(testAdapter.pool, 'due_now', {}, { delay: '1h' });
        await sqlane.enqueue(testAdapter.pool, 'later', {}, { delay: '1h' });

        const rows = (await store.probe()).toSorted(byName);

        expect(rows.map(row => row.name)).toStrictEqual(['due_now', 'later']);
        expect(rows[0].delayMs).toBeLessThanOrEqual(-9000);
        expect(rows[1].delayMs).toBeGreaterThan(3_590_000);
    });

    test('reads only the names with pending jobs: 1,000 idle names cost nothing', async () => {
        const { p, sqlane, store } = await freshTables();
        const idle = Array.from({ length: 1000 }, (_, index) => `idle_${index}`);

        await Promise.all(idle.map(name => sqlane.enqueue(testAdapter.pool, name, {})));
        await setAllStatus(p, 'completed');
        await sqlane.enqueueMany(testAdapter.pool, 'busy', [{ payload: {} }, { payload: {} }]);

        await expect(store.probe()).resolves.toMatchObject([{ name: 'busy' }]);
    });

    test.runIf(inject('databaseDialect') === 'mysql')('mysql: a loose index scan', async () => {
        const { p, sqlane } = await freshTables();
        const items = Array.from({ length: 2000 }, (_, index) => ({ payload: {}, options: { jobId: `j${index}` } }));

        await Promise.all(Array.from({ length: 20 }, (_, index) => sqlane.enqueueMany(testAdapter.pool, `n${index}`, items)));
        await database.query(`ANALYZE TABLE ${p}jobs`);

        const [plan] = await database.query(`EXPLAIN ${probeSql(p)}`);

        expect(plan.Extra).toContain('Using index for group-by');
    });
});

describe('findCandidates', () => {
    test('the oldest due jobs of each name, at most its limit', async () => {
        const { sqlane, store } = await freshTables();
        const a1 = await sqlane.enqueue(testAdapter.pool, 'a', {}, { runAt: ago(30) });
        const b1 = await sqlane.enqueue(testAdapter.pool, 'b', {}, { runAt: ago(20) });
        const a2 = await sqlane.enqueue(testAdapter.pool, 'a', {}, { runAt: ago(10) });

        await sqlane.enqueue(testAdapter.pool, 'a', {}, { runAt: ago(5) });
        await sqlane.enqueue(testAdapter.pool, 'a', {}, { delay: '1h' });
        await sqlane.enqueue(testAdapter.pool, 'c', {}, { runAt: ago(40) });

        const candidates = await store.findCandidates(new Map([['a', 2], ['b', 5]]), []);

        expect(candidates.map(candidate => candidate.id)).toStrictEqual([a1.id, b1.id, a2.id]);
    });
});

describe('claim', () => {
    test('locks the jobs, sets them running with a lease, reads their payloads', async () => {
        const { p, sqlane, store } = await freshTables();
        const job = defineJob({ name: 'build', maxAttempts: 4, failureJob: 'build_failed' });
        const { id } = await sqlane.enqueue(testAdapter.pool, job, { reportId: 'r1' }, { runAt: ago(5) });
        const [claimed] = await claimAll(store, [id], 'TOKEN1');

        expect(claimed).toMatchObject({
            id,
            name: 'build',
            mutexKeys: [],
            attempts: 0,
            maxAttempts: 4,
            stalls: 0,
            maxStalls: 2,
            failureJob: 'build_failed',
            lockToken: 'TOKEN1',
        });
        expect(claimed.waitedMs).toBeGreaterThanOrEqual(4000);
        expect(Math.abs(claimed.enqueuedAt.getTime() - Date.now())).toBeLessThan(10_000);

        const [row] = await database.query(`SELECT status, lock_token, locked_by FROM ${p}jobs`);

        expect(row).toStrictEqual({ status: 'running', lock_token: 'TOKEN1', locked_by: 'test:TOKEN1' });
        await expect(store.readPayloads([id])).resolves.toStrictEqual(new Map([[id, { reportId: 'r1' }]]));
        await expect(claimAll(store, [id], 'TOKEN2')).resolves.toStrictEqual([]);
    });

    test('concurrent claims never take the same job', async () => {
        const { sqlane, store } = await freshTables();
        const results = await sqlane.enqueueMany(
            testAdapter.pool,
            'busy',
            Array.from({ length: 40 }, () => ({ payload: {}, options: { runAt: ago(5) } })),
        );
        const ids = results.map(result => result.id);
        const claims = await Promise.all(['T1', 'T2', 'T3', 'T4'].map(token => claimAll(store, ids, token)));
        const claimedIds = claims.flatMap(jobs => jobs.map(job => job.id));

        expect(claimedIds.toSorted()).toStrictEqual(ids.toSorted());
    });
});

describe('mutex keys', () => {
    const keyed = defineJob({ name: 'sync_order', mutexKeys: payload => [`order:${payload.orderId}`], timeout: '1m' });
    const other = defineJob({ name: 'ship_order', mutexKeys: payload => [`order:${payload.orderId}`], timeout: '1m' });

    test('a held key: the job waits; a free key: it runs', async () => {
        const { sqlane, store } = await freshTables();
        const first = await sqlane.enqueue(testAdapter.pool, keyed, { orderId: 1 }, { runAt: ago(30) });

        await claimAll(store, [first.id], 'T1');

        const blocked = await sqlane.enqueue(testAdapter.pool, keyed, { orderId: 1 }, { runAt: ago(20) });
        const free = await sqlane.enqueue(testAdapter.pool, keyed, { orderId: 2 }, { runAt: ago(10) });
        const candidates = await store.findCandidates(new Map([['sync_order', 10]]), ['sync_order']);

        expect(candidates.map(candidate => candidate.id)).toStrictEqual([free.id]);
        await expect(claimAll(store, [blocked.id, free.id], 'T2')).resolves.toMatchObject([{ id: free.id }]);
    });

    test('FIFO per key, across the keyed names: a newer job waits behind an older one with its key', async () => {
        const { sqlane, store } = await freshTables();
        const older = await sqlane.enqueue(testAdapter.pool, other, { orderId: 1 }, { runAt: ago(30) });
        const newer = await sqlane.enqueue(testAdapter.pool, keyed, { orderId: 1 }, { runAt: ago(20) });
        const keyedNames = ['sync_order', 'ship_order'];

        await expect(store.findCandidates(new Map([['sync_order', 10]]), keyedNames)).resolves.toStrictEqual([]);
        await expect(store.findCandidates(new Map([['ship_order', 10]]), keyedNames))
            .resolves.toMatchObject([{ id: older.id }]);
        // A name that this process does not handle does not block
        await expect(store.findCandidates(new Map([['sync_order', 10]]), ['sync_order']))
            .resolves.toMatchObject([{ id: newer.id }]);
    });

    test('concurrent claims of two jobs with a common key: one gets it', async () => {
        const { p, sqlane, store } = await freshTables();
        const a = await sqlane.enqueue(testAdapter.pool, keyed, { orderId: 7 }, { runAt: ago(20) });
        const b = await sqlane.enqueue(testAdapter.pool, other, { orderId: 7 }, { runAt: ago(10) });
        const claims = await Promise.all([claimAll(store, [a.id], 'T1'), claimAll(store, [b.id], 'T2')]);

        expect(claims.flat()).toHaveLength(1);
        await expect(database.query(`SELECT mutex_key, job_id FROM ${p}mutexes`))
            .resolves.toStrictEqual([{ mutex_key: 'order:7', job_id: claims.flat()[0].id }]);
    });

    test('a job takes all its keys or none', async () => {
        const { p, sqlane, store } = await freshTables();
        const holder = await sqlane.enqueue(testAdapter.pool, 'holder', {}, { mutexKeys: ['b'], runAt: ago(30) });

        await claimAll(store, [holder.id], 'T1');

        const both = await sqlane.enqueue(testAdapter.pool, 'both', {}, { mutexKeys: ['a', 'b'], runAt: ago(20) });

        // pick ignores the busy keys: the claim itself refuses the job
        await expect(store.claim({
            candidateIds: [both.id],
            lockToken: 'T2',
            lockedBy: 'test',
            leaseMs: LEASE_MS,
            pick: locked => locked,
        })).resolves.toStrictEqual([]);
        await expect(database.query(`SELECT mutex_key, lock_token FROM ${p}mutexes`))
            .resolves.toStrictEqual([{ mutex_key: 'b', lock_token: 'T1' }]);
    });

    test('a linger blocks the key until held_until, then a claim takes it over', async () => {
        const { p, sqlane, store } = await freshTables();

        await database.query(LINGER_SQL[database.dialect](p), ['order:1', 3600]);
        await database.query(LINGER_SQL[database.dialect](p), ['order:2', -1]);

        const lingering = await sqlane.enqueue(testAdapter.pool, keyed, { orderId: 1 }, { runAt: ago(20) });
        const ended = await sqlane.enqueue(testAdapter.pool, keyed, { orderId: 2 }, { runAt: ago(10) });
        const candidates = await store.findCandidates(new Map([['sync_order', 10]]), ['sync_order']);

        expect(candidates.map(candidate => candidate.id)).toStrictEqual([ended.id]);
        await expect(claimAll(store, [lingering.id, ended.id], 'T1')).resolves.toMatchObject([{ id: ended.id }]);
        await expect(database.query(`SELECT mutex_key, lock_token FROM ${p}mutexes ORDER BY mutex_key`))
            .resolves.toStrictEqual([
                { mutex_key: 'order:1', lock_token: 'old' },
                { mutex_key: 'order:2', lock_token: 'T1' },
            ]);
    });
});
