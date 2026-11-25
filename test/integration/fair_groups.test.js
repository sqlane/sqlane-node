import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import {
    ConfigError, createRunner, createSqlane, defineConcurrencyLimit, defineHandler, defineLane, defineSchedule,
    InvalidOptionsError,
} from '../../src/index.js';
import { resolveDefaults } from '../../src/defaults.js';
import { orderDueRows, requestGroups } from '../../src/fair_groups.js';
import { chooseRows, shareLanesOfRequests } from '../../src/fair_share.js';
import { buildNewJob } from '../../src/new_job.js';
import { insertScheduledJobsPostgres } from '../../src/store/postgres_schedules.js';
import { createStore } from '../../src/store/store.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';
import { handle, runnerOf } from '../support/runners.js';

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
/** @type {import('../../src/types.js').Sqlane<any>} */
let sqlane;

const isPostgres = inject('databaseDialect') === 'postgres';
/** A lease that ended a minute ago */
const PAST_LEASE = isPostgres ? 'now() - interval \'1 minute\'' : 'UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE';
/** The first parameter of a statement */
const PARAM_1 = isPostgres ? '$1' : '?';
/** A global limit of one key, as the column of the dialect stores it */
const ONE_LIMIT_SQL = isPostgres
    ? 'limit_keys = ARRAY[\'k\'], limit_maxes = ARRAY[1]'
    : 'limit_keys = \'["k"]\', limit_maxes = \'[1]\'';

beforeAll(async () => {
    database = await connectTestDatabase();
    testAdapter = createTestAdapter();
    sqlane = createSqlane({ adapter: testAdapter.adapter, tablePrefix: database.tablePrefix });
    await sqlane.schema.migrate();
});

afterAll(async () => {
    await sqlane?.close({ deadline: 0 });
    await testAdapter?.close();
    await database?.close();
});

/**
 * @param {string} id
 * @param {string} [p] The table prefix. Default: the one of the file.
 * @returns {Promise<string | null | undefined>} The stored group of the job; undefined: no such job.
 */
async function groupOf(id, p = database.tablePrefix) {
    const [row] = await database.query(`SELECT fair_group FROM ${p}jobs WHERE id = ${PARAM_1}`, [id]);

    return row && /** @type {string | null} */ (row.fair_group);
}

const convert = defineLane({ name: 'convert', fairGroup: ({ payload }) => payload.queue });

describe('the group at enqueue', () => {
    test('enqueue and enqueueMany write the group of the definition; null: none', async () => {
        const one = await sqlane.enqueue(testAdapter.pool, convert, { queue: 'backend-1' });
        const many = await sqlane.enqueueMany(testAdapter.pool, convert, [
            { payload: { queue: 'backend-2' } },
            { payload: { queue: null } },
            { payload: {} },
        ]);

        await expect(groupOf(one.id)).resolves.toBe('backend-1');
        // One after the other: one client of the test database
        const groups = [];

        for (const { id } of many) {
            // oxlint-disable-next-line no-await-in-loop -- one client
            groups.push(await groupOf(id));
        }

        expect(groups).toStrictEqual(['backend-2', null, null]);
    });

    test('a lane without fairGroup: no group', async () => {
        const { id } = await sqlane.enqueue(testAdapter.pool, defineLane({ name: 'plain' }), { queue: 'x' });

        await expect(groupOf(id)).resolves.toBeNull();
    });

    test('a duplicate keeps the group of the stored job', async () => {
        const first = await sqlane.enqueue(testAdapter.pool, convert, { queue: 'a' }, { dedupeKey: 'same' });
        const second = await sqlane.enqueue(testAdapter.pool, convert, { queue: 'b' }, { dedupeKey: 'same' });

        expect(second).toStrictEqual({ id: first.id, created: false });
        await expect(groupOf(first.id)).resolves.toBe('a');
    });

    test('the slot of a schedule, by schedules.runSlot(): the group of its payload', async () => {
        const hourly = defineSchedule(convert, { key: 'hourly', every: '1h', payload: { queue: 'cron' } });
        const { id } = await sqlane.schedules.runSlot(hourly);

        await expect(groupOf(id)).resolves.toBe('cron');
    });

    test.runIf(isPostgres)('the slots of the scheduler, by their own insert (PostgreSQL)', async () => {
        const job = buildNewJob({
            lane: 'convert',
            definition: convert,
            defaults: resolveDefaults(),
            payload: { queue: 'fired' },
            options: undefined,
            maxPayloadBytes: 1000,
            slot: { at: Date.parse('2026-11-25T00:00:00.000Z'), key: 'k' },
        });

        await insertScheduledJobsPostgres(testAdapter.adapter.queue, database.tablePrefix, [job], {
            enqueueToken: 'fair_groups_test_token_000',
            notifyChannel: null,
        });

        await expect(groupOf(job.id)).resolves.toBe('fired');
    });

    test('a failure job: the group of its failure lane, from the failed job', async () => {
        const failed = defineLane({ name: 'convert_failed', fairGroup: ({ payload }) => payload.job.payload.queue });
        const failing = defineLane({ name: 'convert_once', maxAttempts: 1, failureLane: failed,
            fairGroup: ({ payload }) => payload.queue });
        const runner = runnerOf(sqlane);
        const mount = runner.mount([
            handle(failing, () => {
                throw new Error('broken input');
            }),
            handle(failed, () => {}),
        ]);

        try {
            await sqlane.enqueue(testAdapter.pool, failing, { queue: 'backend-9' });
            await runner.drain();
        } finally {
            mount.unmount();
        }

        const rows = await database.query(`SELECT lane, fair_group FROM ${database.tablePrefix}jobs `
            + `WHERE lane IN ('convert_once', 'convert_failed') ORDER BY lane`);

        expect(rows).toStrictEqual([
            { lane: 'convert_failed', fair_group: 'backend-9' },
            { lane: 'convert_once', fair_group: 'backend-9' },
        ]);
    });
});

