import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { chooseRows } from '../../src/fair_share.js';
import { createSqlane, defineConcurrencyLimit, defineRateLimit } from '../../src/index.js';
import { createStore } from '../../src/store/store.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';
import { handle, runnerOf, testLane } from '../support/runners.js';

/** @typedef {import('../../src/store/store.js').ClaimedJob} ClaimedJob */
/** @typedef {import('../../src/types.js').Sqlane<any>} Sqlane */

const LEASE_MS = 240_000;

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

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} A held slot of a key, of no job of the tests */
const HELD_SLOT_SQL = {
    mysql: p => `INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
                 VALUES (?, 0, 'other', 'other', NULL, UTC_TIMESTAMP(3))`,
    postgres: p => `INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
                    VALUES ($1, 0, 'other', 'other', NULL, clock_timestamp())`,
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} The jobs due now, by id */
const DUE_SQL = {
    mysql: p => `SELECT id FROM ${p}jobs WHERE status = 'pending' AND run_at <= UTC_TIMESTAMP(3) ORDER BY id`,
    postgres: p => `SELECT id FROM ${p}jobs WHERE status = 'pending' AND run_at <= clock_timestamp() ORDER BY id`,
};

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

// The runners of a test stop with it: their polls would load the tests of the other files
afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await testAdapter?.close();
    await database?.close();
});

/**
 * Tables of their own for a test.
 * @param {Partial<import('../../src/types.js').SqlaneOptions<any>>} [options]
 * @returns {Promise<{ p: string, sqlane: Sqlane, store: import('../../src/store/store.js').Store }>}
 */
async function freshTables(options = {}) {
    prefixCount++;

    const p = `${database.tablePrefix}${prefixCount}_`;
    const sqlane = createSqlane({ adapter: testAdapter.adapter, tablePrefix: p, ...options });

    instances.push(sqlane);
    await sqlane.schema.migrate();

    return { p, sqlane, store: createStore(testAdapter.adapter, p) };
}

/**
 * @param {number} secondsAgo
 * @returns {Date}
 */
function ago(secondsAgo) {
    return new Date(Date.now() - (secondsAgo * 1000));
}

/**
 * @param {string} p
 * @returns {Promise<Record<string, string>>} The status of each job, by id; with its key when blocked.
 */
async function statuses(p) {
    const rows = await database.query(`SELECT id, status, blocked_on FROM ${p}jobs`);

    return Object.fromEntries(rows.map(row => [
        String(row.id),
        row.blocked_on === null ? String(row.status) : `${String(row.status)} ${String(row.blocked_on)}`,
    ]));
}

/**
 * Blocks pending jobs on a key, as a claim would.
 * @param {string} p
 * @param {string} key
 * @param {string[]} ids
 */
async function block(p, key, ids) {
    for (const id of ids) {
        // oxlint-disable-next-line no-await-in-loop -- one by one
        await database.query(database.family === 'postgres'
            ? `UPDATE ${p}jobs SET status = 'blocked', blocked_on = $1 WHERE id = $2`
            : `UPDATE ${p}jobs SET status = 'blocked', blocked_on = ? WHERE id = ?`, [key, id]);
    }
}

/**
 * Picks the locked jobs: all of them.
 * @param {ClaimedJob[]} locked
 * @returns {ClaimedJob[]}
 */
const pickAll = locked => locked;

/**
 * @param {import('../../src/store/store.js').Store} store
 * @param {string[]} candidateIds
 * @param {string[]} [fullIds]
 * @returns {Promise<import('../../src/store/store.js').ClaimResult>}
 */
function claim(store, candidateIds, fullIds = []) {
    return store.claim({
        candidateIds,
        fullIds,
        lockToken: 'TOKEN1',
        lockedBy: 'test:TOKEN1',
        leaseMs: LEASE_MS,
        pick: pickAll,
    });
}

/**
 * @param {import('../../src/store/store.js').Store} store
 * @param {string[]} lanes Each with a share of its own, up to 10 jobs.
 * @returns {Promise<import('../../src/store/store.js').ClaimDueResult>}
 */
function claimDue(store, lanes) {
    const requests = lanes.map((name, tie) => ({ name, maxJobs: 10, running: 0, weight: 1, limits: [], tie }));

    return store.claimDue({
        requests,
        limitRooms: [],
        free: 100,
        lockToken: 'TOKEN1',
        lockedBy: 'test:TOKEN1',
        leaseMs: LEASE_MS,
        choose: locked => chooseRows({
            rows: locked,
            lanes: requests.map(due => ({
                name: due.name, index: due.tie, weight: 1, running: 0, limits: [], available: Infinity,
            })),
            free: 100,
            base: 0,
            size: requests.length,
        }).chosen,
    });
}

