// sqlane.jobs.keyStats(): the keys with blocked jobs, or with held or lingering slots, on each database. Through the
// public API where it is cheap; raw SQL for the states that take time or volume (the convention of the store tests).
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
    createSqlane,
    defineConcurrencyLimit,
    defineJob,
    defineRateLimit,
    InvalidOptionsError,
} from '../../src/index.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @typedef {import('../../src/types.js').Sqlane<any>} Sqlane */

/** Fast timers: the tests wait milliseconds, not minutes */
const TIMINGS = { leaseMs: 5000, renewIntervalMs: 500, recoveryIntervalMs: 60_000 };

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} The index of 0008, dropped by hand */
const DROP_JOBS_LIST_SQL = {
    mysql: p => `ALTER TABLE ${p}jobs DROP KEY ${p}jobs_list`,
    postgres: p => `DROP INDEX ${p}jobs_list`,
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

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await testAdapter?.close();
    await database?.close();
});

/**
 * @returns {string} A table prefix of its own.
 */
function nextPrefix() {
    prefixCount++;

    return `${database.tablePrefix}${prefixCount}_`;
}

/**
 * A sqlane instance on the tables of a prefix.
 * @param {string} p
 * @param {Record<string, unknown>} [options]
 * @returns {Sqlane}
 */
function sqlaneOn(p, options = {}) {
    const sqlane = createSqlane(/** @type {any} */ ({
        adapter: testAdapter.adapter,
        tablePrefix: p,
        pollInterval: '100ms',
        timings: TIMINGS,
        ...options,
    }));

    instances.push(sqlane);

    return sqlane;
}

/**
 * A migrated instance on tables of its own.
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{ sqlane: Sqlane, p: string }>}
 */
async function fresh(options = {}) {
    const p = nextPrefix();
    const sqlane = sqlaneOn(p, options);

    await sqlane.schema.migrate();

    return { sqlane, p };
}

/**
 * Raw SQL of the test, with `?` placeholders, on either family.
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<any[]>}
 */
function raw(sql, params = []) {
    let index = 0;

    return database.query(database.family === 'postgres' ? sql.replaceAll('?', () => `$${++index}`) : sql, params);
}

/**
 * @returns {string} SQL: the database time minus `?` milliseconds (negative: ahead).
 */
function msAgo() {
    return database.family === 'postgres'
        ? `clock_timestamp() - (? * interval '1 millisecond')`
        : 'UTC_TIMESTAMP(6) - INTERVAL (? * 1000) MICROSECOND';
}

/**
 * @returns {string} SQL: one database time for all the rows of a statement.
 */
function statementTime() {
    return database.family === 'postgres' ? 'statement_timestamp()' : 'UTC_TIMESTAMP(3)';
}

/**
 * @returns {Promise<number>} The database time, in epoch ms.
 */
async function dbNow() {
    const [row] = await raw(database.family === 'postgres'
        ? 'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS ms'
        : 'SELECT TIMESTAMPDIFF(MICROSECOND, \'1970-01-01\', UTC_TIMESTAMP(3)) DIV 1000 AS ms');

    return Number(row.ms);
}

/**
 * Blocks jobs on a key, due `ago` ms ago.
 * @param {string} p
 * @param {string[]} ids
 * @param {string} key The stored key: `<limit>[:<value>]`, or `@<limit>[:<value>]` for a rate key.
 * @param {number} ago
 * @returns {Promise<void>}
 */
async function block(p, ids, key, ago) {
    await raw(`UPDATE ${p}jobs SET status = 'blocked', blocked_on = ?, run_at = ${msAgo()} WHERE id IN (${
        ids.map(() => '?').join(', ')})`, [key, ago, ...ids]);
}

/**
 * A slot row.
 * @param {string} p
 * @param {{ key: string, slot: number, jobId: string, heldMs: number | null, takenAgo: number }} slot `heldMs`: the
 *     linger ends this many ms from now (negative: ended); null: held by a run.
 * @returns {Promise<void>}
 */
