import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, inject, test, vi } from 'vitest';
import { resolveDefaults } from '../../src/defaults.js';
import { toErrorJson } from '../../src/error_json.js';
import { createSqlane, defineConcurrencyLimit, defineLane, defineRateLimit, RateLimitedError } from '../../src/index.js';
import { buildNewJob } from '../../src/new_job.js';
import { createStore } from '../../src/store/store.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';
import { testLane } from '../support/runners.js';

/** @typedef {import('../../src/store/store.js').ClaimedJob} ClaimedJob */
/** @typedef {import('../../src/store/store.js').Store} Store */

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const READ_JOB_SQL = {
    mysql: p => `
        SELECT j.status, j.attempts, j.stalls, j.lock_token, j.failure_lane, CAST(j.last_error AS CHAR) AS last_error,
               CAST(pl.payload AS CHAR) AS payload,
               TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), j.run_at) DIV 1000 AS run_in_ms,
               TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), j.locked_until) DIV 1000 AS lease_in_ms,
               TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), j.expires_at) DIV 1000 AS expires_in_ms,
               j.timed_out_at IS NOT NULL AS timed_out
          FROM ${p}jobs j LEFT JOIN ${p}payloads pl ON pl.id = j.id WHERE j.id = ?`,
    postgres: p => `
        SELECT j.status, j.attempts, j.stalls, j.lock_token, j.failure_lane, j.last_error::text AS last_error,
               pl.payload::text AS payload,
               (EXTRACT(EPOCH FROM j.run_at - clock_timestamp()) * 1000)::bigint AS run_in_ms,
               (EXTRACT(EPOCH FROM j.locked_until - clock_timestamp()) * 1000)::bigint AS lease_in_ms,
               (EXTRACT(EPOCH FROM j.expires_at - clock_timestamp()) * 1000)::bigint AS expires_in_ms,
               j.timed_out_at IS NOT NULL AS timed_out
          FROM ${p}jobs j LEFT JOIN ${p}payloads pl ON pl.id = j.id WHERE j.id = $1`,
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const READ_HOLDS_SQL = {
    mysql: p => `SELECT limit_key, job_id, TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), held_until) DIV 1000 AS held_in_ms
                  FROM ${p}concurrency_slots ORDER BY limit_key`,
    postgres: p => `SELECT limit_key, job_id,
                           (EXTRACT(EPOCH FROM held_until - clock_timestamp()) * 1000)::bigint AS held_in_ms
                      FROM ${p}concurrency_slots ORDER BY limit_key`,
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const INSERT_HOLD_SQL = {
    mysql: p => `INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
                 VALUES (?, 0, ?, ?, UTC_TIMESTAMP(3) + INTERVAL ? SECOND, UTC_TIMESTAMP(3))`,
    postgres: p => `INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
                    VALUES ($1, 0, $2, $3, clock_timestamp() + $4 * interval '1 second', clock_timestamp())`,
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const INSERT_ORPHAN_SQL = {
    mysql: p => `INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
                 VALUES (?, 0, ?, ?, NULL, UTC_TIMESTAMP(3))`,
    postgres: p => `INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
                    VALUES ($1, 0, $2, $3, NULL, clock_timestamp())`,
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const READ_RATES_SQL = {
    mysql: p => `SELECT limit_key, TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(6), tat) DIV 1000 AS ahead_ms
                   FROM ${p}rate_limits ORDER BY limit_key`,
    postgres: p => `SELECT limit_key, (EXTRACT(EPOCH FROM tat - clock_timestamp()) * 1000)::bigint AS ahead_ms
                      FROM ${p}rate_limits ORDER BY limit_key`,
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const READ_BLOCKED_ON_SQL = {
    mysql: p => `SELECT blocked_on FROM ${p}jobs WHERE id = ?`,
    postgres: p => `SELECT blocked_on FROM ${p}jobs WHERE id = $1`,
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const INSERT_RATE_SQL = {
    mysql: p => `INSERT INTO ${p}rate_limits (limit_key, tat) VALUES (?, UTC_TIMESTAMP(6) + INTERVAL ? SECOND)`,
    postgres: p => `INSERT INTO ${p}rate_limits (limit_key, tat)
                    VALUES ($1, clock_timestamp() + $2 * interval '1 second')`,
};

/** The first parameter of a statement */
const FIRST_PARAM = { mysql: '?', postgres: '$1' };
/** The second parameter of a statement */
const SECOND_PARAM = { mysql: '?', postgres: '$2' };
/** A stall recovery that finds no work */
const NO_RECOVERY_WORK = { stale: [], lingers: false, orphans: false, blocked: false, idleRateKeys: false };
const LEASE_MS = 240_000;
const defaults = resolveDefaults();
const order = defineConcurrencyLimit({ name: 'order', max: 1 });
const withKeys = defineLane({
    name: 'sync_order',
    globalConcurrencyLimits: ({ payload }) => [order.key(payload.orderId)],
    timeout: '1m',
    failureLane: defineLane({ name: 'sync_failed' }),
});

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
 * @returns {Promise<{ p: string, sqlane: import('../../src/types.js').Sqlane<any>, store: Store }>}
 */
async function freshTables() {
    prefixCount++;

    const p = `${database.tablePrefix}${prefixCount}_`;
    const sqlane = createSqlane({ adapter: testAdapter.adapter, tablePrefix: p });

    await sqlane.schema.migrate();

    return { p, sqlane, store: createStore(testAdapter.adapter, p) };
}

/**
 * Enqueues a due job with a global limit and claims it.
 * @param {{ sqlane: import('../../src/types.js').Sqlane<any>, store: Store }} tables
 * @param {Record<string, unknown>} [options] Enqueue options.
 * @param {number} [leaseMs]
 * @returns {Promise<ClaimedJob>}
 */
async function claimedJob({ sqlane, store }, options = {}, leaseMs = LEASE_MS) {
    const { id } = await sqlane.enqueue(testAdapter.pool, withKeys, { orderId: 1 }, {
        runAt: new Date(Date.now() - 1000),
        ...options,
    });
    const { jobs: [job] } = await store.claim({
        candidateIds: [id],
        fullIds: [],
        lockToken: `T${Date.now()}${Math.random()}`.slice(0, 26),
        lockedBy: 'test',
        leaseMs,
        pick: locked => locked,
    });

    return job;
}

/**
 * @param {string} p
 * @param {string} id
 * @returns {Promise<Record<string, any> | undefined>}
 */
async function readJob(p, id) {
    const [row] = await database.query(READ_JOB_SQL[database.family](p), [id]);

    return row && {
        ...row,
        last_error: row.last_error === null ? null : JSON.parse(String(row.last_error)),
        payload: row.payload === null ? null : JSON.parse(String(row.payload)),
        run_in_ms: Number(row.run_in_ms),
        lease_in_ms: row.lease_in_ms === null ? null : Number(row.lease_in_ms),
        expires_in_ms: row.expires_in_ms === null ? null : Number(row.expires_in_ms),
        timed_out: Boolean(row.timed_out),
    };
}

/**
 * @param {string} p
 * @returns {Promise<{ limit_key: string, job_id: string, held_in_ms: number | null }[]>}
 */
async function readHolds(p) {
    return (await database.query(READ_HOLDS_SQL[database.family](p))).map(row => ({
        limit_key: String(row.limit_key),
        job_id: String(row.job_id),
        held_in_ms: row.held_in_ms === null ? null : Number(row.held_in_ms),
    }));
}

/**
 * Observes driver queries, including transaction boundaries, without counting pool.query() forwarding twice.
 * @param {import('pg').Pool} pool
 * @returns {() => number} Stops recording, restores the clients, and returns the query count.
 */
function recordPostgresQueries(pool) {
    /** @type {Set<import('pg').PoolClient>} */
    const clients = new Set();
    /** @type {{ mock: { calls: unknown[][] }, mockRestore: () => void }[]} */
    const spies = [];

    /** @param {import('pg').PoolClient} client */
    function trackQueries(client) {
        if (!clients.has(client)) {
            clients.add(client);
            spies.push(vi.spyOn(client, 'query'));
        }
    }

    pool.on('acquire', trackQueries);

    return () => {
        pool.off('acquire', trackQueries);
        let count = 0;

        for (const spy of spies) {
            count += spy.mock.calls.length;
            spy.mockRestore();
        }

        return count;
    };
}

/**
 * The failure job of `sync_failed`, with the defaults.
 * @type {import('../../src/store/store.js').FailureJobBuilder}
 */
const failureJob = {
    lane: 'sync_failed',
    build: failed => buildNewJob({
        lane: 'sync_failed',
        definition: null,
        defaults,
        payload: { job: failed, error: failed.error },
        options: undefined,
        maxPayloadBytes: Infinity,
    }),
};

test('renewLeases: the own jobs only', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables, {}, 1000);
    const renewed = await tables.store.renewLeases([job, { id: job.id, lockToken: 'other' }], 600_000);

    expect(renewed).toStrictEqual(new Set([job.id]));
    expect((await readJob(tables.p, job.id))?.lease_in_ms).toBeGreaterThan(590_000);
});

test('completeJobs: completed until its retention, without payload and keys; a replay changes nothing', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables, { retention: { completed: '10m' } });

    await expect(tables.store.completeJobs([job])).resolves.toBe(1);
    await expect(tables.store.completeJobs([job])).resolves.toBe(0);

    const row = await readJob(tables.p, job.id);

    expect(row).toMatchObject({ status: 'completed', lock_token: null, payload: null, lease_in_ms: null });
    expect(row?.expires_in_ms).toBeGreaterThan(590_000);
    await expect(readHolds(tables.p)).resolves.toStrictEqual([]);
});

test('completeJobs: the completion counts its attempt: 1 at the first attempt, 2 after a retry; a replay adds none',
    async () => {
        const tables = await freshTables();
        const first = await claimedJob(tables);

        await tables.store.completeJobs([first]);
        await tables.store.completeJobs([first]);
        await expect(readJob(tables.p, first.id)).resolves.toMatchObject({ status: 'completed', attempts: 1 });

        const retried = await claimedJob(tables);

        await tables.store.retryJob(retried, { delayMs: 0, error: toErrorJson(new Error('boom')) });

        const { jobs: [again] } = await tables.store.claim({
            candidateIds: [retried.id],
            fullIds: [],
            lockToken: `T${Date.now()}${Math.random()}`.slice(0, 26),
            lockedBy: 'test',
            leaseMs: LEASE_MS,
            pick: locked => locked,
        });

        await tables.store.completeJobs([again]);
        await expect(readJob(tables.p, retried.id)).resolves.toMatchObject({ status: 'completed', attempts: 2 });
    });

test.runIf(inject('databaseDialect') === 'postgres')('completeJobs: PostgreSQL completes in one driver query', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables, { retention: { completed: '10m' } });
    const stopRecording = recordPostgresQueries(/** @type {import('pg').Pool} */ (testAdapter.pool));
    let queryCount = 0;

    try {
        await expect(tables.store.completeJobs([job])).resolves.toBe(1);
    } finally {
        queryCount = stopRecording();
    }

    const row = await readJob(tables.p, job.id);

    expect(row).toMatchObject({ status: 'completed', lock_token: null, payload: null, lease_in_ms: null });
    expect(row?.expires_in_ms).toBeGreaterThan(590_000);
    await expect(readHolds(tables.p)).resolves.toStrictEqual([]);
    expect(queryCount).toBe(1);
});

