import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { chooseRows } from '../../src/fair_share.js';
import { incrementUs, waitUs } from '../../src/gcra.js';
import { createSqlane, defineConcurrencyLimit, defineJob, defineRateLimit } from '../../src/index.js';
import { probeSql } from '../../src/store/mysql_worker.js';
import { createStore } from '../../src/store/store.js';
import { readsAcrossCommit } from './helpers/isolation.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @typedef {import('../../src/store/store.js').ClaimedJob} ClaimedJob */

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const LINGER_SQL = {
    mysql: p => `INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
                 VALUES (?, 0, 'old', 'old', UTC_TIMESTAMP(3) + INTERVAL ? SECOND, UTC_TIMESTAMP(3))`,
    postgres: p => `INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
                    VALUES ($1, 0, 'old', 'old', clock_timestamp() + $2 * interval '1 second', clock_timestamp())`,
};

/**
 * Sets the tat of a rate key to `$2` seconds ago (negative: ahead).
 * @type {Record<'mysql' | 'postgres', (p: string) => string>}
 */
const SET_TAT_SQL = {
    mysql: p => `INSERT INTO ${p}rate_limits (limit_key, tat) VALUES (?, UTC_TIMESTAMP(6) - INTERVAL ? SECOND)
                 ON DUPLICATE KEY UPDATE tat = VALUES(tat)`,
    postgres: p => `INSERT INTO ${p}rate_limits (limit_key, tat) VALUES ($1, clock_timestamp() - $2 * interval '1 second')
                    ON CONFLICT (limit_key) DO UPDATE SET tat = EXCLUDED.tat`,
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
 *     sqlane: import('../../src/types.js').Sqlane<any>,
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
 * Picks the locked jobs whose keys have room and whose rate keys have quota, oldest first, counting the picked ones.
 * @param {ClaimedJob[]} locked
 * @param {Map<string, number>} held
 * @param {Map<string, number>} debts
 * @returns {ClaimedJob[]}
 */
function pickFits(locked, held, debts) {
    const counts = new Map(held);
    const used = new Map(debts);

    return locked.filter((job) => {
        const fits = job.limits.every(({ key, max }) => (counts.get(key) ?? 0) < max)
            && job.rateLimits.every(limit => waitUs(used.get(limit.key) ?? 0, limit) <= 0);

        for (const { key } of fits ? job.limits : []) {
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        for (const limit of fits ? job.rateLimits : []) {
            used.set(limit.key, (used.get(limit.key) ?? 0) + incrementUs(limit));
        }

        return fits;
    });
}

/**
 * @param {import('../../src/store/store.js').Store} store
 * @param {string[]} candidateIds
 * @param {string} lockToken
 * @param {string[]} [fullIds]
 * @returns {Promise<import('../../src/store/store.js').ClaimResult>}
 */
function claimWithBlocks(store, candidateIds, lockToken, fullIds = []) {
    return store.claim({
        candidateIds,
        fullIds,
        lockToken,
        lockedBy: `test:${lockToken}`,
        leaseMs: LEASE_MS,
        pick: pickFits,
    });
}

/**
 * @param {import('../../src/store/store.js').Store} store
 * @param {string[]} candidateIds
 * @param {string} lockToken
 * @returns {Promise<ClaimedJob[]>}
 */
async function claimAll(store, candidateIds, lockToken) {
    return (await claimWithBlocks(store, candidateIds, lockToken)).jobs;
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

        const { startable, full } = await store.findCandidates(new Map([['a', 2], ['b', 5]]));

        expect(startable.map(candidate => candidate.id)).toStrictEqual([a1.id, b1.id, a2.id]);
        expect(full).toStrictEqual([]);
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
            limits: [],
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
    const requests = params.requests ?? [];
    const limitRooms = params.limitRooms ?? [];
    const free = params.free ?? 100;

    return store.claimDue({
        requests,
        limitRooms,
        free,
        lockToken: 'TOKEN1',
        lockedBy: 'test:TOKEN1',
        leaseMs: LEASE_MS,
        // MySQL and MariaDB: the choice of the runner, by share
        choose: locked => chooseRows({
            rows: locked,
            names: shareNamesOf(requests, limitRooms),
            free,
            base: 0,
            size: Math.max(requests.length, 1),
        }).chosen,
        ...params,
    });
}

/**
 * The names of a claim as the runner makes them: the tie order is the index.
 * @param {import('../../src/store/store.js').DueRequest[]} requests
 * @param {number[]} limitRooms
 * @returns {import('../../src/fair_share.js').ShareName[]}
 */
function shareNamesOf(requests, limitRooms) {
    const rooms = limitRooms.map(room => ({ room }));

    return requests.map(due => ({
        name: due.name,
        index: due.tie,
        weight: due.weight,
        running: due.running,
        limits: due.limits.map(limit => rooms[limit]),
        available: Infinity,
    }));
}

/**
 * @param {string} name
 * @param {number} maxJobs
 * @param {number} tie
 * @param {Partial<import('../../src/store/store.js').DueRequest>} [fields]
 * @returns {import('../../src/store/store.js').DueRequest}
 */
function request(name, maxJobs, tie, fields = {}) {
    return { name, maxJobs, running: 0, weight: 1, limits: [], tie, ...fields };
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

/**
 * @param {number} seed
 * @returns {() => number} A seeded random generator (LCG), in [0, 1).
 */
function seeded(seed) {
    let state = seed;

    return () => {
        state = ((state * 1_103_515_245) + 12_345) % (2 ** 31);

        return state / (2 ** 31);
    };
}

/**
 * One random claim: 2–6 names with due jobs, weights, running counts, local limits and caps. The claim must take the
 * jobs that fill() takes on the rows that it locks: the oldest maxJobs due jobs of each name.
 * @param {import('../../src/types.js').Sqlane<any>} sqlane
 * @param {import('../../src/store/store.js').Store} store
 * @param {() => number} random
 * @param {number} round
 * @returns {Promise<object[]>} The case if the jobs differ.
 */
async function compareChoice(sqlane, store, random, round) {
    const int = (/** @type {number} */ max) => Math.floor(random() * (max + 1));
    const count = 2 + int(4);
    /** @type {{ id: string, name: string }[]} */
    const rows = [];
    const requests = [];

    for (let index = 0; index < count; index++) {
        const name = `r${round}_${index}`;
        const due = int(5);
        // oxlint-disable-next-line no-await-in-loop -- the jobs of each name in order
        const results = await sqlane.enqueueMany(testAdapter.pool, name, Array.from({ length: due }, (_, k) => ({
            payload: {},
            options: { runAt: ago(100 - k) },
        })));
        const maxJobs = 1 + int(4);

        rows.push(...results.slice(0, maxJobs).map(result => ({ id: result.id, name })));
        requests.push(request(name, maxJobs, index, {
            running: int(6),
            weight: [1, 1, 2, 3, 7, 1000][int(5)],
            limits: [[], [0], [1], [0, 1]][int(3)],
        }));
    }

    const limitRooms = [int(3), int(6)];
    const free = 1 + int(10);
    // The rows of the names in FIFO order; the jobs of a name were enqueued oldest first
    const expected = chooseRows({
        rows,
        names: shareNamesOf(requests, limitRooms),
        free,
        base: 0,
        size: count,
    }).chosen.map(row => row.id);
    const claimed = await claimDue(store, { requests, limitRooms, free, lockToken: `R${round}` });
    const got = claimed.map(job => job.id);

    return expected.toSorted().join(',') === got.toSorted().join(',')
        ? []
        : [{ round, requests, limitRooms, free, expected, got }];
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
            requests: [request('a', 2, 0), request('b', 5, 1)],
        });

        expect(claimed.map(row => [row.id, row.payload])).toStrictEqual([
            [a1.id, { found: true, payload: { n: 1 } }],
            [b1.id, { found: true, payload: { n: 2 } }],
            [a2.id, { found: true, payload: { n: 3 } }],
        ]);
        expect(claimed[0]).toMatchObject({
            name: 'a',
            limits: [],
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
            requests: [request('a', 1, 0), request('b', 1, 1)],
        });

        expect(first.jobs.map(job => job.name)).toStrictEqual(['a', 'b']);
        // a: one due job left; b: none left; c: not requested
        expect(Object.keys(delaysByName(first.next)).filter(name => name !== 'c')).toStrictEqual(['a']);
        expect(delaysByName(first.next).a).toBeLessThanOrEqual(-19_000);

        const second = await claimDueWithNext(store, { requests: [request('a', 5, 0)] });

        expect(second.jobs).toHaveLength(1);
        expect(delaysByName(second.next).a).toBeGreaterThan(3_590_000);
    });

    test('a claim that fills the free process slots does not read the next due times', async () => {
        const { sqlane, store } = await freshTables();

        await Promise.all(['a', 'b', 'c'].map(name => sqlane.enqueue(testAdapter.pool, name, {}, { runAt: ago(10) })));

        const requests = ['a', 'b', 'c'].map((name, index) => request(name, 2, index));
        const full = await claimDueWithNext(store, { requests, free: 2 });

        expect(full.jobs).toHaveLength(2);
        expect(full.next).toBeNull();

        const rest = await claimDueWithNext(store, { requests, free: 2 });

        expect(rest.jobs).toHaveLength(1);
        expect(rest.next).toStrictEqual([]);
    });

    test('the free slots of each local limit and of the instance, by share', async () => {
        const { sqlane, store } = await freshTables();
        const a1 = await sqlane.enqueue(testAdapter.pool, 'a', {}, { runAt: ago(50) });
        const b1 = await sqlane.enqueue(testAdapter.pool, 'b', {}, { runAt: ago(40) });
        const c1 = await sqlane.enqueue(testAdapter.pool, 'c', {}, { runAt: ago(35) });

        await sqlane.enqueue(testAdapter.pool, 'a', {}, { runAt: ago(30) });
        await sqlane.enqueue(testAdapter.pool, 'c', {}, { runAt: ago(20) });

        // a and b share limit 0 (1 free slot); c has no limit; the instance has 2 free slots
        const claimed = await claimDue(store, {
            requests: [request('a', 1, 0, { limits: [0] }), request('b', 1, 1, { limits: [0] }), request('c', 2, 2)],
            limitRooms: [1],
            free: 2,
        });

        expect(claimed.map(row => row.id)).toStrictEqual([a1.id, c1.id]);
        // The jobs that did not fit stay pending, unlocked
        await expect(claimDue(store, {
            requests: [request('b', 1, 0)],
            lockToken: 'TOKEN2',
        })).resolves.toMatchObject([{ id: b1.id }]);
    });

    test('the choice in the claim equals fill() on the locked rows, on 25 random claims', async () => {
        const { sqlane, store } = await freshTables();
        const random = seeded(5);
        const mismatches = [];

        for (let round = 0; round < 25; round++) {
            // oxlint-disable-next-line no-await-in-loop -- one claim after the other
            mismatches.push(...await compareChoice(sqlane, store, random, round));
        }

        expect(mismatches).toStrictEqual([]);
    });

    test('concurrent claims never take the same job', async () => {
        const { sqlane, store } = await freshTables();
        const results = await sqlane.enqueueMany(
            testAdapter.pool,
            'busy',
            Array.from({ length: 40 }, () => ({ payload: {}, options: { runAt: ago(5) } })),
        );
        const claims = await Promise.all(['T1', 'T2', 'T3', 'T4'].map(token => claimDue(store, {
            requests: [request('busy', 15, 0)],
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

        await expect(claimDue(store, { requests: [request('a', 1, 0)] }))
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

        await expect(claimDue(store, { requests: [request('a', 1, 0)] }))
            .resolves.toMatchObject([{ id, payload: { found: true, payload: { n: 1 } } }]);
    });

    // innodb_snapshot_isolation (MariaDB 10.11.8 and later; ON by default from 11.6.2, ON here on 10.11 too): a job
    // whose enqueue commits during the claim statement would fail the claim with ER_CHECKREAD (1020). The claim
    // statement turns it off: the job is locked, its payload read again.
    test.runIf(inject('databaseDialect') === 'mariadb')('mariadb: claims that race enqueues under innodb_snapshot_isolation: no ER_CHECKREAD, every payload', async () => {
        const { p, sqlane } = await freshTables();
        const { adapter } = testAdapter;
        const store = createStore({
            ...adapter,
            queueTransaction: func => adapter.queueTransaction(async (executor) => {
                await executor.run('SET SESSION innodb_snapshot_isolation = ON', []);

                try {
                    return await func(executor);
                } finally {
                    await executor.run('SET SESSION innodb_snapshot_isolation = DEFAULT', []);
                }
            }),
        }, p);
        const names = Array.from({ length: 10 }, (_, index) => `n${index}`);
        const until = Date.now() + 1500;
        /** @type {unknown[]} */
        const errors = [];
        let claimed = 0;
        let missing = 0;
        const enqueuer = async () => {
            for (let n = 0; Date.now() < until; n++) {
                // oxlint-disable-next-line no-await-in-loop -- one enqueue after the other
                await sqlane.enqueue(testAdapter.pool, names[n % names.length], { n });
            }
        };
        const claimer = async (/** @type {number} */ index) => {
            for (let round = 0; Date.now() < until; round++) {
                try {
                    // oxlint-disable-next-line no-await-in-loop -- one claim after the other
                    const jobs = await claimDue(store, {
                        requests: names.map((name, tie) => request(name, 5, tie)),
                        free: 1000,
                        lockToken: `T${index}-${round}`,
                    });

                    claimed += jobs.length;
                    missing += jobs.filter(job => !job.payload.found).length;
                } catch (error) {
                    errors.push(error);
                }
            }
        };

        await Promise.all([...Array.from({ length: 4 }, enqueuer), claimer(1), claimer(2)]);

        expect(errors.filter(error => /** @type {{ errno?: unknown }} */ (error).errno === 1020)).toStrictEqual([]);
        expect(claimed).toBeGreaterThan(0);
        expect(missing).toBe(0);
    });
});

/**
 * @param {string} p
 * @returns {Promise<Record<string, unknown>[]>} The jobs: their status and the key that they are blocked on.
 */
function statuses(p) {
    return database.query(`SELECT id, status, blocked_on FROM ${p}jobs ORDER BY run_at`);
}

/**
 * @param {string} p
 * @returns {Promise<Record<string, unknown>[]>} The held slots.
 */
function slotsOf(p) {
    return database.query(`SELECT limit_key, slot, job_id FROM ${p}concurrency_slots ORDER BY limit_key, slot`);
}

describe('global concurrency limits', () => {
    const order = defineConcurrencyLimit({ name: 'order', max: 1 });
    const client = defineConcurrencyLimit({ name: 'client', max: 2 });
    const syncOrder = defineJob({
        name: 'sync_order',
        globalConcurrencyLimits: ({ payload }) => [order.key(payload.orderId)],
        timeout: '1m',
    });
    const send = defineJob({
        name: 'send',
        globalConcurrencyLimits: ({ payload }) => [client.key(payload.clientId)],
        timeout: '1m',
    });

    test('a full key: the job is blocked on it, out of the due jobs; a key with room: it runs', async () => {
        const { p, sqlane, store } = await freshTables();
        const first = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 1 }, { runAt: ago(30) });

        await claimAll(store, [first.id], 'T1');

        const waiting = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 1 }, { runAt: ago(20) });
        const free = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 2 }, { runAt: ago(10) });
        const found = await store.findCandidates(new Map([['sync_order', 10]]));

        expect(found.startable.map(candidate => candidate.id)).toStrictEqual([free.id]);
        expect(found.full.map(candidate => candidate.id)).toStrictEqual([waiting.id]);
        await expect(claimWithBlocks(store, [free.id], 'T2', [waiting.id])).resolves.toMatchObject({
            jobs: [{ id: free.id, limits: [{ key: 'order:2', max: 1 }] }],
            blockedKeys: ['order:1'],
            blockedNames: ['sync_order'],
        });
        await expect(statuses(p)).resolves.toStrictEqual([
            { id: first.id, status: 'running', blocked_on: null },
            { id: waiting.id, status: 'blocked', blocked_on: 'order:1' },
            { id: free.id, status: 'running', blocked_on: null },
        ]);
        // A blocked job is not due: the next search does not read it
        await expect(store.findCandidates(new Map([['sync_order', 10]])))
            .resolves.toStrictEqual({ startable: [], full: [] });
    });

    test('a max of 2: two jobs of a key run, the third is blocked; a release unblocks it', async () => {
        const { p, sqlane, store } = await freshTables();
        /** @type {{ id: string }[]} */
        const jobs = [];

        for (const secondsAgo of [30, 20, 10]) {
            // oxlint-disable-next-line no-await-in-loop -- in the order of run_at
            jobs.push(await sqlane.enqueue(testAdapter.pool, send, { clientId: 'c1' }, { runAt: ago(secondsAgo) }));
        }

        const other = await sqlane.enqueue(testAdapter.pool, send, { clientId: 'c2' }, { runAt: ago(5) });
        // One claim: the third has room by the held slots, but not with the first two
        const claimed = await claimAll(store, [...jobs, other].map(job => job.id), 'T1');

        expect(claimed.map(job => job.id)).toStrictEqual([jobs[0].id, jobs[1].id, other.id]);
        await expect(slotsOf(p)).resolves.toStrictEqual([
            { limit_key: 'client:c1', slot: 0, job_id: jobs[0].id },
            { limit_key: 'client:c1', slot: 1, job_id: jobs[1].id },
            { limit_key: 'client:c2', slot: 0, job_id: other.id },
        ]);

        // The next search: the third is full; the claim blocks it
        const found = await store.findCandidates(new Map([['send', 10]]));

        expect(found.full.map(candidate => candidate.id)).toStrictEqual([jobs[2].id]);
        await claimWithBlocks(store, [], 'T2', [jobs[2].id]);

        // Nothing to unblock while the key is full
        await expect(store.unblock(['client:c1'])).resolves.toStrictEqual([]);
        await expect(store.completeJobs([claimed[0]])).resolves.toBe(1);
        await expect(store.unblock(['client:c1', 'client:c2'])).resolves.toStrictEqual(['send']);
        await expect(statuses(p).then(rows => rows.find(row => row.id === jobs[2].id)))
            .resolves.toStrictEqual({ id: jobs[2].id, status: 'pending', blocked_on: null });
        await expect(claimAll(store, [jobs[2].id], 'T3')).resolves.toMatchObject([{ id: jobs[2].id }]);
        // The slot that the completed job freed
        await expect(slotsOf(p)).resolves.toStrictEqual([
            { limit_key: 'client:c1', slot: 0, job_id: jobs[2].id },
            { limit_key: 'client:c1', slot: 1, job_id: jobs[1].id },
            { limit_key: 'client:c2', slot: 0, job_id: other.id },
        ]);
    });

    test('the jobs blocked on a key are unblocked in FIFO order, as many as its free slots', async () => {
        const { p, sqlane, store } = await freshTables();
        const running = await sqlane.enqueue(testAdapter.pool, send, { clientId: 'c1' }, { runAt: ago(60) });
        const second = await sqlane.enqueue(testAdapter.pool, send, { clientId: 'c1' }, { runAt: ago(50) });
        const [first, done] = await claimAll(store, [running.id, second.id], 'T1');
        /** @type {{ id: string }[]} */
        const blocked = [];

        for (const secondsAgo of [30, 20, 10]) {
            // oxlint-disable-next-line no-await-in-loop -- in the order of run_at
            blocked.push(await sqlane.enqueue(testAdapter.pool, send, { clientId: 'c1' }, { runAt: ago(secondsAgo) }));
        }

        await claimWithBlocks(store, [], 'T2', blocked.map(job => job.id));
        await store.completeJobs([done]);
        await store.unblock(['client:c1']);
        await expect(statuses(p).then(rows => rows.map(row => row.status))).resolves.toStrictEqual([
            'running', 'completed', 'pending', 'blocked', 'blocked',
        ]);

        // The room counts the held slots: an unblocked job that no claim took yet is not counted, and a claim blocks
        // it again if the key is full by then
        await store.completeJobs([first]);
        await store.unblock(['client:c1']);
        await expect(statuses(p).then(rows => rows.map(row => row.status))).resolves.toStrictEqual([
            'completed', 'completed', 'pending', 'pending', 'pending',
        ]);
    });

    test('concurrent claims of jobs that share one of their keys: one gets the key, no partial slots', async () => {
        const { p, sqlane, store } = await freshTables();
        const both = defineConcurrencyLimit({ name: 'both', max: 1 });
        const a = await sqlane.enqueue(testAdapter.pool, 'two', {}, {
            globalConcurrencyLimits: [both.key('a'), both.key('b')],
            runAt: ago(20),
        });
        const b = await sqlane.enqueue(testAdapter.pool, 'two', {}, {
            globalConcurrencyLimits: [both.key('b'), both.key('c')],
            runAt: ago(10),
        });
        const claims = await Promise.all([claimAll(store, [a.id], 'T1'), claimAll(store, [b.id], 'T2')]);
        const [winner] = claims.flat();

        expect(claims.flat()).toHaveLength(1);
        await expect(slotsOf(p)).resolves.toStrictEqual(
            winner.limits.map(({ key }) => ({ limit_key: key, slot: 0, job_id: winner.id })),
        );
    });

    test('a linger holds its slot until held_until, then a claim takes it over', async () => {
        const { p, sqlane, store } = await freshTables();

        await database.query(LINGER_SQL[database.family](p), ['order:1', 3600]);
        await database.query(LINGER_SQL[database.family](p), ['order:2', -1]);

        const lingering = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 1 }, { runAt: ago(20) });
        const ended = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 2 }, { runAt: ago(10) });
        const found = await store.findCandidates(new Map([['sync_order', 10]]));

        expect(found.startable.map(candidate => candidate.id)).toStrictEqual([ended.id]);
        expect(found.full.map(candidate => candidate.id)).toStrictEqual([lingering.id]);
        await expect(claimAll(store, [lingering.id, ended.id], 'T1')).resolves.toMatchObject([{ id: ended.id }]);
        await expect(slotsOf(p)).resolves.toStrictEqual([
            { limit_key: 'order:1', slot: 0, job_id: 'old' },
            { limit_key: 'order:2', slot: 0, job_id: ended.id },
        ]);
    });

    test('the sweep deletes the ended lingers and unblocks the jobs of keys with room', async () => {
        const { p, sqlane, store } = await freshTables();

        await database.query(LINGER_SQL[database.family](p), ['order:1', 3600]);

        const waiting = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 1 }, { runAt: ago(20) });

        await claimWithBlocks(store, [], 'T1', [waiting.id]);
        await expect(store.sweepSlots(100)).resolves.toStrictEqual({
            lingers: 0,
            orphans: 0,
            unblocked: 0,
            rateWaits: [],
        });

        // The linger ends
        await database.query(`DELETE FROM ${p}concurrency_slots`);
        await database.query(LINGER_SQL[database.family](p), ['order:1', -1]);
        await expect(store.sweepSlots(100)).resolves.toStrictEqual({
            lingers: 1,
            orphans: 0,
            unblocked: 1,
            rateWaits: [],
        });
        await expect(statuses(p)).resolves.toStrictEqual([{ id: waiting.id, status: 'pending', blocked_on: null }]);
    });

    test('the claim of names without limits leaves the jobs with limits from their enqueue options', async () => {
        const { sqlane, store } = await freshTables();

        await sqlane.enqueue(testAdapter.pool, 'plain', {}, { globalConcurrencyLimits: [order.key(1)], runAt: ago(20) });

        const plain = await sqlane.enqueue(testAdapter.pool, 'plain', {}, { runAt: ago(10) });

        await expect(claimDueWithNext(store, { requests: [request('plain', 5, 0)] })).resolves.toMatchObject({
            jobs: [{ id: plain.id }],
            limited: ['plain'],
        });
        await sqlane.enqueue(testAdapter.pool, 'other', {}, { globalConcurrencyLimits: [order], runAt: ago(5) });
        const both = await claimDueWithNext(store, { requests: [request('other', 5, 0), request('plain', 5, 1)] });

        expect(both.jobs).toStrictEqual([]);
        expect(both.limited.toSorted()).toStrictEqual(['other', 'plain']);
    });

    test('getStats counts the blocked jobs as pending', async () => {
        const { sqlane, store } = await freshTables();
        const first = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 1 }, { runAt: ago(20) });
        const waiting = await sqlane.enqueue(testAdapter.pool, syncOrder, { orderId: 1 }, { runAt: ago(10) });

        await claimAll(store, [first.id], 'T1');
        await claimWithBlocks(store, [], 'T2', [waiting.id]);

        await expect(sqlane.getStats()).resolves.toMatchObject([
            { name: 'sync_order', pending: 1, due: 0, running: 1 },
        ]);
    });
});

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const AHEAD_SQL = {
    mysql: p => `SELECT limit_key, TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(6), tat) DIV 1000 AS ahead_ms
                   FROM ${p}rate_limits ORDER BY limit_key`,
    postgres: p => `SELECT limit_key, (EXTRACT(EPOCH FROM tat - clock_timestamp()) * 1000)::bigint AS ahead_ms
                      FROM ${p}rate_limits ORDER BY limit_key`,
};

