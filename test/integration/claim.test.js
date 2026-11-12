import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createSqlane, defineJob } from '../../src/index.js';
import { probeSql } from '../../src/store/mysql_worker.js';
import { createStore } from '../../src/store/store.js';
import { readsAcrossCommit } from './helpers/isolation.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @typedef {import('../../src/store/store.js').ClaimedJob} ClaimedJob */

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const LINGER_SQL = {
    mysql: p => `INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
                 VALUES (?, 'old', 'old', UTC_TIMESTAMP(3) + INTERVAL ? SECOND, UTC_TIMESTAMP(3))`,
    postgres: p => `INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
                    VALUES ($1, 'old', 'old', clock_timestamp() + $2 * interval '1 second', clock_timestamp())`,
};

const LEASE_MS = 240_000;

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
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

        const rows = (await store.probe(null)).toSorted(byName);

        expect(rows.map(row => row.name)).toStrictEqual(['due_now', 'later']);
        expect(rows[0].delayMs).toBeLessThanOrEqual(-9000);
        expect(rows[1].delayMs).toBeGreaterThan(3_590_000);
    });

    test('of given names: only those with pending jobs', async () => {
        const { sqlane, store } = await freshTables();

        await sqlane.enqueue(testAdapter.pool, 'due_now', {}, { runAt: ago(10) });
        await sqlane.enqueue(testAdapter.pool, 'later', {}, { delay: '1h' });
        await sqlane.enqueue(testAdapter.pool, 'other', {});

        const rows = (await store.probe(['due_now', 'later', 'none'])).toSorted(byName);

        expect(rows.map(row => row.name)).toStrictEqual(['due_now', 'later']);
        expect(rows[0].delayMs).toBeLessThanOrEqual(-9000);
        expect(rows[1].delayMs).toBeGreaterThan(3_590_000);
        await expect(store.probe([])).resolves.toStrictEqual([]);
    });

    test('reads only the names with pending jobs: 1,000 idle names cost nothing', async () => {
        const { p, sqlane, store } = await freshTables();
        const idle = Array.from({ length: 1000 }, (_, index) => `idle_${index}`);

        await Promise.all(idle.map(name => sqlane.enqueue(testAdapter.pool, name, {})));
        await setAllStatus(p, 'completed');
        await sqlane.enqueueMany(testAdapter.pool, 'busy', [{ payload: {} }, { payload: {} }]);

        await expect(store.probe(null)).resolves.toMatchObject([{ name: 'busy' }]);
    });

    test.runIf(inject('databaseDialect') !== 'postgres')('mysql: a loose index scan', async () => {
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

/**
 * A claim of due jobs, with defaults: token TOKEN1, 100 free slots in the process.
 * @param {import('../../src/store/store.js').Store} store
 * @param {Partial<import('../../src/store/store.js').ClaimDueParams>} params
 * @returns {Promise<import('../../src/store/store.js').StartableJob[]>}
 */
async function claimDue(store, params) {
    return (await claimDueWithNext(store, params)).jobs;
}

/**
 * @param {import('../../src/store/store.js').Store} store
 * @param {Partial<import('../../src/store/store.js').ClaimDueParams>} params
 * @returns {Promise<import('../../src/store/store.js').ClaimDueResult>}
 */
function claimDueWithNext(store, params) {
    return store.claimDue({
        requests: [],
        laneFree: [],
        processMax: 100,
        lockToken: 'TOKEN1',
        lockedBy: 'test:TOKEN1',
        leaseMs: LEASE_MS,
        ...params,
    });
}

/**
 * @param {import('../../src/store/store.js').ProbeRow[] | null} next
 * @returns {Record<string, number>}
 */
function delaysByName(next) {
    expect(next).not.toBeNull();

    return Object.fromEntries((next ?? []).map(row => [row.name, row.delayMs]));
}

/**
 * @param {import('../../src/types.js').Executor} executor
 * @param {() => Promise<unknown>} func Runs after the claim statement of claimDue on MySQL and MariaDB, before the next
 *     one.
 * @returns {import('../../src/types.js').Executor}
 */
function afterClaimStatement(executor, func) {
    return {
        ...executor,
        query: async (sql, params) => {
            const rows = await executor.query(sql, params);

            if (sql.includes('SKIP LOCKED')) {
                await func();
            }

            return rows;
        },
    };
}

describe('claimDue', () => {
    test('claims the oldest due jobs of each name, with their payloads, in one go', async () => {
        const { p, sqlane, store } = await freshTables();
        const job = defineJob({ name: 'a', maxAttempts: 4, failureJob: 'a_failed' });
        const a1 = await sqlane.enqueue(testAdapter.pool, job, { n: 1 }, { runAt: ago(30) });
        const b1 = await sqlane.enqueue(testAdapter.pool, 'b', { n: 2 }, { runAt: ago(20) });
        const a2 = await sqlane.enqueue(testAdapter.pool, job, { n: 3 }, { runAt: ago(10) });

        await sqlane.enqueue(testAdapter.pool, job, {}, { runAt: ago(5) });
        await sqlane.enqueue(testAdapter.pool, job, {}, { delay: '1h' });
        await sqlane.enqueue(testAdapter.pool, 'c', {}, { runAt: ago(40) });

        const claimed = await claimDue(store, {
            requests: [{ name: 'a', maxJobs: 2, lane: 0 }, { name: 'b', maxJobs: 5, lane: 1 }],
            laneFree: [2, 5],
        });

        expect(claimed.map(row => [row.id, row.payload])).toStrictEqual([
            [a1.id, { found: true, payload: { n: 1 } }],
            [b1.id, { found: true, payload: { n: 2 } }],
            [a2.id, { found: true, payload: { n: 3 } }],
        ]);
        expect(claimed[0]).toMatchObject({
            name: 'a',
            mutexKeys: [],
            attempts: 0,
            maxAttempts: 4,
            failureJob: 'a_failed',
            lockToken: 'TOKEN1',
        });
        expect(claimed[0].waitedMs).toBeGreaterThanOrEqual(29_000);

        const rows = await database.query(`SELECT id, status, lock_token, locked_by FROM ${p}jobs WHERE status = 'running'`);

        expect(rows.map(row => row.id).toSorted()).toStrictEqual([a1.id, b1.id, a2.id].toSorted());
        expect(rows[0]).toMatchObject({ lock_token: 'TOKEN1', locked_by: 'test:TOKEN1' });
    });

    test('gives the next due time of the requested names, among the jobs that it did not take', async () => {
        const { sqlane, store } = await freshTables();

        await sqlane.enqueue(testAdapter.pool, 'a', {}, { runAt: ago(30) });
        await sqlane.enqueue(testAdapter.pool, 'a', {}, { runAt: ago(20) });
        await sqlane.enqueue(testAdapter.pool, 'a', {}, { delay: '1h' });
        await sqlane.enqueue(testAdapter.pool, 'b', {}, { runAt: ago(10) });
        await sqlane.enqueue(testAdapter.pool, 'c', {}, { runAt: ago(10) });

        const first = await claimDueWithNext(store, {
            requests: [{ name: 'a', maxJobs: 1, lane: 0 }, { name: 'b', maxJobs: 1, lane: 0 }],
            laneFree: [5],
        });

        expect(first.jobs.map(job => job.name)).toStrictEqual(['a', 'b']);
        // a: one due job left; b: none left; c: not requested
        expect(Object.keys(delaysByName(first.next)).filter(name => name !== 'c')).toStrictEqual(['a']);
        expect(delaysByName(first.next).a).toBeLessThanOrEqual(-19_000);

        const second = await claimDueWithNext(store, { requests: [{ name: 'a', maxJobs: 5, lane: 0 }], laneFree: [5] });

        expect(second.jobs).toHaveLength(1);
        expect(delaysByName(second.next).a).toBeGreaterThan(3_590_000);
    });

    test('a claim that fills the free process slots does not read the next due times', async () => {
        const { sqlane, store } = await freshTables();

        await Promise.all(['a', 'b', 'c'].map(name => sqlane.enqueue(testAdapter.pool, name, {}, { runAt: ago(10) })));

        const requests = ['a', 'b', 'c'].map(name => ({ name, maxJobs: 2, lane: 0 }));
        const full = await claimDueWithNext(store, { requests, laneFree: [2], processMax: 2 });

        expect(full.jobs).toHaveLength(2);
        expect(full.next).toBeNull();

        const rest = await claimDueWithNext(store, { requests, laneFree: [2], processMax: 2 });

        expect(rest.jobs).toHaveLength(1);
        expect(rest.next).toStrictEqual([]);
    });

    test('the free slots of each lane and of the process, oldest first', async () => {
        const { sqlane, store } = await freshTables();
        const a1 = await sqlane.enqueue(testAdapter.pool, 'a', {}, { runAt: ago(50) });
        const b1 = await sqlane.enqueue(testAdapter.pool, 'b', {}, { runAt: ago(40) });
        const c1 = await sqlane.enqueue(testAdapter.pool, 'c', {}, { runAt: ago(35) });

        await sqlane.enqueue(testAdapter.pool, 'a', {}, { runAt: ago(30) });
        await sqlane.enqueue(testAdapter.pool, 'c', {}, { runAt: ago(20) });

        // a and b share lane 0 (1 free slot); c has lane 1; the process has 2 free slots
        const claimed = await claimDue(store, {
            requests: [
                { name: 'a', maxJobs: 1, lane: 0 },
                { name: 'b', maxJobs: 1, lane: 0 },
                { name: 'c', maxJobs: 2, lane: 1 },
            ],
            laneFree: [1, 2],
            processMax: 2,
        });

        expect(claimed.map(row => row.id)).toStrictEqual([a1.id, c1.id]);
        // The jobs that did not fit stay pending, unlocked
        await expect(claimDue(store, {
            requests: [{ name: 'b', maxJobs: 1, lane: 0 }],
            laneFree: [1],
            lockToken: 'TOKEN2',
        })).resolves.toMatchObject([{ id: b1.id }]);
    });

    test('concurrent claims never take the same job', async () => {
        const { sqlane, store } = await freshTables();
        const results = await sqlane.enqueueMany(
            testAdapter.pool,
            'busy',
            Array.from({ length: 40 }, () => ({ payload: {}, options: { runAt: ago(5) } })),
        );
        const claims = await Promise.all(['T1', 'T2', 'T3', 'T4'].map(token => claimDue(store, {
            requests: [{ name: 'busy', maxJobs: 15, lane: 0 }],
            laneFree: [15],
            lockToken: token,
        })));
        const claimedIds = claims.flatMap(jobs => jobs.map(job => job.id));

        expect(new Set(claimedIds).size).toBe(claimedIds.length);
        expect(claimedIds).toHaveLength(40);
        expect(results.map(result => result.id)).toStrictEqual(expect.arrayContaining(claimedIds));
    });

    test('a job without its payload row: claimed, the payload not found', async () => {
        const { p, sqlane, store } = await freshTables();
        const { id } = await sqlane.enqueue(testAdapter.pool, 'a', { n: 1 }, { runAt: ago(5) });

        await database.query(`DELETE FROM ${p}payloads`);

        await expect(claimDue(store, { requests: [{ name: 'a', maxJobs: 1, lane: 0 }], laneFree: [1] }))
            .resolves.toMatchObject([{ id, payload: { found: false } }]);
    });

    test('the queue transaction is READ COMMITTED', async () => {
        await expect(readsAcrossCommit(testAdapter.adapter, database)).resolves.toStrictEqual([0, 1]);
    });

    // The claim statement reads the payloads without a lock (MySQL: `FOR UPDATE OF j`; MariaDB: a subquery), from its
    // first read view: an enqueue that commits later in the statement has its job locked, its payload not seen. Here it
    // commits right after.
    test.runIf(inject('databaseDialect') !== 'postgres')('mysql, mariadb: a payload that the claim statement did not see: read again', async () => {
        const { p, sqlane } = await freshTables();
        const { id } = await sqlane.enqueue(testAdapter.pool, 'a', { n: 1 }, { runAt: ago(5) });
        const { adapter } = testAdapter;

        await database.query(`DELETE FROM ${p}payloads`);

        const store = createStore({
            ...adapter,
            queueTransaction: func => adapter.queueTransaction(executor => func(afterClaimStatement(executor, () =>
                database.query(`INSERT INTO ${p}payloads (id, payload) VALUES (?, '{"n": 1}')`, [id])))),
        }, p);

        await expect(claimDue(store, { requests: [{ name: 'a', maxJobs: 1, lane: 0 }], laneFree: [1] }))
            .resolves.toMatchObject([{ id, payload: { found: true, payload: { n: 1 } } }]);
    });
});

describe('mutex keys', () => {
    const syncOrder = defineJob({ name: 'sync_order', mutexKeys: payload => [`order:${payload.orderId}`], timeout: '1m' });
    const other = defineJob({ name: 'ship_order', mutexKeys: payload => [`order:${payload.orderId}`], timeout: '1m' });

    test('a held key: the job waits; a free key: it runs', async () => {
        const { sqlane, store } = await freshTables();
        const first = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 1 }, { runAt: ago(30) });

        await claimAll(store, [first.id], 'T1');

        const blocked = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 1 }, { runAt: ago(20) });
        const free = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 2 }, { runAt: ago(10) });
        const candidates = await store.findCandidates(new Map([['sync_order', 10]]), ['sync_order']);

        expect(candidates.map(candidate => candidate.id)).toStrictEqual([free.id]);
        await expect(claimAll(store, [blocked.id, free.id], 'T2')).resolves.toMatchObject([{ id: free.id }]);
    });

    test('FIFO per key, across the names with mutex keys: a newer job waits behind an older one with its key', async () => {
        const { sqlane, store } = await freshTables();
        const older = await sqlane.enqueue(testAdapter.pool, other, { orderId: 1 }, { runAt: ago(30) });
        const newer = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 1 }, { runAt: ago(20) });
        const namesWithKeys = ['sync_order', 'ship_order'];

        await expect(store.findCandidates(new Map([['sync_order', 10]]), namesWithKeys)).resolves.toStrictEqual([]);
        await expect(store.findCandidates(new Map([['ship_order', 10]]), namesWithKeys))
            .resolves.toMatchObject([{ id: older.id }]);
        // A name that this process does not handle does not block
        await expect(store.findCandidates(new Map([['sync_order', 10]]), ['sync_order']))
            .resolves.toMatchObject([{ id: newer.id }]);
    });

    test('a release of keys: the names of the oldest due job of each key, among the names with mutex keys', async () => {
        const { sqlane, store } = await freshTables();
        const namesWithKeys = ['sync_order', 'ship_order'];

        await sqlane.enqueue(testAdapter.pool, other, { orderId: 1 }, { runAt: ago(30) });
        await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 1 }, { runAt: ago(20) });
        await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 2 }, { runAt: ago(10) });
        // Not due: it waits for its time, not for the key
        await sqlane.enqueue(testAdapter.pool, other, { orderId: 3 }, { delay: '1h' });

        await expect(store.namesWaitingFor(['order:1'], namesWithKeys)).resolves.toStrictEqual(['ship_order']);
        await expect(store.namesWaitingFor(['order:1'], ['sync_order'])).resolves.toStrictEqual(['sync_order']);
        await expect(store.namesWaitingFor(['order:1', 'order:2'], namesWithKeys).then(names => names.toSorted()))
            .resolves.toStrictEqual(['ship_order', 'sync_order']);
        await expect(store.namesWaitingFor(['order:3', 'order:4'], namesWithKeys)).resolves.toStrictEqual([]);
    });

    test('FIFO per key with two keys: a job waits behind an older one with either key', async () => {
        const { sqlane, store } = await freshTables();
        const older = await sqlane.enqueue(testAdapter.pool, 'both', {}, { mutexKeys: ['b'], runAt: ago(30) });

        // The second waits for the first (key b), the third for the second (key a)
        await sqlane.enqueue(testAdapter.pool, 'both', {}, { mutexKeys: ['a', 'b'], runAt: ago(20) });
        await sqlane.enqueue(testAdapter.pool, 'both', {}, { mutexKeys: ['a'], runAt: ago(10) });
        const candidates = await store.findCandidates(new Map([['both', 10]]), ['both']);

        expect(candidates.map(candidate => candidate.id)).toStrictEqual([older.id]);
    });

    test('job_keys: a row per key of each pending job', async () => {
        const { p, sqlane, store } = await freshTables();
        const listKeys = () => database.query(`SELECT mutex_key, job_id FROM ${p}job_keys ORDER BY mutex_key, job_id`);
        const retried = await sqlane.enqueue(testAdapter.pool, 'both', {}, { mutexKeys: ['a', 'b'], runAt: ago(30) });
        const released = await sqlane.enqueue(testAdapter.pool, 'one', {}, { mutexKeys: ['c'], runAt: ago(20) });
        const plain = await sqlane.enqueue(testAdapter.pool, 'plain', {}, { mutexKeys: ['d'], runAt: ago(10) });

        await sqlane.enqueue(testAdapter.pool, 'plain', {}, { runAt: ago(5) });
        await expect(listKeys()).resolves.toStrictEqual([
            { mutex_key: 'a', job_id: retried.id },
            { mutex_key: 'b', job_id: retried.id },
            { mutex_key: 'c', job_id: released.id },
            { mutex_key: 'd', job_id: plain.id },
        ]);

        // A claim deletes them: the claim of jobs with mutex keys, and the claim of a name without keys
        const claimed = await claimAll(store, [retried.id, released.id], 'T1');

        await claimDue(store, { requests: [{ name: 'plain', maxJobs: 2, lane: 0 }], laneFree: [2] });
        await expect(listKeys()).resolves.toStrictEqual([]);

        // Pending again: they are back
        await expect(store.retryJob(claimed[0], { delayMs: 0, error: { name: 'Error', message: 'again' } }))
            .resolves.toBe(true);
        await expect(store.releaseJob(claimed[1], { delayMs: 0, lingerMs: 0 })).resolves.toBe(true);
        await expect(listKeys()).resolves.toStrictEqual([
            { mutex_key: 'a', job_id: retried.id },
            { mutex_key: 'b', job_id: retried.id },
            { mutex_key: 'c', job_id: released.id },
        ]);
        await expect(store.namesWaitingFor(['a', 'c'], ['both', 'one']).then(names => names.toSorted()))
            .resolves.toStrictEqual(['both', 'one']);
    });

    test('concurrent claims of two jobs with a common key: one gets it', async () => {
        const { p, sqlane, store } = await freshTables();
        const a = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 7 }, { runAt: ago(20) });
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

        await database.query(LINGER_SQL[database.family](p), ['order:1', 3600]);
        await database.query(LINGER_SQL[database.family](p), ['order:2', -1]);

        const lingering = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 1 }, { runAt: ago(20) });
        const ended = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 2 }, { runAt: ago(10) });
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