test.runIf(inject('databaseDialect') === 'postgres')('completeJobs: PostgreSQL rolls back when payload cleanup fails', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables);

    await database.query(`
        CREATE FUNCTION ${tables.p}reject_payload_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'completion payload delete refused';
        END;
        $$
    `);

    try {
        await database.query(`
            CREATE TRIGGER reject_payload_delete BEFORE DELETE ON ${tables.p}payloads
            FOR EACH ROW EXECUTE FUNCTION ${tables.p}reject_payload_delete()
        `);

        await expect(tables.store.completeJobs([job])).rejects.toThrow('completion payload delete refused');
        await expect(readJob(tables.p, job.id)).resolves.toMatchObject({
            status: 'running',
            lock_token: job.lockToken,
            payload: { orderId: 1 },
        });
        await expect(readHolds(tables.p)).resolves.toMatchObject([{ limit_key: 'order:1', job_id: job.id }]);
    } finally {
        await database.query(`DROP FUNCTION ${tables.p}reject_payload_delete() CASCADE`);
    }
});

test('completeJobs: one write for many jobs, the own ones only; the payload of a job not completed stays', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables);
    const ids = (await tables.sqlane.enqueueMany(testAdapter.pool, testLane('plain'), [{ payload: { n: 1 } }, { payload: { n: 2 } }]))
        .map(result => result.id);
    const { jobs: [plain, lost] } = await tables.store.claim({
        candidateIds: ids,
        fullIds: [],
        lockToken: 'PLAINTOKEN',
        lockedBy: 'test',
        leaseMs: LEASE_MS,
        pick: locked => locked,
    });

    await expect(tables.store.completeJobs([job, plain, { ...lost, lockToken: 'other' }])).resolves.toBe(2);
    await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'completed', payload: null });
    await expect(readJob(tables.p, plain.id)).resolves.toMatchObject({ status: 'completed', payload: null });
    await expect(readJob(tables.p, lost.id)).resolves.toMatchObject({ status: 'running', payload: { n: 2 } });
    await expect(readHolds(tables.p)).resolves.toStrictEqual([]);
});