/**
 * @param {import('../../src/store/store.js').ProbeRow[] | null} rows
 * @returns {string[]} The lanes, sorted.
 */
const lanesOf = rows => (rows ?? []).map(row => row.name).toSorted();

/**
 * A due job of `paused` and one of `other`, `paused` paused.
 * @returns {Promise<{ p: string, sqlane: Sqlane, store: import('../../src/store/store.js').Store,
 *     paused: { id: string }, other: { id: string } }>}
 */
async function pausedAndOther() {
    const tables = await freshTables();
    const paused = await tables.sqlane.enqueue(testAdapter.pool, testLane('paused'), {}, { runAt: ago(20) });
    const other = await tables.sqlane.enqueue(testAdapter.pool, testLane('other'), {}, { runAt: ago(10) });

    await tables.store.pauseLane('paused');

    return { ...tables, paused, other };
}

/**
 * Claims the due jobs of a lane in a loop, while it is paused and resumed `rounds` times.
 * @param {import('../../src/store/store.js').Store} store
 * @param {string} lane
 * @param {number} rounds
 * @returns {Promise<{ claimed: number, claimedWhilePaused: string[] }>} The jobs claimed, and those of the claims
 *     that started after a pause committed and ended before the resume that followed it.
 */
async function raceClaimsWithPauses(store, lane, rounds) {
    const state = { done: false };
    /** The pause of this round committed, its resume not sent yet */
    let paused = false;
    let round = 0;
    let claimed = 0;
    /** @type {string[]} */
    const claimedWhilePaused = [];
    const claims = (async () => {
        while (!state.done) {
            const before = { paused, round };
            // oxlint-disable-next-line no-await-in-loop -- one claim after the other
            const { jobs } = await claimDue(store, [lane]);
            const within = before.paused && paused && before.round === round;

            claimed += jobs.length;
            claimedWhilePaused.push(...within ? jobs.map(job => job.id) : []);
            if (jobs.length) {
                // oxlint-disable-next-line no-await-in-loop -- one claim after the other
                await store.completeJobs(jobs);
            }
        }
    })();

    for (; round < rounds; round++) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await store.pauseLane(lane);
        paused = true;
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await sleep(5);
        paused = false;
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await store.resumeLane(lane);
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await sleep(2);
    }

    state.done = true;
    await claims;

    return { claimed, claimedWhilePaused };
}

describe('the pauses of the store', () => {
    test('pauseLane keeps the time of the first pause; resumeLane tells whether the lane was paused', async () => {
        const { p, store } = await freshTables();

        await expect(store.readPausedLanes()).resolves.toStrictEqual([]);
        await store.pauseLane('b');
        await store.pauseLane('a');

        const first = await pausedAtOf(p);

        await sleep(5);
        await store.pauseLane('a');
        await expect(pausedAtOf(p)).resolves.toStrictEqual(first);
        expect(Object.keys(first)).toStrictEqual(['a', 'b']);
        expect(Math.abs(first.a - Date.now())).toBeLessThan(5000);
        await expect(store.resumeLane('a')).resolves.toBe(true);
        await expect(store.resumeLane('a')).resolves.toBe(false);
        await expect(store.readPausedLanes()).resolves.toStrictEqual(['b']);
    });

    test('with a connection: in its transaction, rolled back with it', async () => {
        const { store } = await freshTables();
        const connection = await testAdapter.connect();

        try {
            await connection.begin();
            await store.pauseLane('a', connection.raw);
            await connection.rollback();
            await connection.begin();
            await store.pauseLane('b', connection.raw);
            await connection.commit();
        } finally {
            connection.release();
        }

        await expect(store.readPausedLanes()).resolves.toStrictEqual(['b']);
    });

    test('blockedKeysOfLane: the keys of the blocked jobs of the lane, once each', async () => {
        const { p, sqlane, store } = await freshTables();
        const jobs = await sqlane.enqueueMany(testAdapter.pool, testLane('a'), [{ payload: {} }, { payload: {} }, {
            payload: {},
        }, { payload: {} }]);
        const [other] = await sqlane.enqueueMany(testAdapter.pool, testLane('b'), [{ payload: {} }]);

        await block(p, 'k1', [jobs[0].id, jobs[1].id]);
        await block(p, '@r1', [jobs[2].id]);
        await block(p, 'k2', [other.id]);

        await expect(store.blockedKeysOfLane('a').then(keys => keys.toSorted())).resolves.toStrictEqual(['@r1', 'k1']);
        await expect(store.blockedKeysOfLane('c')).resolves.toStrictEqual([]);
    });
});