describe('a schema without 0011_fair_groups', () => {
    /** @type {import('../../src/types.js').Sqlane<any>} */
    let old;

    beforeAll(async () => {
        old = createSqlane({ adapter: testAdapter.adapter, tablePrefix: `${database.tablePrefix}o_` });
        await old.schema.migrate({ targetVersion: '10.0.0' });
    });

    afterAll(async () => {
        await old?.schema.drop();
        await old?.close({ deadline: 0 });
    });

    test('an enqueue with a group: a ConfigError that asks for schema.migrate(); nothing added', async () => {
        await expect(old.enqueue(testAdapter.pool, convert, { queue: 'backend-1' })).rejects.toThrow(new ConfigError(
            'enqueue("convert"): a job with a fair group needs the migration 0011_fair_groups: run schema.migrate()',
        ));
        await expect(database.query(`SELECT id FROM ${database.tablePrefix}o_jobs`)).resolves.toStrictEqual([]);
    });

    test('an enqueue with a null group, and a lane without fairGroup: they work', async () => {
        await expect(old.enqueue(testAdapter.pool, convert, { queue: null })).resolves.toMatchObject({ created: true });
        await expect(old.enqueue(testAdapter.pool, defineLane({ name: 'plain' }), {}))
            .resolves.toMatchObject({ created: true });
    });

    test('enqueueMany with one grouped job: a ConfigError, nothing added', async () => {
        await expect(old.enqueueMany(testAdapter.pool, convert, [
            { payload: { queue: null }, options: { dedupeKey: 'many-1' } },
            { payload: { queue: 'backend-2' }, options: { dedupeKey: 'many-2' } },
        ])).rejects.toThrow(ConfigError);
        await expect(database.query(`SELECT id FROM ${database.tablePrefix}o_jobs WHERE id LIKE 'convert:many-%'`))
            .resolves.toStrictEqual([]);
    });
});

/** @type {number} */
let prefixCount = 0;

/**
 * @returns {Promise<{ p: string, sqlane: import('../../src/types.js').Sqlane<any>,
 *     store: import('../../src/store/store.js').Store }>} Fresh tables, migrated.
 */
async function freshTables() {
    prefixCount++;

    const p = `${database.tablePrefix}${prefixCount}_`;
    const fresh = createSqlane({ adapter: testAdapter.adapter, tablePrefix: p });

    await fresh.schema.migrate();

    return { p, sqlane: fresh, store: createStore(testAdapter.adapter, p) };
}

/**
 * @param {number} secondsAgo
 * @returns {Date}
 */
const ago = secondsAgo => new Date(Date.now() - (secondsAgo * 1000));

/**
 * Enqueues jobs of a grouped lane, oldest first.
 * @param {import('../../src/types.js').Sqlane<any>} on
 * @param {string | null} queue The group.
 * @param {number} count
 * @param {{ secondsAgo?: number, delay?: string }} [when] Default: due 100 s ago, then 1 s apart.
 * @returns {Promise<string[]>} Their ids.
 */
async function enqueueGroup(on, queue, count, { secondsAgo = 100, delay } = {}) {
    const items = Array.from({ length: count }, (_, at) => ({
        payload: { queue },
        options: delay ? { delay } : { runAt: ago(secondsAgo - (at / 1000)) },
    }));
    /** @type {string[]} */
    const ids = [];

    for (let start = 0; start < items.length; start += 500) {
        // oxlint-disable-next-line no-await-in-loop -- one chunk after the other: the order of the ids
        ids.push(...(await on.enqueueMany(testAdapter.pool, convert, items.slice(start, start + 500))).map(r => r.id));
    }

    return ids;
}

/**
 * A claim of due jobs, as the runner makes it: the requests of the grouped lanes from their due groups, and on MySQL
 * and MariaDB its choice among the locked rows.
 * @param {import('../../src/store/store.js').Store} store
 * @param {{ name: string, maxJobs: number, dueGroups?: (string | null)[], running?: number,
 *     groupRunning?: Record<string, number> }[]} lanes Without dueGroups: a plain lane.
 * @param {{ free?: number, lockToken?: string }} [options]
 * @returns {Promise<import('../../src/store/store.js').ClaimDueResult>}
 */
function claimLanes(store, lanes, { free = 100, lockToken = 'TOKEN1' } = {}) {
    /** @type {import('../../src/store/store.js').DueRequest[]} */
    const requests = lanes.map(({ name, maxJobs, dueGroups, running = 0, groupRunning = {} }, tie) => ({
        name,
        maxJobs,
        running,
        weight: 1,
        limits: [],
        tie,
        ...dueGroups && { groups: requestGroups({
            dueGroups,
            runningOf: group => groupRunning[String(group)] ?? 0,
            pointer: null,
            maxJobs,
            random: () => 0,
        }) },
    }));

    return store.claimDue({
        requests,
        limitRooms: [],
        free,
        lockToken,
        lockedBy: `test:${lockToken}`,
        leaseMs: 240_000,
        withFairGroups: true,
        // MySQL and MariaDB: the choice of the runner (dispatcher.js)
        choose: (locked) => {
            const rows = orderDueRows(locked, requests);

            return requests.length === 1
                ? rows.slice(0, requests[0].maxJobs)
                : chooseRows({
                    rows,
                    lanes: shareLanesOfRequests(requests.map((_, index) => ({ index })), requests, []),
                    free,
                    base: 0,
                    size: requests.length,
                }).chosen;
        },
    });
}