test('a write with another lock token changes nothing', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables);
    const other = { id: job.id, lockToken: 'other' };

    await expect(tables.store.completeJobs([other])).resolves.toBe(0);
    await expect(tables.store.retryJob(other, { delayMs: 0, error: toErrorJson('x') })).resolves.toBe(false);
    await expect(tables.store.releaseJob(other, { delayMs: 0, lingerMs: 0 })).resolves.toBe(false);
    await expect(tables.store.failJob(other, { error: toErrorJson('x'), failureJob, attemptUsed: true }))
        .resolves.toStrictEqual({ changed: false, failureResult: null });
    await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'running', lock_token: job.lockToken });
    await expect(readHolds(tables.p)).resolves.toMatchObject([{ limit_key: 'order:1', job_id: job.id }]);
});

test('retryJob: pending after the delay, one attempt used, the error kept, the keys freed', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables);

    await expect(tables.store.retryJob(job, { delayMs: 60_000, error: toErrorJson(new Error('boom')) }))
        .resolves.toBe(true);

    const row = await readJob(tables.p, job.id);

    expect(row).toMatchObject({ status: 'pending', attempts: 1, lock_token: null, last_error: { message: 'boom' } });
    expect(row?.run_in_ms).toBeGreaterThan(55_000);
    await expect(readHolds(tables.p)).resolves.toStrictEqual([]);
});