/**
 * @param {string} p
 * @returns {Promise<Record<string, number>>} The time of the pause of each paused lane, as epoch ms, by lane.
 */
async function pausedAtOf(p) {
    const ms = database.family === 'postgres'
        ? 'floor(EXTRACT(EPOCH FROM paused_at) * 1000)::bigint'
        : 'TIMESTAMPDIFF(MICROSECOND, \'1970-01-01\', paused_at) DIV 1000';
    const rows = await database.query(`SELECT lane, ${ms} AS ms FROM ${p}paused_lanes ORDER BY lane`);

    return Object.fromEntries(rows.map(row => [String(row.lane), Number(row.ms)]));
}

/**
 * @param {string} p
 * @returns {Promise<number>} The updated_at of the one schedule, as epoch ms.
 */
async function updatedAtOf(p) {
    const ms = database.family === 'postgres'
        ? 'floor(EXTRACT(EPOCH FROM updated_at) * 1000)::bigint'
        : 'TIMESTAMPDIFF(MICROSECOND, \'1970-01-01\', updated_at) DIV 1000';
    const [row] = await database.query(`SELECT ${ms} AS ms FROM ${p}schedules`);

    return Number(row.ms);
}

/**
 * @param {string} p
 * @returns {Promise<Record<string, unknown>[]>} The rows of the schedules: their cursor and pause as epoch ms.
 */
async function scheduleRows(p) {
    const ms = (/** @type {string} */ column) => (database.family === 'postgres'
        ? `floor(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`
        : `TIMESTAMPDIFF(MICROSECOND, '1970-01-01', ${column}) DIV 1000`);
    const rows = await database.query(`SELECT id, lane, spec, ${ms('last_slot_at')} AS last_slot_ms,
        ${ms('paused_at')} AS paused_ms FROM ${p}schedules ORDER BY id`);

    return rows.map(row => ({
        id: row.id,
        lane: row.lane,
        spec: row.spec,
        lastSlotMs: Number(row.last_slot_ms),
        pausedMs: row.paused_ms === null ? null : Number(row.paused_ms),
    }));
}

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} The cursor of every schedule in 2100 */
const FAR_CURSOR_SQL = {
    mysql: p => `UPDATE ${p}schedules SET last_slot_at = '2100-01-01 00:00:00'`,
    postgres: p => `UPDATE ${p}schedules SET last_slot_at = '2100-01-01T00:00:00Z'`,
};

/**
 * Waits up to 3 s for the condition.
 * @param {() => boolean} condition
 * @returns {Promise<void>}
 */
async function waitUntil(condition) {
    const deadline = Date.now() + 3000;

    // oxlint-disable-next-line no-await-in-loop -- polls
    while (!condition() && Date.now() < deadline) {
        // oxlint-disable-next-line no-await-in-loop -- polls
        await sleep(10);
    }
}