describe('the store: the groups of a lane and their claim', () => {
    test('probeGroups: each group with pending jobs, and when its oldest is due; the null group too', async () => {
        const { sqlane: on, store } = await freshTables();

        await enqueueGroup(on, 'a', 30);
        await enqueueGroup(on, 'b', 2, { secondsAgo: 50 });
        await enqueueGroup(on, null, 1, { secondsAgo: 10 });
        await enqueueGroup(on, 'later', 2, { delay: '1h' });

        const rows = await store.probeGroups(['convert', 'other']);
        const byGroup = Object.fromEntries(rows.map(row => [String(row.group), row.delayMs]));

        expect(rows.map(row => row.lane)).toStrictEqual(['convert', 'convert', 'convert', 'convert']);
        expect(Object.keys(byGroup).toSorted()).toStrictEqual(['a', 'b', 'later', 'null']);
        expect(byGroup.a).toBeLessThanOrEqual(-99_000);
        expect(byGroup.b).toBeLessThanOrEqual(-49_000);
        expect(byGroup.null).toBeLessThanOrEqual(-9000);
        expect(byGroup.later).toBeGreaterThan(3_500_000);
    });

    test('a backlog of 2,000 in one group: one slot goes to each group in turn, not to the oldest jobs', async () => {
        const { sqlane: on, store } = await freshTables();
        const a = await enqueueGroup(on, 'a', 2000, { secondsAgo: 1000 });
        const [b] = await enqueueGroup(on, 'b', 1, { secondsAgo: 10 });
        const [n] = await enqueueGroup(on, null, 1, { secondsAgo: 5 });
        const { jobs, limited } = await claimLanes(store, [{ name: 'convert', maxJobs: 3, dueGroups: ['a', 'b', null] }]);

        expect(jobs.map(job => job.id).toSorted()).toStrictEqual([a[0], b, n].toSorted());
        expect(jobs.map(job => job.fairGroup).toSorted()).toStrictEqual(['a', 'b', null].toSorted());
        expect(limited).toStrictEqual([]);
    });

    test('one grouped lane, 1 slot, 3 groups: exactly 1 job, of the first group', async () => {
        const { sqlane: on, store } = await freshTables();

        await enqueueGroup(on, 'a', 5);
        await enqueueGroup(on, 'b', 5);
        await enqueueGroup(on, 'c', 5);

        const { jobs } = await claimLanes(store, [{ name: 'convert', maxJobs: 1, dueGroups: ['a', 'b', 'c'] }], {
            free: 1,
        });

        expect(jobs.map(job => job.fairGroup)).toStrictEqual(['a']);
    });

    test('a group with jobs running here comes after the others', async () => {
        const { sqlane: on, store } = await freshTables();

        await enqueueGroup(on, 'a', 5, { secondsAgo: 200 });
        await enqueueGroup(on, 'b', 5);

        const { jobs } = await claimLanes(store, [{
            name: 'convert', maxJobs: 3, dueGroups: ['a', 'b'], groupRunning: { a: 2 },
        }], { free: 3 });

        expect(jobs.map(job => job.fairGroup).toSorted()).toStrictEqual(['a', 'b', 'b']);
    });

    test('a grouped lane and a plain lane in one claim keep their lane shares', async () => {
        const { sqlane: on, store } = await freshTables();

        await enqueueGroup(on, 'a', 10);
        await enqueueGroup(on, 'b', 10);
        await on.enqueueMany(testAdapter.pool, defineLane({ name: 'plain' }), Array.from({ length: 10 }, () => ({
            payload: {}, options: { runAt: ago(300) },
        })));

        const { jobs } = await claimLanes(store, [
            { name: 'convert', maxJobs: 4, dueGroups: ['a', 'b'] },
            { name: 'plain', maxJobs: 4 },
        ], { free: 4 });
        const lanes = jobs.map(job => job.lane);

        expect(lanes.filter(lane => lane === 'convert')).toHaveLength(2);
        expect(lanes.filter(lane => lane === 'plain')).toHaveLength(2);
        expect(jobs.filter(job => job.lane === 'convert').map(job => job.fairGroup).toSorted()).toStrictEqual(['a', 'b']);
    });

    test('concurrent claims never take the same job; rounds of them take every job of the groups', async () => {
        const { sqlane: on, store } = await freshTables();
        const ids = [...await enqueueGroup(on, 'a', 20), ...await enqueueGroup(on, 'b', 20)];
        /** @type {string[]} */
        const claimed = [];

        // A grouped claim locks a few rows of each group: concurrent ones skip each other's, and the next round claims
        for (let round = 0; round < 20; round++) {
            // oxlint-disable-next-line no-await-in-loop -- one round of concurrent claims after the other
            const claims = await Promise.all(['T1', 'T2', 'T3', 'T4'].map(token => claimLanes(store, [{
                name: 'convert', maxJobs: 10, dueGroups: ['a', 'b'],
            }], { lockToken: `${token}R${round}`, free: 10 })));

            claimed.push(...claims.flatMap(claim => claim.jobs.map(job => job.id)));
        }

        expect(new Set(claimed).size).toBe(claimed.length);
        expect(claimed.toSorted()).toStrictEqual(ids.toSorted());
    });

    test('a paused lane: nothing claimed', async () => {
        const { sqlane: on, store } = await freshTables();

        await enqueueGroup(on, 'a', 3);
        await on.lanes.pauseGlobally(convert);

        await expect(claimLanes(store, [{ name: 'convert', maxJobs: 3, dueGroups: ['a'] }]))
            .resolves.toMatchObject({ jobs: [] });
    });

    test('a job past its maxStalls is claimed in its group, as a turn of the group', async () => {
        const { p, sqlane: on, store } = await freshTables();
        const [stalled] = await enqueueGroup(on, 'a', 1);

        await database.query(`UPDATE ${p}jobs SET stalls = 3, max_stalls = 2 WHERE id = ${PARAM_1}`, [stalled]);

        await expect(claimLanes(store, [{ name: 'convert', maxJobs: 1, dueGroups: ['a'] }]))
            .resolves.toMatchObject({ jobs: [{ id: stalled, fairGroup: 'a', stalls: 3 }] });
    });

    test('a row with global limits in a grouped lane: not taken, its lane reported as limited', async () => {
        const { p, sqlane: on, store } = await freshTables();
        const [keyed] = await enqueueGroup(on, 'a', 1);

        await database.query(`UPDATE ${p}jobs SET ${ONE_LIMIT_SQL} WHERE id = ${PARAM_1}`, [keyed]);

        await expect(claimLanes(store, [{ name: 'convert', maxJobs: 1, dueGroups: ['a'] }]))
            .resolves.toMatchObject({ jobs: [], limited: ['convert'] });
    });

    test('the plain claims return the group of the row with withFairGroups', async () => {
        const { sqlane: on, store } = await freshTables();

        await enqueueGroup(on, 'a', 1);

        await expect(claimLanes(store, [{ name: 'convert', maxJobs: 1 }]))
            .resolves.toMatchObject({ jobs: [{ fairGroup: 'a' }] });
    });

    test('the claim of the lanes with global limits returns the group of the row with withFairGroups', async () => {
        const { sqlane: on, store } = await freshTables();
        const [id] = await enqueueGroup(on, 'a', 1);

        await expect(store.claim({
            candidateIds: [id],
            fullIds: [],
            lockToken: 'TOKEN1',
            lockedBy: 'test:TOKEN1',
            leaseMs: 240_000,
            pick: locked => locked,
            withFairGroups: true,
        })).resolves.toMatchObject({ jobs: [{ id, fairGroup: 'a' }] });
    });

    test('the recovery read returns the group of a stale job with withFairGroups: the stalled event has it', async () => {
        const { p, sqlane: on, store } = await freshTables();
        const [id] = await enqueueGroup(on, 'a', 1);
        await database.query(`UPDATE ${p}jobs SET status = 'running', lock_token = 'T', locked_until = ${PAST_LEASE} `
            + `WHERE id = ${PARAM_1}`, [id]);

        await expect(store.findRecoveryWork(10, true)).resolves.toMatchObject({
            stale: [{ id, lane: 'convert', fairGroup: 'a' }],
        });
    });

    test.runIf(isPostgres)('PostgreSQL: the groups left with locked rows, for the pointer', async () => {
        const { sqlane: on, store } = await freshTables();

        await enqueueGroup(on, 'a', 3, { secondsAgo: 200 });
        await enqueueGroup(on, 'b', 3);

        const { jobs, leftGroups } = await claimLanes(store, [{ name: 'convert', maxJobs: 1, dueGroups: ['a', 'b'] }], {
            free: 1,
        });

        expect(jobs.map(job => job.fairGroup)).toStrictEqual(['a']);
        expect(leftGroups?.get('convert')?.toSorted()).toStrictEqual(['a', 'b']);
    });
});