/**
 * @param {string} p
 * @returns {Promise<Record<string, number>>} The ms that the tat of each rate key is ahead of now.
 */
async function readRates(p) {
    const rows = await database.query(READ_RATES_SQL[database.family](p));

    return Object.fromEntries(rows.map(row => [String(row.limit_key), Number(row.ahead_ms)]));
}

describe('rateLimited', () => {
    // 10 per s, bursts of 5: τ = 400 ms
    const api = defineRateLimit({ name: 'api', max: 10, per: '1s', burst: 5 });
    const quota = defineRateLimit({ name: 'quota', max: 1, per: '1h' });

    test('the keys wait retryAfter, by the settings of the job; the job is blocked on the first, without an attempt; '
        + 'its slots are freed', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables, { globalRateLimits: [quota, api.key('a')] });
        const error = toErrorJson(new RateLimitedError({ retryAfter: '30s' }));

        expect(job.rateLimits.map(limit => limit.key)).toStrictEqual(['@api:a', '@quota']);
        await expect(tables.store.rateLimited(job, { limits: job.rateLimits, retryAfterMs: 30_000, error }))
            .resolves.toStrictEqual({ changed: true, delayMs: expect.any(Number) });
        await expect(readJob(tables.p, job.id)).resolves.toMatchObject({
            status: 'blocked',
            attempts: 0,
            lock_token: null,
            lease_in_ms: null,
            last_error: { name: 'RateLimitedError' },
        });
        await expect(database.query(READ_BLOCKED_ON_SQL[database.family](tables.p), [job.id]))
            .resolves.toMatchObject([{ blocked_on: '@api:a' }]);
        await expect(readHolds(tables.p)).resolves.toStrictEqual([]);

        // The next start at 30 s: then one per 100 ms. The claim took the quota of the hour already: it stays.
        const rates = await readRates(tables.p);

        expect(rates['@api:a']).toBeGreaterThan(30_350);
        expect(rates['@api:a']).toBeLessThanOrEqual(30_400);
        expect(rates['@quota']).toBeGreaterThan(3_590_000);
    });

    test('the wait of the job on its key; a key further ahead stays', async () => {
        const tables = await freshTables();
        const error = toErrorJson(new RateLimitedError({ retryAfter: '1m' }));
        const first = await claimedJob(tables, { globalRateLimits: [api.key('a')] });
        const firstResult = await tables.store.rateLimited(first, {
            limits: first.rateLimits,
            retryAfterMs: 60_000,
            error,
        });

        expect(firstResult.delayMs).toBeGreaterThan(59_900);
        expect(firstResult.delayMs).toBeLessThanOrEqual(60_000);

        // Another job, on the same key: a shorter retryAfter does not bring the key back
        const second = await claimedJob(tables, { globalRateLimits: [api.key('b')] });
        const secondResult = await tables.store.rateLimited(second, {
            limits: [{ ...second.rateLimits[0], key: '@api:a' }],
            retryAfterMs: 1000,
            error,
        });

        expect(secondResult.delayMs).toBeGreaterThan(59_000);
        expect((await readRates(tables.p))['@api:a']).toBeGreaterThan(60_000);
    });

    test('a key without a row: created', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables);

        await expect(tables.store.rateLimited(job, {
            limits: [{ key: '@api', max: 10, per_us: 1_000_000, burst: 1, cost: 1 }],
            retryAfterMs: 5000,
            error: toErrorJson('limited'),
        })).resolves.toMatchObject({ changed: true });

        const rates = await readRates(tables.p);

        expect(rates['@api']).toBeGreaterThan(4900);
        expect(rates['@api']).toBeLessThanOrEqual(5000);
    });

    test('a lost lock: no change', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables, { globalRateLimits: [api.key('a')] });
        const before = await readRates(tables.p);

        await expect(tables.store.rateLimited({ ...job, lockToken: 'other' }, {
            limits: job.rateLimits,
            retryAfterMs: 60_000,
            error: toErrorJson('limited'),
        })).resolves.toStrictEqual({ changed: false, delayMs: 0 });
        await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'running', lock_token: job.lockToken });
        await expect(readHolds(tables.p)).resolves.toMatchObject([{ limit_key: 'order:1', job_id: job.id }]);
        expect((await readRates(tables.p))['@api:a']).toBeLessThanOrEqual(before['@api:a']);
    });
});