async function insertSlot(p, { key, slot, jobId, heldMs, takenAgo }) {
    await raw(`INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
        VALUES (?, ?, ?, 'raw', ${heldMs === null ? 'NULL' : msAgo()}, ${msAgo()})`,
    [key, slot, jobId, ...heldMs === null ? [] : [-heldMs], takenAgo]);
}

/**
 * Sets the tat of a rate key `ago` ms ago (negative: ahead).
 * @param {string} p
 * @param {string} key
 * @param {number} ago
 * @returns {Promise<void>}
 */
async function setTat(p, key, ago) {
    await raw(database.family === 'postgres'
        ? `INSERT INTO ${p}rate_limits (limit_key, tat) VALUES (?, ${msAgo()})
           ON CONFLICT (limit_key) DO UPDATE SET tat = EXCLUDED.tat`
        : `INSERT INTO ${p}rate_limits (limit_key, tat) VALUES (?, ${msAgo()})
           ON DUPLICATE KEY UPDATE tat = VALUES(tat)`, [key, ago]);
}

/**
 * Waits until the condition holds.
 * @param {() => Promise<boolean> | boolean} condition
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitFor(condition, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;

    // oxlint-disable-next-line no-await-in-loop -- polls
    while (!await condition()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor: timed out');
        }

        // oxlint-disable-next-line no-await-in-loop -- polls
        await sleep(10);
    }
}

/**
 * Jobs of a name with global concurrency limits from their enqueue options.
 * @param {Sqlane} sqlane
 * @param {string} name
 * @param {number} count
 * @param {import('../../src/types.js').EnqueueOptions} options
 * @returns {Promise<string[]>}
 */
async function enqueued(sqlane, name, count, options) {
    const items = Array.from({ length: count }, () => ({ payload: {}, options }));

    return (await sqlane.enqueueMany(testAdapter.pool, name, /** @type {any[]} */ (items))).map(({ id }) => id);
}

const ORDER = defineConcurrencyLimit({ name: 'order', max: 2 });

/**
 * @param {import('../../src/types.js').KeyStats[]} keys
 * @returns {string[]} The stored key of each: `@<limit>[:<key>]` for a rate key.
 */
function storedKeys(keys) {
    return keys.map((key) => {
        if (key.type !== 'rate') {
            return key.key;
        }

        return key.key === null ? `@${key.limit}` : `@${key.limit}:${key.key}`;
    });
}