/**
 * A seeded random generator (LCG), as in the unit tests.
 * @param {number} seed
 * @returns {() => number} In [0, 1).
 */
function seeded(seed) {
    let state = seed;

    return () => {
        state = ((state * 1_103_515_245) + 12_345) % (2 ** 31);

        return state / (2 ** 31);
    };
}

/**
 * One random claim of 2–4 lanes, grouped or plain, with running counts, weights, local limits and caps. The claim must
 * take the jobs that the runner's choice takes on the rows that it locks: the oldest `maxJobs` due jobs of a plain
 * lane,
 * of each requested group of a grouped lane; the rows of a grouped lane in the order of its groups, cut at its maxJobs.
 * @param {import('../../src/types.js').Sqlane<any>} on
 * @param {import('../../src/store/store.js').Store} store
 * @param {() => number} random
 * @param {number} round
 * @returns {Promise<object[]>} The case if the jobs differ.
 */
async function compareGroupedChoice(on, store, random, round) {
    const int = (/** @type {number} */ max) => Math.floor(random() * (max + 1));
    const count = 2 + int(2);
    /** @type {{ id: string, lane: string, fairGroup: string | null }[]} */
    const rows = [];
    /** @type {import('../../src/store/store.js').DueRequest[]} */
    const requests = [];

    for (let index = 0; index < count; index++) {
        const name = `q${round}_${index}`;
        const grouped = random() < 0.6;
        const lane = defineLane({ name, ...grouped && { fairGroup: ({ payload }) => payload.g } });
        const groupNames = grouped ? ['a', 'b', 'c', null].slice(0, 1 + int(3)) : [null];
        const maxJobs = 1 + int(4);
        /** @type {Map<string | null, string[]>} */
        const idsByGroup = new Map();

        for (const group of groupNames) {
            const due = int(5);
            const items = Array.from({ length: due }, (_, k) => ({ payload: { g: group }, options: {
                runAt: ago(100 - k - int(50)),
            } }));
            // oxlint-disable-next-line no-await-in-loop -- the jobs of each group in order
            const results = await on.enqueueMany(testAdapter.pool, lane, items);
            const byRunAt = results.map((result, at) => ({ id: result.id, at: items[at].options.runAt.getTime() }))
                .toSorted((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1));

            idsByGroup.set(group, byRunAt.map(row => row.id));
        }

        const dueGroups = groupNames.filter(group => /** @type {string[]} */ (idsByGroup.get(group)).length);
        /** @type {Record<string, number>} */
        const groupRunning = Object.fromEntries(groupNames.map(group => [String(group), int(2)]));
        const groups = requestGroups({
            dueGroups, runningOf: group => groupRunning[String(group)], pointer: null, maxJobs, random: () => 0,
        });

        if (grouped && !groups.length) {
            continue;
        }

        if (grouped) {
            for (const request of groups) {
                rows.push(...(/** @type {string[]} */ (idsByGroup.get(request.group))).slice(0, request.maxJobs)
                    .map(id => ({ id, lane: name, fairGroup: request.group })));
            }
        } else {
            rows.push(...(/** @type {string[]} */ (idsByGroup.get(null))).slice(0, maxJobs)
                .map(id => ({ id, lane: name, fairGroup: null })));
        }

        requests.push({
            name,
            maxJobs,
            running: int(6),
            weight: [1, 1, 2, 3, 7][int(4)],
            limits: [[], [0], [1], [0, 1]][int(3)],
            tie: requests.length,
            ...grouped && { groups },
        });
    }

    const limitRooms = [int(3), int(6)];
    const free = 1 + int(8);
    const lanes = () => shareLanesOfRequests(requests.map((_, index) => ({ index })), requests, limitRooms);
    const ordered = orderDueRows(rows, requests);
    // A grouped lane takes at most its maxJobs, in the order of its groups
    const capped = requests.flatMap(request => ordered.filter(row => row.lane === request.name)
        .slice(0, request.maxJobs));
    const expected = chooseRows({ rows: capped, lanes: lanes(), free, base: 0, size: Math.max(requests.length, 1) })
        .chosen.map(row => row.id);
    const { jobs } = await store.claimDue({
        requests,
        limitRooms,
        free,
        lockToken: `G${round}`,
        lockedBy: `test:G${round}`,
        leaseMs: 240_000,
        withFairGroups: true,
        choose: locked => chooseRows({
            rows: requests.flatMap(request => orderDueRows(locked, requests).filter(row => row.lane === request.name)
                .slice(0, request.maxJobs)),
            lanes: lanes(),
            free,
            base: 0,
            size: Math.max(requests.length, 1),
        }).chosen,
    });
    const got = jobs.map(job => job.id);

    return expected.toSorted().join(',') === got.toSorted().join(',')
        ? []
        : [{ round, requests, limitRooms, free, expected, got }];
}