describe('the pauses of the schedules in the store', () => {
    test('pauseSchedule: no row, a paused row with its cursor at now; a row, paused once, its cursor and spec kept',
        async () => {
            const { p, store } = await freshTables();

            await store.pauseSchedule({ id: 'a:k', lane: 'a', spec: 'every 60000' });

            const [created] = await scheduleRows(p);

            expect(created).toStrictEqual({
                id: 'a:k',
                lane: 'a',
                spec: 'every 60000',
                lastSlotMs: expect.any(Number),
                pausedMs: created.lastSlotMs,
            });
            expect(Math.abs(Number(created.lastSlotMs) - Date.now())).toBeLessThan(5000);

            await sleep(5);
            await store.pauseSchedule({ id: 'a:k', lane: 'a', spec: 'every 1000' });
            await expect(scheduleRows(p)).resolves.toStrictEqual([created]);
        });

    test('resumeSchedule: the cursor moves to now, the pause goes; an unpaused row or no row: unchanged, false',
        async () => {
            const { p, store } = await freshTables();

            await store.pauseSchedule({ id: 'a:k', lane: 'a', spec: 'every 60000' });

            const [paused] = await scheduleRows(p);

            await sleep(20);
            await expect(store.resumeSchedule('a:k')).resolves.toBe(true);

            const [resumed] = await scheduleRows(p);

            expect(resumed.pausedMs).toBeNull();
            expect(resumed.lastSlotMs).toBeGreaterThan(Number(paused.lastSlotMs));
            await expect(store.resumeSchedule('a:k')).resolves.toBe(false);
            await expect(scheduleRows(p)).resolves.toStrictEqual([resumed]);
            await expect(store.resumeSchedule('b:k')).resolves.toBe(false);
        });

    test('pauseSchedule: updated_at moves when it pauses, not when the row was paused already', async () => {
        const { p, store } = await freshTables();

        await store.pauseSchedule({ id: 'a:k', lane: 'a', spec: 'every 60000' });
        await store.resumeSchedule('a:k');

        const resumed = await updatedAtOf(p);

        await sleep(20);
        await store.pauseSchedule({ id: 'a:k', lane: 'a', spec: 'every 60000' });

        const paused = await updatedAtOf(p);

        expect(paused).toBeGreaterThan(resumed);
        await sleep(20);
        await store.pauseSchedule({ id: 'a:k', lane: 'a', spec: 'every 60000' });
        await expect(updatedAtOf(p)).resolves.toBe(paused);
    });

    test('resumeSchedule: a cursor ahead of now stays', async () => {
        const { p, store } = await freshTables();

        await store.pauseSchedule({ id: 'a:k', lane: 'a', spec: 'every 60000' });
        await database.query(FAR_CURSOR_SQL[database.family](p));
        await store.resumeSchedule('a:k');
        await expect(scheduleRows(p)).resolves.toMatchObject([{ lastSlotMs: Date.UTC(2100, 0, 1), pausedMs: null }]);
    });

    test('removeSchedule: the row goes, paused or not; no row: false', async () => {
        const { p, store } = await freshTables();

        await store.pauseSchedule({ id: 'a:k', lane: 'a', spec: 'every 60000' });
        await expect(store.removeSchedule('a:k')).resolves.toBe(true);
        await expect(store.removeSchedule('a:k')).resolves.toBe(false);
        await expect(scheduleRows(p)).resolves.toStrictEqual([]);
    });

    test('with a connection: in its transaction, rolled back with it', async () => {
        const { p, store } = await freshTables();
        const connection = await testAdapter.connect();

        try {
            await connection.begin();
            await store.pauseSchedule({ id: 'a:k', lane: 'a', spec: 'every 60000' }, connection.raw);
            await connection.rollback();
        } finally {
            connection.release();
        }

        await expect(scheduleRows(p)).resolves.toStrictEqual([]);
    });
});

/** A read of the blocked jobs before any probe (the pauses checked in SQL), and after one (the lanes that it saw) */
const PROBED = ['no probe yet', 'after a probe'];

/**
 * @param {import('../../src/store/store.js').Store} store
 * @param {string} seen One of PROBED.
 * @returns {Promise<void>}
 */
async function afterProbe(store, seen) {
    if (seen === PROBED[1]) {
        await store.probe(null);
    }
}