describe('keyStats', () => {
    test('nothing blocked or held: an empty page, before start() and after close()', async () => {
        const { sqlane } = await fresh();

        await expect(sqlane.jobs.keyStats()).resolves.toStrictEqual({ keys: [], truncated: false });
        await sqlane.close();
        await expect(sqlane.jobs.keyStats()).resolves.toStrictEqual({ keys: [], truncated: false });
    });

    test('a concurrency key with a running holder and two blocked jobs', async () => {
        const { sqlane } = await fresh();
        const one = defineConcurrencyLimit({ name: 'one', max: 1 });
        const sync = defineJob({ name: 'sync', timeout: '10s', globalConcurrencyLimits: () => [one.key('a')] });
        const { promise, resolve } = Promise.withResolvers();
        /** @type {Date[]} */
        const started = [];

        sqlane.handle(sync, ({ job }) => {
            started.push(job.startedAt);

            return promise;
        });
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, sync, {});
        await waitFor(() => started.length === 1);

        const blocked = await enqueued(sqlane, 'sync', 2, {});

        await waitFor(async () => (await sqlane.jobs.list({ jobName: 'sync', status: 'blocked' })).jobs.length === 2);

        const before = await dbNow();
        const { keys, truncated } = /** @type {{ keys: any[], truncated: boolean }} */ (await sqlane.jobs.keyStats());
        const after = await dbNow();
        const heads = await Promise.all(blocked.map(id => sqlane.jobs.get(id)));
        const headRunAt = Math.min(...heads.map(job => Number(job?.runAt)));

        resolve(undefined);
        expect(truncated).toBe(false);
        expect(keys).toStrictEqual([{
            type: 'concurrency',
            key: 'one:a',
            max: 1,
            held: 1,
            lingering: 0,
            blocked: 2,
            blockedTruncated: false,
            oldestBlockedAgeMs: expect.any(Number),
            oldestHeldAgeMs: expect.any(Number),
        }]);
        // Bounds by the database time read before and after the call, ±1 ms
        expect(keys[0].oldestHeldAgeMs).toBeGreaterThanOrEqual(before - Number(started[0]) - 1);
        expect(keys[0].oldestHeldAgeMs).toBeLessThanOrEqual(after - Number(started[0]) + 1);
        expect(keys[0].oldestBlockedAgeMs).toBeGreaterThanOrEqual(before - headRunAt - 1);
        expect(keys[0].oldestBlockedAgeMs).toBeLessThanOrEqual(after - headRunAt + 1);
    });

    test('a lingering slot counts; an ended one does not; an orphan slot counts as held', async () => {
        const { sqlane, p } = await fresh();
        const [job] = await enqueued(sqlane, 'sync', 1, { globalConcurrencyLimits: [ORDER.key('a')] });

        await insertSlot(p, { key: 'order:a', slot: 0, jobId: job, heldMs: 60_000, takenAgo: 5000 });
        await insertSlot(p, { key: 'order:a', slot: 1, jobId: job, heldMs: -1000, takenAgo: 9000 });
        // An orphan: no running job holds it
        await insertSlot(p, { key: 'order:b', slot: 0, jobId: 'gone', heldMs: null, takenAgo: 1000 });
        // A key whose only slot is an ended linger: not listed
        await insertSlot(p, { key: 'order:c', slot: 0, jobId: job, heldMs: -1000, takenAgo: 3000 });

        const keys = /** @type {any[]} */ ((await sqlane.jobs.keyStats({ orderBy: 'held' })).keys);

        expect(storedKeys(keys)).toStrictEqual(['order:a', 'order:b']);

        expect(keys).toMatchObject([
            { type: 'concurrency', key: 'order:a', held: 0, lingering: 1, blocked: 0, max: 2, oldestBlockedAgeMs: null },
            { type: 'concurrency', key: 'order:b', held: 1, lingering: 0, blocked: 0, max: null },
        ]);
        expect(keys[0].oldestHeldAgeMs).toBeGreaterThanOrEqual(4999);
        expect(keys[0].oldestHeldAgeMs).toBeLessThan(9000);
    });

    test('a lingering slot after a release on close', async () => {
        const p = nextPrefix();
        const first = sqlaneOn(p);
        const sync = defineJob({ name: 'sync', timeout: '10s', globalConcurrencyLimits: () => [ORDER.key('a')] });

        await first.schema.migrate();
        first.handle(sync, ({ signal }) => new Promise((resolve) => {
            signal.addEventListener('abort', resolve);
        }));
        await first.start();
        await first.enqueue(testAdapter.pool, sync, {});
        await waitFor(async () => (await first.jobs.list({ jobName: 'sync', status: 'running' })).jobs.length === 1);
        await first.close({ deadline: '50ms', exitsBy: '5s' });

        await expect(first.jobs.keyStats()).resolves.toMatchObject({
            keys: [{ type: 'concurrency', key: 'order:a', held: 0, lingering: 1, blocked: 0, max: 2 }],
        });
    });

    test('max: of the oldest blocked job; else of the newest slot\'s job; null when that job is gone', async () => {
        const { sqlane, p } = await fresh();
        const two = defineConcurrencyLimit({ name: 'k', max: 2 });
        const five = defineConcurrencyLimit({ name: 'k', max: 5 });
        const [older] = await enqueued(sqlane, 'a', 1, { globalConcurrencyLimits: [two.key('x')] });
        const [newer] = await enqueued(sqlane, 'b', 1, { globalConcurrencyLimits: [five.key('x')] });

        await block(p, [older], 'k:x', 2000);
        await block(p, [newer], 'k:x', 1000);
        const blocked = /** @type {any[]} */ ((await sqlane.jobs.keyStats()).keys);

        expect(blocked).toMatchObject([{ key: 'k:x', max: 2, blocked: 2 }]);
        // The oldest of the two blocked jobs
        expect(blocked[0].oldestBlockedAgeMs).toBeGreaterThanOrEqual(1999);

        // Nothing blocked: the job of the newest slot
        const [oldHolder] = await enqueued(sqlane, 'c', 1, { globalConcurrencyLimits: [two.key('y')] });
        const [newHolder] = await enqueued(sqlane, 'd', 1, { globalConcurrencyLimits: [five.key('y')] });

        await insertSlot(p, { key: 'k:y', slot: 0, jobId: oldHolder, heldMs: null, takenAgo: 3000 });
        await insertSlot(p, { key: 'k:y', slot: 1, jobId: newHolder, heldMs: null, takenAgo: 1000 });

        const keys = /** @type {any[]} */ ((await sqlane.jobs.keyStats({ orderBy: 'held' })).keys);

        expect(keys.find(key => key.key === 'k:y')).toMatchObject({ max: 5, held: 2 });

        // Two slots taken at one time: the higher job id
        const [first] = await enqueued(sqlane, 'e', 1, { globalConcurrencyLimits: [five.key('z')] });
        const [second] = await enqueued(sqlane, 'f', 1, { globalConcurrencyLimits: [two.key('z')] });

        await insertSlot(p, { key: 'k:z', slot: 0, jobId: first, heldMs: null, takenAgo: 1000 });
        await insertSlot(p, { key: 'k:z', slot: 1, jobId: second, heldMs: null, takenAgo: 1000 });
        await raw(`UPDATE ${p}concurrency_slots SET created_at = ${statementTime()} WHERE limit_key = 'k:z'`);

        const tied = /** @type {any[]} */ ((await sqlane.jobs.keyStats({ orderBy: 'held' })).keys);

        // ULIDs of one process grow: the second job has the higher id
        expect([second, first].toSorted()).toStrictEqual([first, second]);
        expect(tied.find(key => key.key === 'k:z')).toMatchObject({ max: 2, held: 2 });

        // The newest slot's job is removed (its slot stays): null
        await sqlane.jobs.remove({ jobIds: [newHolder] });

        const after = /** @type {any[]} */ ((await sqlane.jobs.keyStats({ orderBy: 'held' })).keys);

        expect(after.find(key => key.key === 'k:y')).toMatchObject({ max: null });
    });

    test('a rate key with blocked jobs: its limit, key and next start; 0 once its time has come', async () => {
        const { sqlane, p } = await fresh();
        const api = defineRateLimit({ name: 'api', max: 1, per: '2s' });
        const keyed = await enqueued(sqlane, 'call', 2, { globalRateLimits: [api.key('t1')] });
        const whole = await enqueued(sqlane, 'all', 1, { globalRateLimits: [api] });

        await block(p, keyed, '@api:t1', 1000);
        await block(p, whole, '@api', 500);
        await setTat(p, '@api:t1', -10_000);

        const keys = /** @type {any[]} */ ((await sqlane.jobs.keyStats()).keys);

        expect(keys).toStrictEqual([
            {
                type: 'rate',
                limit: 'api',
                key: 't1',
                blocked: 2,
                blockedTruncated: false,
                oldestBlockedAgeMs: expect.any(Number),
                nextStartInMs: expect.any(Number),
            },
            {
                type: 'rate',
                limit: 'api',
                key: null,
                blocked: 1,
                blockedTruncated: false,
                oldestBlockedAgeMs: expect.any(Number),
                // No row: no debt
                nextStartInMs: 0,
            },
        ]);
        expect(keys[0].nextStartInMs).toBeGreaterThan(5000);
        expect(keys[0].nextStartInMs).toBeLessThanOrEqual(10_000);
        expect(keys[0].oldestBlockedAgeMs).toBeGreaterThanOrEqual(999);

        await setTat(p, '@api:t1', 100);
        await expect(sqlane.jobs.keyStats({ type: 'rate' })).resolves.toMatchObject({
            keys: [{ key: 't1', nextStartInMs: 0 }, { key: null, nextStartInMs: 0 }],
        });
    });

    test('the next start of a rate key by its own settings: a burst, a cost; 0 within the allowance', async () => {
        const { sqlane, p } = await fresh();
        const bursty = defineRateLimit({ name: 'bursty', max: 3, per: '3s', burst: 3 });
        const points = defineRateLimit({ name: 'points', max: 4, per: '4s', burst: 4 });
        const [ahead] = await enqueued(sqlane, 'a', 1, { globalRateLimits: [bursty.key('x')] });
        const [within] = await enqueued(sqlane, 'b', 1, { globalRateLimits: [bursty.key('y')] });
        const [costly] = await enqueued(sqlane, 'c', 1, { globalRateLimits: [points.key('z', { cost: 2 })] });

        await block(p, [ahead], '@bursty:x', 1000);
        await block(p, [within], '@bursty:y', 1000);
        await block(p, [costly], '@points:z', 1000);

        /**
         * Sets the tat of a key, then reads its next start at once: the debt shrinks with the time between them.
         * @param {string} key
         * @param {number} debtMs
         * @returns {Promise<number>}
         */
        const nextStartOf = async (key, debtMs) => {
            await setTat(p, key, -debtMs);

            const keys = /** @type {any[]} */ ((await sqlane.jobs.keyStats({ type: 'rate' })).keys);

            return keys.find(entry => `@${entry.limit}:${entry.key}` === key).nextStartInMs;
        };
        // The debt minus the allowance: (burst − cost) × per / max
        const next = {
            'bursty:x': await nextStartOf('@bursty:x', 2500),
            'bursty:y': await nextStartOf('@bursty:y', 1000),
            'points:z': await nextStartOf('@points:z', 3000),
        };

        // 2.5 s − 2 × 1 s
        expect(next['bursty:x']).toBeGreaterThan(400);
        expect(next['bursty:x']).toBeLessThanOrEqual(500);
        // 1 s − 2 s: within the allowance
        expect(next['bursty:y']).toBe(0);
        // 3 s − (4 − 2) × 1 s
        expect(next['points:z']).toBeGreaterThan(900);
        expect(next['points:z']).toBeLessThanOrEqual(1000);
    });

    test('orderBy blocked: the oldest blocked job first; ties by the stored key in byte order', async () => {
        const { sqlane, p } = await fresh();
        const ids = await enqueued(sqlane, 'a', 6, {});

        await block(p, [ids[0]], 'b:1', 1000);
        await block(p, [ids[1]], 'a:1', 3000);
        // A newer job of a:1: its oldest one ranks it
        await block(p, [ids[5]], 'a:1', 500);
        await block(p, [ids[2]], '@r:1', 2000);
        // Two keys due at one time: in byte order, `@` first
        await raw(`UPDATE ${p}jobs SET status = 'blocked', blocked_on = CASE id WHEN ? THEN 'c:1' ELSE '@q' END,
            run_at = (SELECT run_at FROM (SELECT run_at FROM ${p}jobs WHERE id = ?) AS t) WHERE id IN (?, ?)`,
        [ids[3], ids[0], ids[3], ids[4]]);
        // Rows of the held keys only: they come after the blocked ones
        await insertSlot(p, { key: 'z:1', slot: 0, jobId: 'x', heldMs: null, takenAgo: 60_000 });

        const { keys } = await sqlane.jobs.keyStats();

        expect(storedKeys(keys)).toStrictEqual(['a:1', '@r:1', '@q', 'b:1', 'c:1', 'z:1']);
    });

    test('orderBy held: the held keys by their oldest slot, then the other concurrency keys, then the rate keys',
        async () => {
            const { sqlane, p } = await fresh();
            const ids = await enqueued(sqlane, 'a', 8, {});

            await block(p, [ids[0]], '@r', 9000);
            await block(p, [ids[1]], 'blocked:1', 8000);
            await block(p, [ids[2]], 'both:1', 1000);
            // In the tiers without slots, by age, against the order of the keys
            await block(p, [ids[3]], 'blk:a', 1000);
            await block(p, [ids[4]], 'blk:b', 5000);
            await block(p, [ids[5]], '@ra', 1000);
            await block(p, [ids[6]], '@rb', 5000);
            await insertSlot(p, { key: 'held:1', slot: 0, jobId: 'x', heldMs: null, takenAgo: 2000 });
            await insertSlot(p, { key: 'both:1', slot: 0, jobId: 'y', heldMs: null, takenAgo: 5000 });
            // Tier 0 by the oldest slot, against the order of the keys and of the blocked jobs: m:1 also has the
            // oldest blocked job of all
            await insertSlot(p, { key: 'a:1', slot: 0, jobId: 'x', heldMs: null, takenAgo: 1000 });
            await insertSlot(p, { key: 'z:1', slot: 0, jobId: 'x', heldMs: null, takenAgo: 6000 });
            await insertSlot(p, { key: 'm:1', slot: 0, jobId: 'x', heldMs: null, takenAgo: 3000 });
            await block(p, [ids[7]], 'm:1', 20_000);

            const { keys } = await sqlane.jobs.keyStats({ orderBy: 'held' });

            expect(storedKeys(keys))
                .toStrictEqual(['z:1', 'both:1', 'm:1', 'held:1', 'a:1', 'blocked:1', 'blk:b', 'blk:a', '@r', '@rb', '@ra']);
            await expect(sqlane.jobs.keyStats({ type: 'rate', orderBy: 'held' })).rejects.toThrow(InvalidOptionsError);
        });

    test('type filters the keys', async () => {
        const { sqlane, p } = await fresh();
        const ids = await enqueued(sqlane, 'a', 2, {});

        await block(p, [ids[0]], '@r', 1000);
        await block(p, [ids[1]], 'c:1', 1000);

        await expect(sqlane.jobs.keyStats({ type: 'rate' })).resolves.toMatchObject({ keys: [{ type: 'rate' }] });
        await expect(sqlane.jobs.keyStats({ type: 'concurrency' })).resolves.toMatchObject({
            keys: [{ type: 'concurrency', key: 'c:1' }],
        });
    });

    test('blocked counts up to 1000: blockedTruncated above', async () => {
        const { sqlane, p } = await fresh();
        const many = await enqueued(sqlane, 'a', 1001, {});

        await block(p, many.slice(0, 1000), 'k:1000', 1000);
        await block(p, many.slice(1000), 'k:1001', 1000);
        await expect(sqlane.jobs.keyStats({ type: 'concurrency' })).resolves.toMatchObject({
            keys: [{ key: 'k:1000', blocked: 1000, blockedTruncated: false }, { key: 'k:1001', blocked: 1 }],
        });
        await block(p, many.slice(1000), 'k:1000', 1000);
        await expect(sqlane.jobs.keyStats({ type: 'concurrency' })).resolves.toMatchObject({
            keys: [{ key: 'k:1000', blocked: 1000, blockedTruncated: true }],
        });
    });

    test('limit and truncated', async () => {
        const { sqlane, p } = await fresh();
        const ids = await enqueued(sqlane, 'a', 3, {});

        await block(p, [ids[0]], 'k:1', 3000);
        await block(p, [ids[1]], 'k:2', 2000);
        await block(p, [ids[2]], 'k:3', 1000);
        await expect(sqlane.jobs.keyStats({ limit: 2 })).resolves.toMatchObject({
            keys: [{ key: 'k:1' }, { key: 'k:2' }],
            truncated: true,
        });
        await expect(sqlane.jobs.keyStats({ limit: 3 })).resolves.toMatchObject({ truncated: false });
        await expect(sqlane.jobs.keyStats({ limit: 3 })).resolves.toHaveProperty('keys.length', 3);
    });

    test('not shown: a due job that no claim has seen; a job counts only on the key it is blocked on', async () => {
        const { sqlane, p } = await fresh();
        const other = defineConcurrencyLimit({ name: 'other', max: 1 });

        await enqueued(sqlane, 'unhandled', 1, { globalConcurrencyLimits: [ORDER.key('a')] });

        const [twoKeys] = await enqueued(sqlane, 'b', 1, { globalConcurrencyLimits: [ORDER.key('b'), other.key('b')] });

        await expect(sqlane.jobs.keyStats()).resolves.toStrictEqual({ keys: [], truncated: false });
        await block(p, [twoKeys], 'other:b', 1000);
        await expect(sqlane.jobs.keyStats()).resolves.toMatchObject({ keys: [{ key: 'other:b', blocked: 1 }] });
        await expect(sqlane.jobs.keyStats()).resolves.toHaveProperty('keys.length', 1);
    });

    test('a missed unblock: a blocked job on a key with room; the recovery sweep repairs it', async () => {
        const p = nextPrefix();
        const sqlane = sqlaneOn(p);

        await sqlane.schema.migrate();

        const [job] = await enqueued(sqlane, 'unhandled', 1, { globalConcurrencyLimits: [ORDER.key('a')] });

        await block(p, [job], 'order:a', 1000);

        const { keys: [key] } = await sqlane.jobs.keyStats();

        expect(key).toMatchObject({ type: 'concurrency', key: 'order:a', max: 2, held: 0, lingering: 0, blocked: 1 });

        // A process that does not handle the name sweeps: the job is pending, and the key is gone
        const sweeper = sqlaneOn(p, { timings: { ...TIMINGS, recoveryIntervalMs: 100 } });

        await sweeper.start();
        await waitFor(async () => (await sqlane.jobs.get(job))?.status === 'pending');
        await expect(sqlane.jobs.keyStats()).resolves.toStrictEqual({ keys: [], truncated: false });
    });

    test.each([
        [{ unknown: 1 }],
        [{ limit: 0 }],
        [{ limit: 1001 }],
        [{ limit: 1.5 }],
        [{ limit: '5' }],
        [{ type: 'mutex' }],
        [{ type: null }],
        [{ orderBy: 'age' }],
        [null],
        ['x'],
    ])('rejects %j with an InvalidOptionsError', async (options) => {
        const { sqlane } = await fresh();

        await expect(sqlane.jobs.keyStats(/** @type {any} */ (options))).rejects.toThrow(InvalidOptionsError);
    });

    test('without the index of 0008_job_list', async () => {
        const p = nextPrefix();
        const sqlane = sqlaneOn(p);

        await sqlane.schema.migrate();
        await raw(DROP_JOBS_LIST_SQL[database.family](p));

        const [job] = await enqueued(sqlane, 'a', 1, { globalConcurrencyLimits: [ORDER.key('a')] });

        await block(p, [job], 'order:a', 1000);
        await expect(sqlane.jobs.keyStats()).resolves.toMatchObject({ keys: [{ key: 'order:a', blocked: 1, max: 2 }] });
    });

    test('undefined options count as absent', async () => {
        const { sqlane } = await fresh();

        await expect(sqlane.jobs.keyStats({ limit: undefined, type: undefined, orderBy: undefined }))
            .resolves.toStrictEqual({ keys: [], truncated: false });
        await expect(sqlane.jobs.keyStats(undefined)).resolves.toStrictEqual({ keys: [], truncated: false });
    });
});