test('the choice of a claim with grouped lanes equals the runner\'s choice on the locked rows, on 25 random claims',
    async () => {
        const { sqlane: on, store } = await freshTables();
        const random = seeded(11);
        const mismatches = [];

        for (let round = 0; round < 25; round++) {
            // oxlint-disable-next-line no-await-in-loop -- one claim after the other
            mismatches.push(...await compareGroupedChoice(on, store, random, round));
        }

        expect(mismatches).toStrictEqual([]);
    });

describe('the plans of the reads by group, behind a backlog of 2,000 older jobs in another group', () => {
    /** @type {string} */
    let p;

    beforeAll(async () => {
        const fresh = await freshTables();

        p = fresh.p;
        await enqueueGroup(fresh.sqlane, 'big', 2000, { secondsAgo: 1000 });
        await enqueueGroup(fresh.sqlane, 'small', 3);
        await enqueueGroup(fresh.sqlane, null, 3);
        await database.query(isPostgres ? `ANALYZE ${p}jobs` : `ANALYZE TABLE ${p}jobs`);
    });

    test.runIf(isPostgres).each([
        ['a group', 'fair_group = $2', 'small', '\'small\''],
        ['the null group', 'fair_group IS NULL AND $2::text IS NULL', 'null', 'NULL'],
    ])('PostgreSQL, %s: the generic plan reads the group index, no sort, no row filtered', async (_, where, group, arg) => {
        const name = `fair_${group}_${prefixCount}`;

        await database.query('SET plan_cache_mode = force_generic_plan');

        try {
            await database.query(`PREPARE ${name}(text, text, bigint) AS
                SELECT id FROM ${p}jobs
                 WHERE status = 'pending' AND lane = $1 AND ${where} AND run_at <= clock_timestamp()
                 ORDER BY fair_group, run_at, id LIMIT $3 FOR UPDATE SKIP LOCKED`);

            const [{ 'QUERY PLAN': plan }] = await database.query(
                `EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE ${name}('convert', ${arg}, 3)`,
            );
            const text = JSON.stringify(plan);

            expect(text).toContain(`"Index Name":"${p}jobs_pending_group"`);
            expect(text).not.toContain('"Node Type":"Sort"');
            expect(text).not.toMatch(/"Rows Removed by Filter":[1-9]/);
        } finally {
            await database.query(`DEALLOCATE ${name}`);
            await database.query('RESET plan_cache_mode');
        }
    });

    // The orders of dueBranches: the null group without fair_group, which MySQL 8.4 would sort
    test.runIf(!isPostgres).each([
        ['a group', 'j.fair_group = \'small\'', 'j.fair_group, j.run_at, j.id'],
        ['the null group', 'j.fair_group IS NULL', 'j.run_at, j.id'],
    ])('MySQL and MariaDB, %s: the forced group index, no filesort', async (_, where, order) => {
        const [plan] = await database.query(`EXPLAIN SELECT j.id FROM ${p}jobs j FORCE INDEX (${p}jobs_status_lane_group)
             WHERE j.status = 'pending' AND j.lane = 'convert' AND ${where} AND j.run_at <= UTC_TIMESTAMP(3)
             ORDER BY ${order} LIMIT 3 FOR UPDATE SKIP LOCKED`);

        expect(plan.key).toBe(`${p}jobs_status_lane_group`);
        expect(String(plan.Extra)).not.toContain('filesort');
        expect(Number(plan.rows)).toBeLessThan(100);
    });

    test.runIf(!isPostgres)('MySQL and MariaDB: probeGroups is a loose index scan', async () => {
        const [plan] = await database.query(`EXPLAIN SELECT lane, fair_group, MIN(run_at) FROM ${p}jobs
              FORCE INDEX (${p}jobs_status_lane_group)
             WHERE status = 'pending' AND lane IN ('convert') GROUP BY status, lane, fair_group`);

        expect(String(plan.Extra)).toContain('Using index for group-by');
    });
});

/**
 * @param {() => boolean} condition
 * @param {number} [timeoutMs]
 */
async function waitFor(condition, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;

    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor: timed out');
        }

        // oxlint-disable-next-line no-await-in-loop -- polls
        await sleep(10);
    }
}

/**
 * Handlers that hold their jobs until the test releases them, by group.
 * @returns {{ handler: import('../../src/types.js').Handler, started: string[], running: Record<string, number>,
 *     release: (group: string) => void, releaseAll: () => void }}
 */