/**
 * @param {string} p
 * @returns {Promise<Record<string, number>>} How far the tat of each rate key is ahead of now, in ms.
 */
async function aheadMs(p) {
    const rows = await database.query(AHEAD_SQL[database.family](p));

    return Object.fromEntries(rows.map(row => [String(row.limit_key), Number(row.ahead_ms)]));
}

/**
 * @param {import('../../src/store/store.js').Store} store
 * @param {Map<string, number>} limitsByName
 * @param {string} lockToken
 * @returns {Promise<import('../../src/store/store.js').ClaimResult>} The claim of the candidates of the names.
 */
async function claimCandidates(store, limitsByName, lockToken) {
    const found = await store.findCandidates(limitsByName);

    return claimWithBlocks(store, found.startable.map(job => job.id), lockToken, found.full.map(job => job.id));
}

describe('global rate limits', () => {
    // 4 per 400 ms, bursts of 4: one each 100 ms
    const api = defineRateLimit({ name: 'api', max: 4, per: '400ms', burst: 4 });
    const callApi = defineJob({
        name: 'call_api',
        globalRateLimits: ({ payload }) => [api.key(payload.account, { cost: payload.cost ?? 1 })],
    });

    /**
     * @param {import('../../src/types.js').Sqlane<any>} sqlane
     * @param {number} count
     * @param {{ account: string, cost?: number }} payload
     * @param {number} [secondsAgo] The due time of the first: the others 1 s apart.
     * @returns {Promise<string[]>} The ids, oldest first.
     */
    async function enqueueCalls(sqlane, count, payload, secondsAgo = 60) {
        const ids = [];

        for (let at = 0; at < count; at++) {
            // oxlint-disable-next-line no-await-in-loop -- in the order of run_at
            ids.push((await sqlane.enqueue(testAdapter.pool, callApi, /** @type {any} */ (payload), {
                runAt: ago(secondsAgo - at),
            })).id);
        }

        return ids;
    }

    test('burst = max: max jobs start at once, the others are blocked on the key; then one per per / max', async () => {
        const { p, sqlane, store } = await freshTables();
        const ids = await enqueueCalls(sqlane, 6, { account: 'a1' });
        const found = await store.findCandidates(new Map([['call_api', 10]]));

        expect(found.startable.map(job => job.id)).toStrictEqual(ids.slice(0, 4));
        expect(found.full.map(job => job.id)).toStrictEqual(ids.slice(4));

        // A name not known with rate keys: the same result; the name is known from then on
        const ratedNames = new Set(['other']);

        await expect(store.findCandidates(new Map([['call_api', 10]]), ratedNames)).resolves.toStrictEqual(found);
        expect([...ratedNames]).toStrictEqual(['other', 'call_api']);

        const result = await claimWithBlocks(store, ids.slice(0, 4), 'T1', ids.slice(4));

        expect(result.jobs.map(job => job.id)).toStrictEqual(ids.slice(0, 4));
        expect(result.jobs[0].rateLimits).toStrictEqual([
            { key: '@api:a1', max: 4, per_us: 400_000, burst: 4, cost: 1 },
        ]);
        expect(result).toMatchObject({ blockedKeys: ['@api:a1'], blockedNames: ['call_api'] });
        expect(result.rateWaits).toHaveLength(1);
        expect(result.rateWaits[0].key).toBe('@api:a1');
        expect(result.rateWaits[0].delayMs).toBeGreaterThan(50);
        expect(result.rateWaits[0].delayMs).toBeLessThanOrEqual(100);
        await expect(statuses(p).then(rows => rows.map(row => [row.status, row.blocked_on]))).resolves.toStrictEqual([
            ...Array.from({ length: 4 }, () => ['running', null]),
            ['blocked', '@api:a1'],
            ['blocked', '@api:a1'],
        ]);
        // 4 × 100 ms ahead, from the claim
        expect((await aheadMs(p))['@api:a1']).toBeGreaterThan(300);

        // No quota yet: nothing unblocked, the time of the oldest
        const early = await store.unblockRates(['@api:a1']);

        expect(early.names).toStrictEqual([]);
        expect(early.waits).toMatchObject([{ key: '@api:a1' }]);
        await sleep(early.waits[0].delayMs + 5);

        // One more start: the oldest blocked job only
        const unblocked = await store.unblockRates(['@api:a1']);

        expect(unblocked.names).toStrictEqual(['call_api']);
        expect(unblocked.waits).toHaveLength(1);
        expect(unblocked.waits[0].delayMs).toBeGreaterThan(50);
        expect(unblocked.waits[0].delayMs).toBeLessThanOrEqual(100);
        await expect(claimCandidates(store, new Map([['call_api', 10]]), 'T2'))
            .resolves.toMatchObject({ jobs: [{ id: ids[4] }], blockedKeys: [] });
    });

    test('burst 1: one start, then the next after per / max', async () => {
        const { p, sqlane, store } = await freshTables();
        const smooth = defineRateLimit({ name: 'smooth', max: 10, per: '1s' });
        const ids = [];

        for (const secondsAgo of [30, 20, 10]) {
            // oxlint-disable-next-line no-await-in-loop -- in the order of run_at
            ids.push((await sqlane.enqueue(testAdapter.pool, 'tick', {}, {
                globalRateLimits: [smooth],
                runAt: ago(secondsAgo),
            })).id);
        }

        const first = await claimCandidates(store, new Map([['tick', 10]]), 'T1');

        expect(first.jobs.map(job => job.id)).toStrictEqual([ids[0]]);
        expect(first.rateWaits).toMatchObject([{ key: '@smooth' }]);
        await expect(claimCandidates(store, new Map([['tick', 10]]), 'T2')).resolves.toMatchObject({ jobs: [] });
        await sleep(first.rateWaits[0].delayMs + 5);
        await store.unblockRates(['@smooth']);
        await expect(claimCandidates(store, new Map([['tick', 10]]), 'T3'))
            .resolves.toMatchObject({ jobs: [{ id: ids[1] }] });
        await expect(statuses(p).then(rows => rows.map(row => row.status)))
            .resolves.toStrictEqual(['running', 'running', 'blocked']);
    });

    test('a per that is not a multiple of max: a key without debt takes a job', async () => {
        const { sqlane, store } = await freshTables();
        // 142,857.1… µs per start
        const seventh = defineRateLimit({ name: 'seventh', max: 7, per: '1s' });
        const ids = [];

        for (const secondsAgo of [20, 10]) {
            // oxlint-disable-next-line no-await-in-loop -- in the order of run_at
            ids.push((await sqlane.enqueue(testAdapter.pool, 'tick', {}, {
                globalRateLimits: [seventh],
                runAt: ago(secondsAgo),
            })).id);
        }

        const found = await store.findCandidates(new Map([['tick', 10]]));

        expect(found.startable.map(job => job.id)).toStrictEqual([ids[0]]);

        const first = await claimCandidates(store, new Map([['tick', 10]]), 'T1');

        expect(first.jobs.map(job => job.id)).toStrictEqual([ids[0]]);
        expect(first.rateWaits).toMatchObject([{ key: '@seventh', delayMs: expect.any(Number) }]);
        expect(first.rateWaits[0].delayMs).toBeGreaterThan(100);
        expect(first.rateWaits[0].delayMs).toBeLessThanOrEqual(143);
        await sleep(first.rateWaits[0].delayMs + 5);
        await expect(store.unblockRates(['@seventh'])).resolves.toMatchObject({ names: ['tick'] });
    });

    test('cost: a job takes cost × per / max of the quota', async () => {
        const { sqlane, store } = await freshTables();
        const [big] = await enqueueCalls(sqlane, 1, { account: 'a1', cost: 3 });
        const [small] = await enqueueCalls(sqlane, 1, { account: 'a1', cost: 2 }, 30);
        const result = await claimWithBlocks(store, [big, small], 'T1');

        expect(result.jobs.map(job => job.id)).toStrictEqual([big]);
        expect(result.blockedKeys).toStrictEqual(['@api:a1']);
        // 300 ms of 400 taken; 200 more: 100 ms to wait
        expect(result.rateWaits[0].delayMs).toBeGreaterThan(50);
        expect(result.rateWaits[0].delayMs).toBeLessThanOrEqual(100);
    });

    test('several rate keys: all or nothing; a blocked job takes the quota of none', async () => {
        const { p, sqlane, store } = await freshTables();
        const a = defineRateLimit({ name: 'a', max: 1, per: '1h' });
        const b = defineRateLimit({ name: 'b', max: 1, per: '1h' });
        const onB = await sqlane.enqueue(testAdapter.pool, 'two', {}, { globalRateLimits: [b], runAt: ago(30) });
        const both = await sqlane.enqueue(testAdapter.pool, 'two', {}, { globalRateLimits: [a, b], runAt: ago(20) });

        await expect(claimWithBlocks(store, [onB.id, both.id], 'T1')).resolves.toMatchObject({
            jobs: [{ id: onB.id }],
            blockedKeys: ['@b'],
        });

        // @a kept its quota: a job of @a alone starts
        const onA = await sqlane.enqueue(testAdapter.pool, 'two', {}, { globalRateLimits: [a], runAt: ago(10) });

        await expect(claimAll(store, [onA.id], 'T2')).resolves.toMatchObject([{ id: onA.id }]);
        await expect(statuses(p)).resolves.toStrictEqual([
            { id: onB.id, status: 'running', blocked_on: null },
            { id: both.id, status: 'blocked', blocked_on: '@b' },
            { id: onA.id, status: 'running', blocked_on: null },
        ]);
    });

    test('FIFO per key: a newer job waits behind the jobs blocked on its key, even with quota', async () => {
        const { p, sqlane, store } = await freshTables();
        const ids = await enqueueCalls(sqlane, 5, { account: 'a1' });
        const { rateWaits } = await claimWithBlocks(store, ids.slice(0, 4), 'T1', [ids[4]]);

        await sleep(rateWaits[0].delayMs + 5);

        // The key has quota for one, but its oldest blocked job comes first
        const [newer] = await enqueueCalls(sqlane, 1, { account: 'a1' }, 1);
        const found = await store.findCandidates(new Map([['call_api', 10]]));

        expect(found).toMatchObject({ startable: [], full: [{ id: newer }] });
        await expect(claimWithBlocks(store, [newer], 'T2')).resolves.toMatchObject({
            jobs: [],
            blockedKeys: ['@api:a1'],
            // Behind an older blocked job: that job's timer
            rateWaits: [],
        });
        await expect(store.unblockRates(['@api:a1'])).resolves.toMatchObject({ names: ['call_api'] });
        await expect(statuses(p).then(rows => rows.slice(4).map(row => [row.id, row.status]))).resolves.toStrictEqual([
            [ids[4], 'pending'],
            [newer, 'blocked'],
        ]);
    });

    test('a key without quota does not hold the other keys of the name', async () => {
        const { sqlane, store } = await freshTables();
        const flood = await enqueueCalls(sqlane, 8, { account: 'flood' });
        const other = await enqueueCalls(sqlane, 2, { account: 'other' }, 30);
        // 4 free slots, 2 × 4 candidates: the search counts the quota of each key, after the older jobs
        const found = await store.findCandidates(new Map([['call_api', 8]]));

        expect(found.startable.map(job => job.id)).toStrictEqual([...flood.slice(0, 4), ...other]);
        expect(found.full.map(job => job.id)).toStrictEqual(flood.slice(4));
        await expect(claimWithBlocks(store, found.startable.map(job => job.id), 'T1', found.full.map(job => job.id)))
            .resolves.toMatchObject({ blockedKeys: ['@api:flood'] });
    });

    test('a full concurrency key and a rate key without quota: blocked on the concurrency key', async () => {
        const { p, sqlane, store } = await freshTables();
        const lane = defineConcurrencyLimit({ name: 'lane', max: 1 });
        const once = defineRateLimit({ name: 'once', max: 1, per: '1h' });
        const options = { globalConcurrencyLimits: [lane], globalRateLimits: [once] };
        const first = await sqlane.enqueue(testAdapter.pool, 'both', {}, { ...options, runAt: ago(30) });
        const [running] = await claimAll(store, [first.id], 'T1');

        const second = await sqlane.enqueue(testAdapter.pool, 'both', {}, { ...options, runAt: ago(20) });

        await expect(claimWithBlocks(store, [], 'T2', [second.id]))
            .resolves.toMatchObject({ blockedKeys: ['lane'], rateWaits: [] });

        // The slot frees: unblocked, then blocked on the rate key
        await store.completeJobs([running]);
        await expect(store.unblock(['lane'])).resolves.toStrictEqual(['both']);
        await expect(claimWithBlocks(store, [second.id], 'T3'))
            .resolves.toMatchObject({ jobs: [], blockedKeys: ['@once'], rateWaits: [{ key: '@once' }] });
        // No slot taken
        await expect(slotsOf(p)).resolves.toStrictEqual([]);
        await expect(statuses(p).then(rows => rows.map(row => row.blocked_on))).resolves.toStrictEqual([null, '@once']);
    });

    test('a job blocked on its concurrency key takes no quota', async () => {
        const { p, sqlane, store } = await freshTables();
        const lane = defineConcurrencyLimit({ name: 'lane', max: 1 });
        const once = defineRateLimit({ name: 'once', max: 1, per: '1h' });
        const holder = await sqlane.enqueue(testAdapter.pool, 'both', {}, {
            globalConcurrencyLimits: [lane],
            runAt: ago(30),
        });

        await claimAll(store, [holder.id], 'T1');

        const waiting = await sqlane.enqueue(testAdapter.pool, 'both', {}, {
            globalConcurrencyLimits: [lane],
            globalRateLimits: [once],
            runAt: ago(20),
        });
        const rateOnly = await sqlane.enqueue(testAdapter.pool, 'both', {}, { globalRateLimits: [once], runAt: ago(10) });

        await expect(claimWithBlocks(store, [waiting.id, rateOnly.id], 'T2')).resolves.toMatchObject({
            jobs: [{ id: rateOnly.id }],
            blockedKeys: ['lane'],
        });
        await expect(slotsOf(p)).resolves.toMatchObject([{ limit_key: 'lane', job_id: holder.id }]);
    });

    test('concurrent claims never take more than the quota', async () => {
        const { store, sqlane } = await freshTables();
        const ids = await enqueueCalls(sqlane, 12, { account: 'a1' });
        const claims = await Promise.all([0, 1, 2].map(at => claimWithBlocks(
            store,
            ids.filter((_, index) => index % 3 === at),
            `T${at}`,
        )));

        expect(claims.flatMap(claim => claim.jobs)).toHaveLength(4);
    });

    test('the sweep unblocks the jobs whose time came, for a lost timer; then it takes the timer over', async () => {
        const { p, sqlane, store } = await freshTables();
        const ids = await enqueueCalls(sqlane, 6, { account: 'a1' });
        const { rateWaits } = await claimWithBlocks(store, ids.slice(0, 4), 'T1', ids.slice(4));

        await expect(store.sweepSlots(100)).resolves.toStrictEqual({
            lingers: 0,
            orphans: 0,
            unblocked: 0,
            rateWaits: [],
        });
        await sleep(rateWaits[0].delayMs + 5);

        const swept = await store.sweepSlots(100);

        expect(swept).toMatchObject({ unblocked: 1, rateWaits: [{ key: '@api:a1' }] });
        await expect(statuses(p).then(rows => rows.slice(4).map(row => row.status)))
            .resolves.toStrictEqual(['pending', 'blocked']);
    });

    test('an unblock that leaves no blocked job on its key gives one more unblock, in a second at the earliest: '
        + 'a job blocked meanwhile behind the ones it made pending', async () => {
        const { sqlane, store } = await freshTables();
        // One start each 100 ms
        const smooth = defineRateLimit({ name: 'smooth', max: 10, per: '1s' });
        const ids = [];

        for (const secondsAgo of [20, 10]) {
            // oxlint-disable-next-line no-await-in-loop -- in the order of run_at
            ids.push((await sqlane.enqueue(testAdapter.pool, 'tick', {}, {
                globalRateLimits: [smooth],
                runAt: ago(secondsAgo),
            })).id);
        }

        const { rateWaits } = await claimWithBlocks(store, ids, 'T1');

        await sleep(rateWaits[0].delayMs + 5);

        const unblocked = await store.unblockRates(['@smooth']);

        expect(unblocked.names).toStrictEqual(['tick']);
        expect(unblocked.waits).toMatchObject([{ key: '@smooth', delayMs: 1000 }]);
        // Then nothing left: no more
        await expect(store.unblockRates(['@smooth'])).resolves.toStrictEqual({ names: [], waits: [] });
    });

    test('an unblock counts the jobs that the previous one made pending, by their debt: not again', async () => {
        const { p, sqlane, store } = await freshTables();
        // 3 per hour, bursts of 3: 20 min per start
        const quota = defineRateLimit({ name: 'quota', max: 3, per: '1h', burst: 3 });
        const ids = [];

        for (let at = 0; at < 7; at++) {
            // oxlint-disable-next-line no-await-in-loop -- in the order of run_at
            ids.push((await sqlane.enqueue(testAdapter.pool, 'call', {}, {
                globalRateLimits: [quota],
                runAt: ago(70 - at),
            })).id);
        }

        await claimWithBlocks(store, ids.slice(0, 3), 'T1', ids.slice(3));
        // One start of debt: room for two
        await database.query(SET_TAT_SQL[database.family](p), ['@quota', -20 * 60]);

        const first = await store.unblockRates(['@quota']);

        expect(first.names).toStrictEqual(['call']);
        expect(first.waits).toMatchObject([{ key: '@quota', debtUs: expect.any(Number) }]);
        // 3 starts of debt after the two: the next one in 20 min
        expect(first.waits[0].debtUs).toBeGreaterThan(3600e6 - 5e6);
        expect(first.waits[0].delayMs).toBeGreaterThan((20 * 60_000) - 5000);
        await expect(statuses(p).then(rows => rows.slice(3).map(row => row.status)))
            .resolves.toStrictEqual(['pending', 'pending', 'blocked', 'blocked']);

        // Before their claims: given the debt, no more; without it, the stored tat lets two more go
        const again = await store.unblockRates(['@quota'], new Map([['@quota', Number(first.waits[0].debtUs)]]));

        expect(again.names).toStrictEqual([]);
        expect(again.waits[0].delayMs).toBeGreaterThan((20 * 60_000) - 5000);
        await expect(statuses(p).then(rows => rows.slice(3).map(row => row.status)))
            .resolves.toStrictEqual(['pending', 'pending', 'blocked', 'blocked']);
        await expect(store.unblockRates(['@quota'])).resolves.toMatchObject({ names: ['call'] });
        await expect(statuses(p).then(rows => rows.slice(3).map(row => row.status)))
            .resolves.toStrictEqual(['pending', 'pending', 'pending', 'pending']);
    });

    test('an unblock reads as many blocked jobs as fit by the settings of the oldest one: a cheaper job after them '
        + 'waits for the next unblock, at once', async () => {
        const { p, sqlane, store } = await freshTables();
        // 3 per hour, bursts of 3: 20 min per start
        const quota = defineRateLimit({ name: 'quota', max: 3, per: '1h', burst: 3 });
        const ids = [];

        for (const [at, cost] of [3, 2, 1, 1].entries()) {
            // oxlint-disable-next-line no-await-in-loop -- in the order of run_at
            ids.push((await sqlane.enqueue(testAdapter.pool, 'call', {}, {
                globalRateLimits: [quota.cost(cost)],
                runAt: ago(70 - at),
            })).id);
        }

        await claimWithBlocks(store, ids.slice(0, 1), 'T1', ids.slice(1));
        // No debt: room for the job of cost 2 and one of cost 1, but the oldest one fits alone by its settings
        await database.query(SET_TAT_SQL[database.family](p), ['@quota', 0]);

        const first = await store.unblockRates(['@quota']);

        expect(first).toMatchObject({
            names: ['call'],
            waits: [{ key: '@quota', delayMs: 0, left: true }],
        });
        await expect(statuses(p).then(rows => rows.slice(1).map(row => row.status)))
            .resolves.toStrictEqual(['pending', 'blocked', 'blocked']);

        // With the debt of the first: the job of cost 1, then the next one in 20 min
        const second = await store.unblockRates(['@quota'], new Map([['@quota', Number(first.waits[0].debtUs)]]));

        expect(second).toMatchObject({ names: ['call'], waits: [{ key: '@quota', left: true }] });
        expect(second.waits[0].delayMs).toBeGreaterThan((20 * 60_000) - 5000);
        await expect(statuses(p).then(rows => rows.slice(1).map(row => row.status)))
            .resolves.toStrictEqual(['pending', 'pending', 'blocked']);
    });

    test('an unblock that finds every blocked job of its key locked checks the key again in a second', async () => {
        const { p, sqlane, store } = await freshTables();
        const once = defineRateLimit({ name: 'once', max: 1, per: '1h' });
        const ids = [];

        for (const secondsAgo of [30, 20, 10]) {
            // oxlint-disable-next-line no-await-in-loop -- in the order of run_at
            ids.push((await sqlane.enqueue(testAdapter.pool, 'tick', {}, {
                globalRateLimits: [once],
                runAt: ago(secondsAgo),
            })).id);
        }

        await claimWithBlocks(store, ids.slice(0, 1), 'T1', ids.slice(1));
        await database.query(SET_TAT_SQL[database.family](p), ['@once', 0]);

        // Another unblock holds them
        const other = await testAdapter.connect();

        try {
            await other.begin();
            await other.execute(`SELECT id FROM ${p}jobs WHERE status = 'blocked' FOR UPDATE`);
            await expect(store.unblockRates(['@once'])).resolves.toStrictEqual({
                names: [],
                waits: [{ key: '@once', delayMs: 1000, debtUs: null, left: false }],
            });
        } finally {
            await other.commit();
            other.release();
        }
    });

    test('an unblock whose oldest blocked job does not fit waits for it, though a cheaper one after it, past a lock, '
        + 'would fit', async () => {
        const { p, sqlane, store } = await freshTables();
        // 3 per hour, bursts of 3: 20 min per start
        const quota = defineRateLimit({ name: 'quota', max: 3, per: '1h', burst: 3 });
        const ids = [];

        for (const [at, cost] of [3, 2, 1].entries()) {
            // oxlint-disable-next-line no-await-in-loop -- in the order of run_at
            ids.push((await sqlane.enqueue(testAdapter.pool, 'call', {}, {
                globalRateLimits: [quota.cost(cost)],
                runAt: ago(70 - at),
            })).id);
        }

        await claimWithBlocks(store, ids.slice(0, 1), 'T1', ids.slice(1));
        // Two starts of debt: room for one of cost 1, not for the oldest blocked one (cost 2)
        await database.query(SET_TAT_SQL[database.family](p), ['@quota', -40 * 60]);

        // Another transaction holds the oldest blocked job
        const other = await testAdapter.connect();

        try {
            await other.begin();
            await other.execute(`SELECT id FROM ${p}jobs WHERE id = '${ids[1]}' FOR UPDATE`);

            const unblocked = await store.unblockRates(['@quota']);

            // Its wait: one more start of debt, 20 min
            expect(unblocked).toMatchObject({ names: [], waits: [{ key: '@quota', debtUs: null, left: true }] });
            expect(unblocked.waits[0].delayMs).toBeGreaterThan((20 * 60_000) - 5000);
        } finally {
            await other.commit();
            other.release();
        }

        await expect(statuses(p).then(rows => rows.slice(1).map(row => row.status)))
            .resolves.toStrictEqual(['blocked', 'blocked']);
    });

    test.each([true, false])('the claim reads the jobs blocked on a rate key after it locks its row: a job blocked '
        + 'meanwhile holds the newer ones (withRates: %s)', async (withRates) => {
        const { p, sqlane, store } = await freshTables();
        const once = defineRateLimit({ name: 'once', max: 1, per: '1h' });
        const older = await sqlane.enqueue(testAdapter.pool, 'tick', {}, { globalRateLimits: [once], runAt: ago(20) });
        const newer = await sqlane.enqueue(testAdapter.pool, 'tick', {}, { globalRateLimits: [once], runAt: ago(10) });

        await database.query(SET_TAT_SQL[database.family](p), ['@once', 0]);

        // Another claim holds the row of the key, and blocks the older job on it
        const other = await testAdapter.connect();

        try {
            await other.begin();
            await other.execute(`SELECT limit_key FROM ${p}rate_limits WHERE limit_key = '@once' FOR UPDATE`);
            await other.execute(`UPDATE ${p}jobs SET status = 'blocked', blocked_on = '@once' WHERE id = '${older.id}'`);

            const claiming = store.claim({
                candidateIds: [newer.id],
                fullIds: [],
                lockToken: 'T1',
                lockedBy: 'test:T1',
                leaseMs: LEASE_MS,
                pick: pickFits,
                withRates,
            });

            // The claim waits for the row
            await sleep(200);
            await other.commit();
            await expect(claiming).resolves.toMatchObject({ jobs: [], blockedKeys: ['@once'] });
        } finally {
            other.release();
        }

        await expect(statuses(p)).resolves.toStrictEqual([
            { id: older.id, status: 'blocked', blocked_on: '@once' },
            { id: newer.id, status: 'blocked', blocked_on: '@once' },
        ]);
    });

    test('the cleanup deletes the rows of the keys whose tat passed', async () => {
        const { p, sqlane, store } = await freshTables();
        const once = defineRateLimit({ name: 'once', max: 1, per: '1h' });
        const brief = defineRateLimit({ name: 'brief', max: 1, per: 1 });
        const ids = [];

        for (const limit of [once, brief]) {
            // oxlint-disable-next-line no-await-in-loop -- one after the other
            ids.push((await sqlane.enqueue(testAdapter.pool, 'x', {}, { globalRateLimits: [limit], runAt: ago(5) })).id);
        }

        await claimAll(store, ids, 'T1');
        await sleep(5);
        await expect(store.deleteIdleRateKeys(1000)).resolves.toBe(1);
        await expect(aheadMs(p).then(Object.keys)).resolves.toStrictEqual(['@once']);
    });

    test('the claim of names without limits leaves the jobs with rate limits', async () => {
        const { sqlane, store } = await freshTables();

        await sqlane.enqueue(testAdapter.pool, 'plain', {}, { globalRateLimits: [api.key('a1')], runAt: ago(20) });

        const plain = await sqlane.enqueue(testAdapter.pool, 'plain', {}, { runAt: ago(10) });

        await expect(claimDueWithNext(store, { requests: [request('plain', 5, 0)] })).resolves.toMatchObject({
            jobs: [{ id: plain.id }],
            limited: ['plain'],
        });
    });

    test('a search that leaves the rate keys out finds a job with rate keys past the max of its name', async () => {
        const { sqlane, store } = await freshTables();
        const once = defineRateLimit({ name: 'once', max: 1, per: '1h' });
        const ids = [];

        // Two jobs without rate keys, then three with them from their enqueue options: one fits, two are full
        for (const [at, options] of [{}, {}, ...Array.from({ length: 3 }, () => ({ globalRateLimits: [once] }))]
            .entries()) {
            // oxlint-disable-next-line no-await-in-loop -- in the order of run_at
            ids.push((await sqlane.enqueue(testAdapter.pool, 'mixed', {}, { ...options, runAt: ago(50 - at) })).id);
        }

        const limits = new Map([['mixed', 2]]);
        const found = await store.findCandidates(limits);

        expect(found.startable.map(job => job.id)).toStrictEqual(ids.slice(0, 2));
        expect(found.full.map(job => job.id)).toStrictEqual(ids.slice(3));

        const ratedNames = new Set();

        await expect(store.findCandidates(limits, ratedNames)).resolves.toStrictEqual(found);
        expect([...ratedNames]).toStrictEqual(['mixed']);
    });

    test('getStats counts the jobs blocked on a rate key as pending', async () => {
        const { sqlane, store } = await freshTables();

        await enqueueCalls(sqlane, 6, { account: 'a1' });
        await claimCandidates(store, new Map([['call_api', 10]]), 'T1');

        await expect(sqlane.getStats()).resolves.toMatchObject([
            { name: 'call_api', pending: 2, due: 0, running: 4 },
        ]);
    });
});