describe('failJob', () => {
    test('failed with its payload; its failure job added in the same transaction', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables, { dedupeKey: 'o1' });
        const result = await tables.store.failJob(job, {
            error: toErrorJson(new Error('gone')),
            failureJob,
            attemptUsed: true,
        });

        expect(result).toMatchObject({ changed: true, failureResult: { added: { lane: 'sync_failed' } } });
        await expect(readJob(tables.p, job.id)).resolves.toMatchObject({
            status: 'failed',
            attempts: 1,
            payload: { orderId: 1 },
            last_error: { name: 'Error', message: 'gone' },
        });

        const failureId = /** @type {{ added: { id: string } }} */ (result.failureResult).added.id;

        await expect(readJob(tables.p, failureId)).resolves.toMatchObject({
            status: 'pending',
            failure_lane: null,
            payload: {
                job: { id: 'sync_order:o1', lane: 'sync_order', payload: { orderId: 1 }, attempt: 1, maxAttempts: 3 },
                error: { name: 'Error', message: 'gone' },
            },
        });
        await expect(readHolds(tables.p)).resolves.toStrictEqual([]);
    });

    test('a failure job that the database refuses: the job still fails, without it', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables);
        const result = await tables.store.failJob(job, {
            error: toErrorJson('gone'),
            failureJob: { ...failureJob, build: failed => ({ ...failureJob.build(failed), lane: 'x'.repeat(200) }) },
            attemptUsed: true,
        });

        expect(result.changed).toBe(true);
        expect(result.failureResult).toMatchObject({ notAdded: expect.anything(), failureLane: 'sync_failed' });
        await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'failed' });

        const [{ count }] = await database.query(`SELECT COUNT(*) AS count FROM ${tables.p}jobs`);

        expect(Number(count)).toBe(1);
    });

    test('a failure job whose payload the database refuses: no job row without its payload', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables);
        const result = await tables.store.failJob(job, {
            error: toErrorJson('gone'),
            // MySQL refuses it in the JSON column, after the job row; on PostgreSQL, JSON.parse throws before the SQL
            failureJob: { ...failureJob, build: failed => ({ ...failureJob.build(failed), payloadJson: '{not json' }) },
            attemptUsed: true,
        });

        expect(result.failureResult).toHaveProperty('notAdded');
        await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'failed' });

        const [{ count }] = await database.query(`SELECT COUNT(*) AS count FROM ${tables.p}jobs`);

        expect(Number(count)).toBe(1);
    });

    test('a failure job that cannot be built: the job still fails, without it', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables);
        const result = await tables.store.failJob(job, {
            error: toErrorJson('gone'),
            failureJob: {
                lane: 'sync_failed',
                build: () => {
                    throw new Error('bad options');
                },
            },
            attemptUsed: true,
        });

        expect(result).toMatchObject({
            changed: true,
            failureResult: { notAdded: { message: 'bad options' }, failureLane: 'sync_failed' },
        });
    });

    test('a builder without a failure lane (a definition without one): no failure job', async () => {
        const tables = await freshTables();
        const none = await claimedJob(tables);

        await expect(tables.store.failJob(none, {
            error: toErrorJson('gone'),
            failureJob: { ...failureJob, lane: null },
            attemptUsed: true,
        })).resolves.toStrictEqual({ changed: true, failureResult: null });
        await expect(readJob(tables.p, none.id)).resolves.toMatchObject({ status: 'failed', failure_lane: null });

        const [{ count }] = await database.query(`SELECT COUNT(*) AS count FROM ${tables.p}jobs`);

        expect(Number(count)).toBe(1);
    });

    test('without an attempt used (a job past its maxStalls, failed at its claim): its attempts stay', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables);
        const result = await tables.store.failJob(job, { error: toErrorJson('gone'), failureJob, attemptUsed: false });

        expect(result).toMatchObject({ changed: true, failureResult: { added: { lane: 'sync_failed' } } });
        await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'failed', attempts: 0 });
        await expect(readHolds(tables.p)).resolves.toStrictEqual([]);
    });
});