function holdingGroups() {
    /** @type {{ group: string, release: () => void }[]} */
    const held = [];
    /** @type {string[]} */
    const started = [];
    /** @type {Record<string, number>} */
    const running = {};

    return {
        started,
        running,
        handler: async ({ job }) => {
            const group = String(job.fairGroup);
            const { promise, resolve } = Promise.withResolvers();

            started.push(group);
            running[group] = (running[group] ?? 0) + 1;
            held.push({ group, release: () => resolve(undefined) });
            await promise;
            running[group]--;
        },
        release: (group) => {
            held.splice(held.findIndex(job => job.group === group), 1)[0]?.release();
        },
        releaseAll: () => {
            for (const job of held.splice(0)) {
                job.release();
            }
        },
    };
}

/**
 * @param {readonly string[]} list
 * @param {(value: string) => boolean} matches
 * @returns {number[]} The positions of the values that match.
 */
function positionsOf(list, matches) {
    /** @type {number[]} */
    const positions = [];

    for (const [at, value] of list.entries()) {
        if (matches(value)) {
            positions.push(at);
        }
    }

    return positions;
}

const noop = () => {};

describe('the runner: a lane with fair groups', () => {
    /** @type {import('../../src/types.js').Sqlane<any>[]} */
    let instances = [];

    afterEach(async () => {
        await Promise.all(instances.map(instance => instance.close({ deadline: 0, mode: 'abandon' })));
        instances = [];
    });

    /**
     * An instance on a table prefix, its tie pointers at the first lane and the first group.
     * @param {string} p
     * @param {string} [pollInterval]
     * @returns {import('../../src/types.js').Sqlane<any>}
     */
    function instanceOn(p, pollInterval = '100ms') {
        const instance = createSqlane(/** @type {any} */ ({
            adapter: testAdapter.adapter,
            tablePrefix: p,
            pollInterval,
            timings: { leaseMs: 5000, renewIntervalMs: 500, recoveryIntervalMs: 500, random: () => 0 },
        }));

        instances.push(instance);

        return instance;
    }

    /**
     * @param {{ localMaxConcurrency: number, pollInterval?: string,
     *     logger?: import('../../src/types.js').Logger }} options
     * @returns {Promise<{ p: string, sqlane: import('../../src/types.js').Sqlane<any>,
     *     runner: ReturnType<typeof createRunner> }>}
     */
    async function freshRunner({ localMaxConcurrency, pollInterval, logger }) {
        prefixCount++;

        const p = `${database.tablePrefix}${prefixCount}_`;
        const instance = instanceOn(p, pollInterval);

        await instance.schema.migrate();

        return { p, sqlane: instance, runner: createRunner(instance, { localMaxConcurrency, logger }) };
    }

    test('one slot, a backlog of 200 in one group: the groups take turns (Behavior 5)', async () => {
        const { sqlane: on, runner } = await freshRunner({ localMaxConcurrency: 1 });
        /** @type {string[]} */
        const started = [];

        await enqueueGroup(on, 'a', 200, { secondsAgo: 1000 });
        await enqueueGroup(on, 'b', 3);
        await enqueueGroup(on, 'c', 3);
        runner.mount([defineHandler(convert, ({ job }) => {
            started.push(String(job.fairGroup));
        })]);
        await runner.start();
        await waitFor(() => started.length >= 9);

        expect(started.slice(0, 9)).toStrictEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c']);
    });

    test('two slots: the fewest running first; a group that was alone keeps its slots until its jobs end', async () => {
        const { sqlane: on, runner } = await freshRunner({ localMaxConcurrency: 2 });
        const jobs = holdingGroups();

        runner.mount([defineHandler(convert, jobs.handler)]);
        await enqueueGroup(on, 'a', 10);
        await runner.start();
        await waitFor(() => jobs.started.length === 2);
        expect(jobs.running).toStrictEqual({ a: 2 });

        await enqueueGroup(on, 'b', 10);
        jobs.release('a');
        await waitFor(() => jobs.started.length === 3);
        expect(jobs.running).toStrictEqual({ a: 1, b: 1 });

        jobs.release('b');
        await waitFor(() => jobs.started.length === 4);
        expect(jobs.started.at(-1)).toBe('b');
        jobs.release('a');
        await waitFor(() => jobs.started.length === 5);
        expect(jobs.started.at(-1)).toBe('a');
        expect(jobs.running).toStrictEqual({ a: 1, b: 1 });
        jobs.releaseAll();
    });

    test('two runners: every small group finishes before half of the big backlog', async () => {
        const { p, sqlane: on, runner } = await freshRunner({ localMaxConcurrency: 1 });
        const second = createRunner(instanceOn(p), { localMaxConcurrency: 1 });
        /** @type {string[]} */
        const done = [];
        const handler = defineHandler(convert, async ({ job }) => {
            await sleep(2);
            done.push(String(job.fairGroup));
        });

        await enqueueGroup(on, 'big', 60, { secondsAgo: 1000 });

        for (const group of ['s1', 's2', 's3', 's4', 's5']) {
            // oxlint-disable-next-line no-await-in-loop -- a few groups
            await enqueueGroup(on, group, 2);
        }

        runner.mount([handler]);
        second.mount([handler]);
        await Promise.all([runner.start(), second.start()]);
        await waitFor(() => done.length >= 70, 20_000);

        const big = positionsOf(done, group => group === 'big');
        const small = positionsOf(done, group => group !== 'big');

        expect(small).toHaveLength(10);
        expect(Math.max(...small)).toBeLessThan(big[29]);
    });

    test('one slot, a grouped lane and a plain lane: the lanes take turns (one share per lane)', async () => {
        const { sqlane: on, runner } = await freshRunner({ localMaxConcurrency: 1 });
        const plain = defineLane({ name: 'plain' });
        /** @type {string[]} */
        const started = [];

        await enqueueGroup(on, 'a', 10);
        await enqueueGroup(on, 'b', 10);
        await on.enqueueMany(testAdapter.pool, plain, Array.from({ length: 20 }, () => ({ payload: {} })));
        runner.mount([
            defineHandler(convert, () => {
                started.push('convert');
            }),
            defineHandler(plain, () => {
                started.push('plain');
            }),
        ]);
        await runner.start();
        await waitFor(() => started.length >= 10);

        expect(started.slice(0, 10).filter(lane => lane === 'convert')).toHaveLength(5);
    });

    test('two grouped lanes, two slots: both keep starting', async () => {
        const { sqlane: on, runner } = await freshRunner({ localMaxConcurrency: 2 });
        const other = defineLane({ name: 'other', fairGroup: ({ payload }) => payload.queue });
        /** @type {string[]} */
        const started = [];

        await enqueueGroup(on, 'a', 20);
        await on.enqueueMany(testAdapter.pool, other, Array.from({ length: 20 }, (_, at) => ({
            payload: { queue: `g${at % 3}` },
        })));
        runner.mount([
            defineHandler(convert, () => {
                started.push('convert');
            }),
            defineHandler(other, () => {
                started.push('other');
            }),
        ]);
        await runner.start();
        await waitFor(() => started.length >= 20);

        expect(started.slice(0, 20).filter(lane => lane === 'convert').length).toBeGreaterThanOrEqual(8);
        expect(started.slice(0, 20).filter(lane => lane === 'other').length).toBeGreaterThanOrEqual(8);
    });

    test('a grouped lane under a local limit, beside a plain lane, 4 slots: never above its limit', async () => {
        const { sqlane: on, runner } = await freshRunner({ localMaxConcurrency: 4 });
        const one = defineConcurrencyLimit({ name: 'one', max: 1 });
        const plain = defineLane({ name: 'plain' });
        const jobs = holdingGroups();
        /** @type {number[]} */
        const convertRunning = [];
        let convertNow = 0;

        await enqueueGroup(on, 'a', 5);
        await enqueueGroup(on, 'b', 5);
        await on.enqueueMany(testAdapter.pool, plain, Array.from({ length: 10 }, () => ({ payload: { queue: 'p' } })));
        runner.mount([
            defineHandler(convert, async (context) => {
                convertNow++;
                convertRunning.push(convertNow);
                await jobs.handler(context);
                convertNow--;
            }, { localConcurrencyLimits: [one] }),
            defineHandler(plain, jobs.handler),
        ]);
        await runner.start();
        await waitFor(() => jobs.started.length === 4);

        for (let round = 0; round < 6; round++) {
            jobs.release(/** @type {string} */ (jobs.started[round]));
            // oxlint-disable-next-line no-await-in-loop -- one release at a time
            await waitFor(() => jobs.started.length === 5 + round);
        }

        jobs.releaseAll();

        expect(Math.max(...convertRunning)).toBe(1);
        expect(jobs.started.filter(group => group !== 'p').length).toBeGreaterThanOrEqual(2);
    });

    test('rows with global limits in a grouped lane: claimed FIFO with their limits; one warning', async () => {
        /** @type {unknown[][]} */
        const warnings = [];
        const logger = {
            debug: noop, info: noop, warn: (/** @type {unknown[]} */ ...args) => warnings.push(args), error: noop,
        };
        const { sqlane: on, runner } = await freshRunner({ localMaxConcurrency: 1, logger });
        // A job with global limits needs a timeout: the runner's definition gives it
        const grouped = defineLane({ name: 'keyed', timeout: '1m', fairGroup: ({ payload }) => payload.queue });
        const old = defineLane({ name: 'keyed' });
        const key = defineConcurrencyLimit({ name: 'key', max: 1 });
        /** @type {string[]} */
        const done = [];

        await on.enqueue(testAdapter.pool, old, { queue: 'x' }, { globalConcurrencyLimits: [key.key('x')] });
        await on.enqueue(testAdapter.pool, old, { queue: 'x' }, { globalConcurrencyLimits: [key.key('x')] });
        runner.mount([defineHandler(grouped, ({ job }) => {
            done.push(job.id);
        })]);
        await runner.start();
        await waitFor(() => done.length === 2);

        expect(warnings.filter(([, message]) => String(message).includes('fair groups'))).toHaveLength(1);
    });

    test('a group with only delayed jobs does not hold the others; a lane with only delayed groups is scheduled',
        async () => {
            const { sqlane: on, runner } = await freshRunner({ localMaxConcurrency: 1, pollInterval: '1m' });
            /** @type {string[]} */
            const started = [];

            await enqueueGroup(on, 'later', 2, { delay: '1h' });
            await enqueueGroup(on, 'now', 1);
            await on.enqueue(testAdapter.pool, convert, { queue: 'soon' }, { delay: '700ms' });
            runner.mount([defineHandler(convert, ({ job }) => {
                started.push(String(job.fairGroup));
            })]);
            await runner.start();
            await waitFor(() => started.length === 2, 5000);

            expect(started).toStrictEqual(['now', 'soon']);
        });

    test('a schema without 0011: FIFO, fairGroups false, one warning; schema.migrate() at runtime: by group, no restart',
        async () => {
            /** @type {unknown[][]} */
            const warnings = [];
            const logger = {
                debug: noop, info: noop, warn: (/** @type {unknown[]} */ ...args) => warnings.push(args), error: noop,
            };

            prefixCount++;

            const p = `${database.tablePrefix}${prefixCount}_`;
            const on = instanceOn(p);
            const runner = createRunner(on, { localMaxConcurrency: 1, logger });
            /** @type {(string | null)[]} */
            const seen = [];

            await on.schema.migrate({ targetVersion: '10.0.0' });
            runner.mount([defineHandler(convert, ({ job }) => {
                seen.push(job.fairGroup);
            })]);
            await on.enqueue(testAdapter.pool, convert, { queue: null });
            await runner.start();
            await waitFor(() => seen.length === 1);

            expect(seen).toStrictEqual([null]);
            expect(runner.getStatus(convert)).toMatchObject({ mounted: true, fairGroups: false });
            expect(warnings.filter(([, message]) => String(message).includes('0011_fair_groups'))).toHaveLength(1);

            await on.schema.migrate();
            await waitFor(() => runner.getStatus(convert).fairGroups);
            await enqueueGroup(on, 'a', 1);
            await waitFor(() => seen.length === 2);

            expect(seen).toStrictEqual([null, 'a']);
        });

    test('drain() reads the records again while 0011 is missing: by group after schema.migrate()', async () => {
        prefixCount++;

        const p = `${database.tablePrefix}${prefixCount}_`;
        const on = instanceOn(p);
        const runner = createRunner(on, { localMaxConcurrency: 1 });

        await on.schema.migrate({ targetVersion: '10.0.0' });
        runner.mount([defineHandler(convert, () => {})]);
        await runner.drain();
        expect(runner.getStatus(convert).fairGroups).toBe(false);

        await on.schema.migrate();
        await runner.drain();
        expect(runner.getStatus(convert).fairGroups).toBe(true);
    });

    test('a schema without 0011: the failure jobs and the slots of a runner are added, without a group', async () => {
        prefixCount++;

        const p = `${database.tablePrefix}${prefixCount}_`;
        const on = instanceOn(p);
        const runner = createRunner(on, { localMaxConcurrency: 2 });
        const failed = defineLane({ name: 'convert_failed', fairGroup: () => 'failures' });
        const failing = defineLane({ name: 'convert_once', maxAttempts: 1, failureLane: failed,
            fairGroup: ({ payload }) => payload.queue });
        const ticking = defineSchedule(failed, { key: 'tick', every: '1s', payload: {} });
        /** @type {string[]} */
        const groups = [];

        await on.schema.migrate({ targetVersion: '10.0.0' });
        runner.mount([
            defineHandler(failing, () => {
                throw new Error('broken');
            }),
            defineHandler(failed, ({ job }) => {
                groups.push(String(job.fairGroup));
            }),
            ticking,
        ]);
        await on.enqueue(testAdapter.pool, failing, { queue: null });
        await runner.start();
        // The failure job, and at least one slot of the schedule: both in the failure lane, without a group
        await waitFor(() => groups.length >= 2, 5000);

        expect(groups.slice(0, 2)).toStrictEqual(['null', 'null']);
    });
});