describe('a paused lane: the claims skip it wherever a lane is chosen', () => {
    test('the probe of every lane and of given lanes', async () => {
        const { store } = await pausedAndOther();

        await expect(store.probe(null).then(lanesOf)).resolves.toStrictEqual(['other']);
        await expect(store.probe(['paused', 'other']).then(lanesOf)).resolves.toStrictEqual(['other']);
        await expect(store.probe(['paused'])).resolves.toStrictEqual([]);

        await store.resumeLane('paused');
        await expect(store.probe(null).then(lanesOf)).resolves.toStrictEqual(['other', 'paused']);
        await expect(store.probe(['paused']).then(lanesOf)).resolves.toStrictEqual(['paused']);
    });

    test.each(PROBED)('the search of candidates: none of a paused lane (%s)', async (seen) => {
        const { store, other } = await pausedAndOther();

        await afterProbe(store, seen);
        await expect(store.findCandidates(new Map([['paused', 10], ['other', 10]])))
            .resolves.toMatchObject({ startable: [{ id: other.id }], full: [] });
    });

    test('the claim of candidates: a job of a paused lane is neither claimed nor blocked', async () => {
        const { p, store, paused } = await pausedAndOther();

        await expect(claim(store, [paused.id], [paused.id])).resolves.toStrictEqual({
            jobs: [], blockedKeys: [], blockedLanes: [], rateWaits: [],
        });
        await expect(statuses(p)).resolves.toMatchObject({ [paused.id]: 'pending' });
    });

    test('the claim of due jobs of several lanes: none of a paused lane, nor its next due time', async () => {
        const { store, sqlane, other } = await pausedAndOther();

        await sqlane.enqueue(testAdapter.pool, testLane('paused'), {}, { delay: '1h' });
        await sqlane.enqueue(testAdapter.pool, testLane('other'), {}, { delay: '1h' });

        const result = await claimDue(store, ['paused', 'other']);

        expect(result.jobs.map(job => job.id)).toStrictEqual([other.id]);
        expect(lanesOf(result.next).filter(lane => lane === 'paused')).toStrictEqual([]);
        expect(result.limited).toStrictEqual([]);
    });

    test('the claim of due jobs of one paused lane: none, nor its next due time', async () => {
        const { store, sqlane } = await pausedAndOther();

        await sqlane.enqueue(testAdapter.pool, testLane('paused'), {}, { delay: '1h' });

        await expect(claimDue(store, ['paused'])).resolves.toMatchObject({ jobs: [], next: [], limited: [] });
    });

    test('makeDue (drain({ includeDelayed })): not the delayed jobs of a paused lane', async () => {
        const { p, store, sqlane, paused, other } = await pausedAndOther();
        const pausedLater = await sqlane.enqueue(testAdapter.pool, testLane('paused'), {}, { delay: '1h' });
        const otherLater = await sqlane.enqueue(testAdapter.pool, testLane('other'), {}, { delay: '1h' });

        await store.makeDue(['paused', 'other']);

        const due = (await database.query(DUE_SQL[database.family](p))).map(row => String(row.id));

        expect(due).toStrictEqual([paused.id, other.id, otherLater.id].toSorted());
        expect(due).not.toContain(pausedLater.id);
    });

    test.each(PROBED)('a shared concurrency key: its room and its unblocked jobs come from the jobs of lanes not paused '
        + '(%s)', async (seen) => {
        const { p, sqlane, store } = await freshTables();
        // One name, two maxes: the room of the key is by the max of its oldest blocked job
        const one = defineConcurrencyLimit({ name: 'shared', max: 1 });
        const two = defineConcurrencyLimit({ name: 'shared', max: 2 });
        const paused = await sqlane.enqueue(testAdapter.pool, testLane('paused'), {}, {
            globalConcurrencyLimits: [one.key('k')],
            runAt: ago(20),
        });
        const other = await sqlane.enqueue(testAdapter.pool, testLane('other'), {}, {
            globalConcurrencyLimits: [two.key('k')],
            runAt: ago(10),
        });

        // One slot held: room for one more by the max of `other`, none by that of `paused`
        await database.query(HELD_SLOT_SQL[database.family](p), ['shared:k']);
        await block(p, 'shared:k', [paused.id, other.id]);
        await store.pauseLane('paused');
        await afterProbe(store, seen);

        await expect(store.unblock(['shared:k'])).resolves.toStrictEqual(['other']);
        await expect(statuses(p)).resolves.toStrictEqual({
            [paused.id]: 'blocked shared:k',
            [other.id]: 'pending',
        });
    });

    test.each(PROBED)('a shared rate key: the unblock reads its head and its queue among the jobs of lanes not paused '
        + '(%s)', async (seen) => {
        const { p, sqlane, store } = await freshTables();
        // One key, two settings: one start an hour for `paused`, 10 a second for `other`
        const slow = defineRateLimit({ name: 'shared', max: 1, per: '1h' });
        const fast = defineRateLimit({ name: 'shared', max: 10, per: '1s', burst: 10 });
        const paused = await sqlane.enqueue(testAdapter.pool, testLane('paused'), {}, {
            globalRateLimits: [slow],
            runAt: ago(20),
        });
        const others = await sqlane.enqueueMany(testAdapter.pool, testLane('other'), [10, 9].map(secondsAgo => ({
            payload: {},
            options: { globalRateLimits: [fast], runAt: ago(secondsAgo) },
        })));

        // A debt of 0.5 s: none for `paused` (an hour each), 5 for `other`
        await database.query(SET_TAT_SQL[database.family](p), ['@shared', -0.5]);
        await block(p, '@shared', [paused.id, ...others.map(job => job.id)]);
        await store.pauseLane('paused');
        await afterProbe(store, seen);

        await expect(store.unblockRates(['@shared'])).resolves.toMatchObject({ lanes: ['other'] });
        await expect(statuses(p)).resolves.toStrictEqual({
            [paused.id]: 'blocked @shared',
            [others[0].id]: 'pending',
            [others[1].id]: 'pending',
        });
    });

    test.each(PROBED)('a shared rate key: a blocked job of a paused lane does not hold the newer jobs of other lanes '
        + 'behind it (%s)', async (seen) => {
        const { p, sqlane, store } = await freshTables();
        const api = defineRateLimit({ name: 'api', max: 10, per: '1s', burst: 10 });
        const paused = await sqlane.enqueue(testAdapter.pool, testLane('paused'), {}, {
            globalRateLimits: [api],
            runAt: ago(20),
        });
        const other = await sqlane.enqueue(testAdapter.pool, testLane('other'), {}, {
            globalRateLimits: [api],
            runAt: ago(10),
        });

        await block(p, '@api', [paused.id]);
        await store.pauseLane('paused');
        await afterProbe(store, seen);

        // The search, then the claim: each reads the oldest job blocked on the key
        await expect(store.findCandidates(new Map([['other', 10]])))
            .resolves.toMatchObject({ startable: [{ id: other.id }], full: [] });
        await expect(claim(store, [other.id]))
            .resolves.toMatchObject({ jobs: [{ id: other.id }], blockedKeys: [] });
    });

    test('pause and resume that race claims: no error, and no job of the lane claimed while it is paused',
        async () => {
            const { sqlane, store } = await freshTables();

            await sqlane.enqueueMany(testAdapter.pool, testLane('raced'), Array.from({ length: 300 }, () => ({
                payload: {},
            })));

            const { claimed, claimedWhilePaused } = await raceClaimsWithPauses(store, 'raced', 30);

            expect(claimedWhilePaused).toStrictEqual([]);
            expect(claimed).toBeGreaterThan(0);
        });
});