test('releaseJob: pending without an attempt used; the keys freed, or lingering while the handler runs', async () => {
    const tables = await freshTables();
    const freed = await claimedJob(tables);

    await expect(tables.store.releaseJob(freed, { delayMs: 0, lingerMs: 0 })).resolves.toBe(true);
    await expect(readJob(tables.p, freed.id)).resolves.toMatchObject({ status: 'pending', attempts: 0 });
    await expect(readHolds(tables.p)).resolves.toStrictEqual([]);

    const lingering = await claimedJob(tables);

    await tables.store.releaseJob(lingering, { delayMs: 32_000, lingerMs: 32_000 });

    const [hold] = await readHolds(tables.p);

    expect(hold.held_in_ms).toBeGreaterThan(30_000);
    expect((await readJob(tables.p, lingering.id))?.run_in_ms).toBeGreaterThan(30_000);
});

test('markTimedOut: the job stays running, marked; the next claim clears the mark', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables);

    await expect(tables.store.markTimedOut(job)).resolves.toBe(true);
    await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'running', timed_out: true });
    await tables.store.retryJob(job, { delayMs: 0, error: toErrorJson('timeout') });
    await expect(readJob(tables.p, job.id)).resolves.toMatchObject({ status: 'pending', timed_out: false });
});