describe('lanes.groupStats', () => {
    test('the groups with unfinished jobs: counts, the oldest due, worst first; the null group last on a tie',
        async () => {
            const { p, sqlane: on } = await freshTables();
            const [running] = await enqueueGroup(on, 'a', 3, { secondsAgo: 100 });

            await enqueueGroup(on, 'b', 1, { secondsAgo: 300 });
            await enqueueGroup(on, null, 2, { secondsAgo: 50 });
            await enqueueGroup(on, 'later', 2, { delay: '1h' });
            await database.query(`UPDATE ${p}jobs SET status = 'running', lock_token = 'T', locked_until = ${PAST_LEASE} `
                + `WHERE id = ${PARAM_1}`, [running]);

            const { groups, truncated } = await on.lanes.groupStats(convert);

            expect(truncated).toBe(false);
            expect(groups.map(group => group.fairGroup)).toStrictEqual(['b', 'a', null, 'later']);
            expect(groups[1]).toMatchObject({ fairGroup: 'a', pending: 2, due: 2, blocked: 0, running: 1 });
            expect(groups[3]).toStrictEqual({
                fairGroup: 'later', pending: 2, due: 0, blocked: 0, running: 0, oldestDueAgeMs: null,
            });
            expect(groups[0].oldestDueAgeMs).toBeGreaterThanOrEqual(299_000);
        });

    test('orderBy pending, a limit: truncated; by the name of the lane too', async () => {
        const { sqlane: on } = await freshTables();

        await enqueueGroup(on, 'a', 1);
        await enqueueGroup(on, 'b', 3);
        await enqueueGroup(on, 'c', 2);

        await expect(on.lanes.groupStats('convert', { orderBy: 'pending', limit: 2 })).resolves.toMatchObject({
            groups: [{ fairGroup: 'b', pending: 3 }, { fairGroup: 'c', pending: 2 }],
            truncated: true,
        });
    });

    test('a lane without groups: one entry, null; a lane without jobs: none', async () => {
        const { sqlane: on } = await freshTables();
        const plain = defineLane({ name: 'plain' });

        await on.enqueue(testAdapter.pool, plain, {});

        await expect(on.lanes.groupStats(plain)).resolves.toMatchObject({ groups: [{ fairGroup: null, pending: 1 }] });
        await expect(on.lanes.groupStats('empty')).resolves.toStrictEqual({ groups: [], truncated: false });
    });

    test.each([
        ['a bad lane', 'Bad', undefined],
        ['a limit of 0', 'convert', { limit: 0 }],
        ['a limit above 1000', 'convert', { limit: 1001 }],
        ['an unknown order', 'convert', { orderBy: 'running' }],
        ['an unknown option', 'convert', { type: 'x' }],
    ])('%s: an InvalidOptionsError', async (_, lane, options) => {
        await expect(sqlane.lanes.groupStats(lane, /** @type {any} */ (options))).rejects.toThrow(InvalidOptionsError);
    });

    test('a schema without 0011_fair_groups: a ConfigError that asks for schema.migrate()', async () => {
        prefixCount++;

        const old = createSqlane({ adapter: testAdapter.adapter, tablePrefix: `${database.tablePrefix}${prefixCount}_` });

        await old.schema.migrate({ targetVersion: '10.0.0' });

        await expect(old.lanes.groupStats(convert)).rejects.toThrow(new ConfigError('lanes.groupStats(): the fair '
            + 'groups need the migration 0011_fair_groups: run schema.migrate()'));
        await old.close({ deadline: 0 });
    });
});