describe('a paused lane in a runner', () => {
    test('drain() runs the other lanes and ends: the due jobs of the paused lane wait', async () => {
        const { p, sqlane, store, paused, other } = await pausedAndOther();
        /** @type {string[]} */
        const ran = [];
        const runner = runnerOf(sqlane);

        runner.mount([handle('paused', ({ job }) => {
            ran.push(job.id);
        }), handle('other', ({ job }) => {
            ran.push(job.id);
        })]);

        await expect(runner.drain({ timeout: '5s' })).resolves.toStrictEqual({ completed: 1, retried: 0, failed: 0 });
        await expect(runner.drain({ timeout: '5s', includeDelayed: true }))
            .resolves.toStrictEqual({ completed: 0, retried: 0, failed: 0 });
        expect(ran).toStrictEqual([other.id]);
        await expect(statuses(p)).resolves.toMatchObject({ [paused.id]: 'pending', [other.id]: 'completed' });

        await store.resumeLane('paused');
        await expect(runner.drain({ timeout: '5s' })).resolves.toStrictEqual({ completed: 1, retried: 0, failed: 0 });
        expect(ran).toStrictEqual([other.id, paused.id]);
    });

    test('a started runner: no claim of the paused lane, no busy loop; it claims at its next poll after a resume',
        async () => {
            prefixCount++;

            const p = `${database.tablePrefix}${prefixCount}_`;
            let statements = 0;
            const { adapter } = testAdapter;
            const counted = {
                ...adapter,
                queue: {
                    query: (/** @type {string} */ sql, /** @type {readonly unknown[]} */ params) => {
                        statements++;

                        return adapter.queue.query(sql, params);
                    },
                    run: adapter.queue.run,
                },
            };
            const sqlane = createSqlane({ adapter: counted, tablePrefix: p, pollInterval: '100ms' });
            const store = createStore(adapter, p);
            /** @type {string[]} */
            const ran = [];

            instances.push(sqlane);
            await sqlane.schema.migrate();
            await store.pauseLane('paused');

            const job = await sqlane.enqueue(testAdapter.pool, testLane('paused'), {}, { runAt: ago(10) });
            const runner = runnerOf(sqlane);

            runner.mount([handle('paused', ({ job: running }) => {
                ran.push(running.id);
            })]);
            await runner.start();
            await sleep(100);
            statements = 0;
            await sleep(500);
            // A poll each 100 ms, with its few statements: not a loop of claims
            expect(statements).toBeLessThan(40);
            expect(ran).toStrictEqual([]);

            await store.resumeLane('paused');

            await waitUntil(() => ran.length > 0);
            expect(ran).toStrictEqual([job.id]);
        });
});