describe('stall recovery', () => {
    test('a stale job: one more stall, pending after 30 s; its keys linger for one lease', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables, {}, 1);

        await sleep(20);
        await expect(tables.store.findRecoveryWork(10)).resolves.toMatchObject({
            stale: [{ id: job.id, lane: 'sync_order' }],
        });
        const recovered = await tables.store.recoverStaleJob(job.id, { leaseMs: 60_000 });

        // The run that stalled: the first attempt
        expect(recovered).toStrictEqual({ result: 'released', attempt: 1 });

        const row = await readJob(tables.p, job.id);

        expect(row).toMatchObject({ status: 'pending', stalls: 1, attempts: 0, last_error: { name: 'StalledError' } });
        expect(row?.run_in_ms).toBeGreaterThan(28_000);
        expect((await readHolds(tables.p))[0].held_in_ms).toBeGreaterThan(55_000);
        await expect(tables.store.recoverStaleJob(job.id, { leaseMs: 60_000 }))
            .resolves.toStrictEqual({ result: null });
    });

    test('past maxStalls: released as any stall, its stalls above its max, due at once in its place in line (its due '
        + 'time kept); no failure job here', async () => {
        const tables = await freshTables();
        const job = await claimedJob(tables, { maxStalls: 0, runAt: new Date(Date.now() - 60_000) }, 1);

        await sleep(20);

        const recovered = await tables.store.recoverStaleJob(job.id, { leaseMs: 60_000 });

        expect(recovered).toStrictEqual({ result: 'released', attempt: 1 });

        const row = await readJob(tables.p, job.id);

        expect(row).toMatchObject({ status: 'pending', stalls: 1, attempts: 0, last_error: { name: 'StalledError' } });
        // Its due time of a minute ago, not now: the jobs of its lane due since then come after it
        expect(row?.run_in_ms).toBeLessThan(-55_000);
        // Its keys linger for one lease, as after any stall: its old handler may still run
        expect((await readHolds(tables.p))[0].held_in_ms).toBeGreaterThan(55_000);

        const [{ count }] = await database.query(`SELECT COUNT(*) AS count FROM ${tables.p}jobs`);

        expect(Number(count)).toBe(1);
    });

    test('a running job with its lease is not stale', async () => {
        const tables = await freshTables();

        await claimedJob(tables);
        await expect(tables.store.findRecoveryWork(10)).resolves.toStrictEqual(NO_RECOVERY_WORK);
    });

    test('findRecoveryWork: the stale jobs, the oldest lease first, and the parts of the sweep with work', async () => {
        const tables = await freshTables();
        const { p } = tables;
        const family = database.family;
        const param = FIRST_PARAM[family];

        await expect(tables.store.findRecoveryWork(10)).resolves.toStrictEqual(NO_RECOVERY_WORK);

        const first = await claimedJob(tables, {}, 1);

        // Its slot goes, so that the second job of the key gets it
        await database.query(`DELETE FROM ${p}concurrency_slots WHERE job_id = ${param}`, [first.id]);
        await sleep(5);

        const second = await claimedJob(tables, {}, 1);

        await sleep(20);
        await expect(tables.store.findRecoveryWork(10)).resolves.toStrictEqual({
            ...NO_RECOVERY_WORK,
            stale: [{ id: first.id, lane: 'sync_order' }, { id: second.id, lane: 'sync_order' }],
        });
        await expect(tables.store.findRecoveryWork(1)).resolves.toMatchObject({ stale: [{ id: first.id }] });

        // Each part with work, one at a time
        await database.query(INSERT_HOLD_SQL[family](p), ['ended', 'gone', 'old', -1]);
        await expect(tables.store.findRecoveryWork(0)).resolves.toStrictEqual({ ...NO_RECOVERY_WORK, lingers: true });
        await database.query(`DELETE FROM ${p}concurrency_slots WHERE limit_key = 'ended'`);
        await database.query(INSERT_ORPHAN_SQL[family](p), ['orphan', 'gone', 'old']);
        await expect(tables.store.findRecoveryWork(0)).resolves.toStrictEqual({ ...NO_RECOVERY_WORK, orphans: true });
        await database.query(`DELETE FROM ${p}concurrency_slots WHERE limit_key = 'orphan'`);
        await database.query(`UPDATE ${p}jobs SET status = 'blocked', blocked_on = 'order:9' WHERE id = ${param}`,
            [first.id]);
        await expect(tables.store.findRecoveryWork(0)).resolves.toStrictEqual({ ...NO_RECOVERY_WORK, blocked: true });
        await database.query(`UPDATE ${p}jobs SET status = 'running', blocked_on = NULL WHERE id = ${param}`,
            [first.id]);
        await database.query(INSERT_RATE_SQL[family](p), ['@api:1', -1]);
        await database.query(INSERT_RATE_SQL[family](p), ['@api:2', 60]);
        await expect(tables.store.findRecoveryWork(0)).resolves
            .toStrictEqual({ ...NO_RECOVERY_WORK, idleRateKeys: true });
        await expect(tables.store.deleteIdleRateKeys(100)).resolves.toBe(1);
        // A row whose tat is ahead is not idle
        await expect(tables.store.findRecoveryWork(0)).resolves.toStrictEqual(NO_RECOVERY_WORK);
    });
});

test('sweepSlots: the blocked part unblocks a concurrency key with room and a rate key whose time came; without '
    + 'it, they stay blocked', async () => {
    const tables = await freshTables();
    const { p } = tables;
    const quick = defineRateLimit({ name: 'quick', max: 10, per: '1s' });
    const runAt = new Date(Date.now() - 1000);
    const onKey = await tables.sqlane.enqueue(testAdapter.pool, withKeys, { orderId: 1 }, { runAt });
    const onRate = await tables.sqlane.enqueue(testAdapter.pool, withKeys, { orderId: 2 }, {
        globalRateLimits: [quick.key('a')],
        runAt,
    });
    const block = `UPDATE ${p}jobs SET status = 'blocked', blocked_on = ${FIRST_PARAM[database.family]}
                    WHERE id = ${SECOND_PARAM[database.family]}`;

    // No slot of order:1 is held, and @quick:a has no row: both have room
    await database.query(block, ['order:1', onKey.id]);
    await database.query(block, ['@quick:a', onRate.id]);
    await expect(tables.store.sweepSlots(100, { lingers: false, orphans: false, blocked: false })).resolves
        .toStrictEqual({ lingers: 0, orphans: 0, unblocked: 0, rateWaits: [] });
    await expect(readJob(p, onKey.id)).resolves.toMatchObject({ status: 'blocked' });
    await expect(readJob(p, onRate.id)).resolves.toMatchObject({ status: 'blocked' });

    const swept = await tables.store.sweepSlots(100, { lingers: false, orphans: false, blocked: true });

    expect(swept).toMatchObject({ lingers: 0, orphans: 0, rateWaits: [{ key: '@quick:a', delayMs: expect.any(Number) }] });
    expect(swept.unblocked).toBeGreaterThan(0);
    await expect(readJob(p, onKey.id)).resolves.toMatchObject({ status: 'pending' });
    await expect(readJob(p, onRate.id)).resolves.toMatchObject({ status: 'pending' });
});

test('sweepSlots: deletes the ended lingers and the slots without their running job', async () => {
    const tables = await freshTables();
    const job = await claimedJob(tables);
    const insertHold = INSERT_HOLD_SQL[database.family](tables.p);

    await database.query(insertHold, ['ended', 'gone', 'old', -1]);
    await database.query(insertHold, ['future', 'gone', 'old', 3600]);
    await database.query(INSERT_ORPHAN_SQL[database.family](tables.p), ['orphan', 'gone', 'old']);

    // Only the parts asked for
    await expect(tables.store.sweepSlots(100, { lingers: false, orphans: false, blocked: true })).resolves
        .toStrictEqual({ lingers: 0, orphans: 0, unblocked: 0, rateWaits: [] });
    await expect(tables.store.sweepSlots(100, { lingers: false, orphans: true, blocked: false })).resolves
        .toStrictEqual({ lingers: 0, orphans: 1, unblocked: 0, rateWaits: [] });
    await expect(tables.store.sweepSlots(100)).resolves.toStrictEqual({
        lingers: 1,
        orphans: 0,
        unblocked: 0,
        rateWaits: [],
    });
    await expect(readHolds(tables.p)).resolves.toMatchObject([
        { limit_key: 'future' },
        { limit_key: 'order:1', job_id: job.id },
    ]);
});

test('deleteExpiredJobs: the finished jobs after their retention, with their payloads', async () => {
    const tables = await freshTables();
    // One after the other: the jobs share their key
    const completed = await claimedJob(tables, { retention: { completed: 0 } });

    await tables.store.completeJobs([completed]);

    const failed = await claimedJob(tables, { retention: { failed: 0 } });

    await tables.store.failJob(failed, { error: toErrorJson('x'), failureJob, attemptUsed: true });

    const kept = await claimedJob(tables, { retention: { completed: '1h' } });

    await tables.store.completeJobs([kept]);
    await sleep(5);

    await expect(tables.store.deleteExpiredJobs(100)).resolves.toBe(2);
    await expect(readJob(tables.p, failed.id)).resolves.toBeUndefined();
    await expect(readJob(tables.p, kept.id)).resolves.toMatchObject({ status: 'completed' });

    const ids = new Set([completed.id, failed.id, kept.id]);
    const payloads = await database.query(`SELECT id FROM ${tables.p}payloads`);

    expect(payloads.filter(row => ids.has(String(row.id)))).toStrictEqual([]);
});
