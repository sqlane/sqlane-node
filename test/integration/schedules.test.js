import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from 'vitest';
import { ConfigError, createSqlane, defineJob } from '../../src/index.js';
import { pgAdapter } from '../../src/adapters/pg.js';
import { resolveDefaults } from '../../src/defaults.js';
import { buildNewJob } from '../../src/new_job.js';
import { checkSchedule, dueOf } from '../../src/schedule.js';
import { insertScheduledJobsPostgres } from '../../src/store/postgres_schedules.js';
import { createStore } from '../../src/store/store.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @typedef {import('../../src/types.js').Sqlane<any>} Sqlane */
/** @typedef {import('../../src/types.js').SqlaneEvent} SqlaneEvent */
/** @typedef {import('../../src/store/fire_slots.js').SlotCandidate} SlotCandidate */
/** @typedef {import('../../src/store/fire_slots.js').FireResult} FireResult */

const TIMINGS = { leaseMs: 5000, renewIntervalMs: 500, recoveryIntervalMs: 500 };
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const defaults = resolveDefaults();
const isPostgres = inject('databaseDialect') === 'postgres';

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

/** @returns {string} A table prefix of its own, under the prefix of the file. */
function nextPrefix() {
    prefixCount++;

    return `${database.tablePrefix}${prefixCount}_`;
}

/**
 * A sqlane instance on the given tables.
 * @param {string} p
 * @param {Record<string, unknown>} [options]
 * @returns {{ sqlane: Sqlane, events: SqlaneEvent[] }}
 */
function instanceOn(p, options = {}) {
    /** @type {SqlaneEvent[]} */
    const events = [];
    const { timings, ...rest } = /** @type {{ timings?: object }} */ (options);
    const sqlane = createSqlane(/** @type {any} */ ({
        adapter: testAdapter.adapter,
        tablePrefix: p,
        pollInterval: '100ms',
        onEvent: (/** @type {SqlaneEvent} */ event) => events.push(event),
        timings: { ...TIMINGS, ...timings },
        ...rest,
    }));

    instances.push(sqlane);

    return { sqlane, events };
}

/**
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{ sqlane: Sqlane, p: string, events: SqlaneEvent[] }>} Migrated.
 */
async function freshSqlane(options = {}) {
    const p = nextPrefix();
    const { sqlane, events } = instanceOn(p, options);

    await sqlane.migrate();

    return { sqlane, p, events };
}

/**
 * @param {string} sql With `?` placeholders: `$n` on PostgreSQL.
 * @param {unknown[]} [params]
 * @returns {Promise<Record<string, unknown>[]>}
 */
function query(sql, params = []) {
    let index = 0;

    return database.query(isPostgres ? sql.replaceAll('?', () => `$${++index}`) : sql, params);
}

/**
 * @param {string} p
 * @param {string} [like]
 * @returns {Promise<{ id: string, status: string, runAtMs: number }[]>}
 */
async function readJobs(p, like = '%') {
    const runAtMs = isPostgres
        ? 'floor(EXTRACT(EPOCH FROM run_at) * 1000)::bigint'
        : 'TIMESTAMPDIFF(MICROSECOND, \'1970-01-01\', run_at) DIV 1000';
    const rows = await query(`SELECT id, status, ${runAtMs} AS run_at_ms FROM ${p}jobs WHERE id LIKE ? ORDER BY id`, [like]);

    return rows.map(row => ({ id: String(row.id), status: String(row.status), runAtMs: Number(row.run_at_ms) }));
}

/**
 * @param {string} p
 * @returns {Promise<{ id: string, spec: string, lastSlotMs: number, lastJobId: string | null }[]>}
 */
async function readSchedules(p) {
    const lastSlotMs = isPostgres
        ? 'floor(EXTRACT(EPOCH FROM last_slot_at) * 1000)::bigint'
        : 'TIMESTAMPDIFF(MICROSECOND, \'1970-01-01\', last_slot_at) DIV 1000';
    const rows = await query(`SELECT id, spec, last_job_id, ${lastSlotMs} AS last_slot_ms FROM ${p}schedules ORDER BY id`);

    return rows.map(row => ({
        id: String(row.id),
        spec: String(row.spec),
        lastSlotMs: Number(row.last_slot_ms),
        lastJobId: row.last_job_id === null ? null : String(row.last_job_id),
    }));
}

/**
 * Sets the cursor of a schedule.
 * @param {string} p
 * @param {string} id
 * @param {number} lastSlotMs
 * @param {string} [spec] Also the stored spec.
 */
async function setCursor(p, id, lastSlotMs, spec) {
    const at = new Date(lastSlotMs).toISOString();
    const value = isPostgres ? at : at.replace('T', ' ').replace('Z', '');

    await query(`UPDATE ${p}schedules SET last_slot_at = ?${spec ? ', spec = ?' : ''} WHERE id = ?`, [
        value,
        ...spec ? [spec] : [],
        id,
    ]);
}

/**
 * @param {() => boolean | Promise<boolean>} condition
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitFor(condition, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;

    // oxlint-disable-next-line no-await-in-loop -- polls
    while (!await condition()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor: timed out');
        }

        // oxlint-disable-next-line no-await-in-loop -- polls
        await sleep(20);
    }
}

/**
 * Waits until the latest hourly slot is late (more than the grace of 1 minute old), and the next one is not near.
 * @returns {Promise<number>} The database clock then.
 */
async function awayFromSlot() {
    const now = await dbNow();
    const intoHour = now % HOUR_MS;
    let waitMs = 0;

    if (intoHour < 70_000) {
        waitMs = 70_000 - intoHour;
    } else if (intoHour > HOUR_MS - 30_000) {
        waitMs = HOUR_MS - intoHour + 70_000;
    }

    await sleep(waitMs);

    return dbNow();
}

/** @returns {Promise<number>} The database clock. */
async function dbNow() {
    const [row] = await query(isPostgres
        ? 'SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms'
        : 'SELECT TIMESTAMPDIFF(MICROSECOND, \'1970-01-01\', UTC_TIMESTAMP(3)) DIV 1000 AS now_ms');

    return Number(row.now_ms);
}

/**
 * The job of a slot, as the scheduler builds it.
 * @param {SlotCandidate} candidate
 * @param {boolean} [late]
 * @returns {import('../../src/new_job.js').NewJob}
 */
function slotJob(candidate, late = false) {
    const slot = { at: new Date(candidate.slot) };

    return buildNewJob({
        name: candidate.name,
        definition: null,
        defaults,
        payload: {},
        options: late ? { slot } : { slot, runAt: new Date(candidate.slot) },
        maxPayloadBytes: 1024,
    });
}

/**
 * An adapter whose statements on the schedules fail with a connection error while `down` is set.
 * @returns {{ adapter: import('../../src/types.js').Adapter<any>, state: { down: boolean } }}
 */
function flakyAdapter() {
    const state = { down: true };
    const { queue } = testAdapter.adapter;

    return {
        state,
        adapter: {
            ...testAdapter.adapter,
            queue: {
                ...queue,
                query: (sql, params) => (state.down && sql.includes('schedules')
                    ? Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
                    : queue.query(sql, params)),
            },
        },
    };
}

/**
 * An adapter that counts the inserts of jobs in its queue transactions, and records the statements of its pool.
 * @param {string} p
 * @returns {{ adapter: import('../../src/types.js').Adapter<any>, counts: { inserts: number }, statements: string[] }}
 */
function countingAdapter(p) {
    const counts = { inserts: 0 };
    /** @type {string[]} */
    const statements = [];
    const { adapter } = testAdapter;

    return {
        counts,
        statements,
        adapter: {
            ...adapter,
            queue: {
                ...adapter.queue,
                query: (sql, params) => {
                    statements.push(sql);

                    return adapter.queue.query(sql, params);
                },
            },
            queueTransaction: func => adapter.queueTransaction(executor => func({
                ...executor,
                query: (sql, params) => {
                    counts.inserts += Number(sql.includes(`INSERT INTO ${p}jobs`));

                    return executor.query(sql, params);
                },
            })),
        },
    };
}

/**
 * @param {string[]} ids
 * @param {number} round
 * @param {number} even
 * @param {number} odd
 * @returns {{ id: string, slot: number }[]} The slot of each id: even or odd, by its index and the round.
 */
function alternating(ids, round, even, odd) {
    return ids.map((id, index) => ({ id, slot: (index + round) % 2 ? odd : even }));
}

/**
 * The handler of a scheduled job: the first slot fails its first attempt, then runs for 1.3 s; the second slot fails
 * both attempts; the later ones run 100 ms.
 * @returns {{ handler: import('../../src/types.js').Handler, calls: object[], slots: Date[], startedAt: number[],
 *     maxActive: number }}
 */
function scheduledRuns() {
    const state = {
        /** @type {object[]} */
        calls: [],
        /** @type {Date[]} */
        slots: [],
        /** @type {number[]} */
        startedAt: [],
        maxActive: 0,
        active: 0,
        /** @type {import('../../src/types.js').Handler} */
        handler: async ({ payload, job }) => {
            const scheduledAt = /** @type {Date} */ (job.scheduledAt);

            if (!state.slots.some(slot => slot.getTime() === scheduledAt.getTime())) {
                state.slots.push(scheduledAt);
            }

            const index = state.slots.findIndex(slot => slot.getTime() === scheduledAt.getTime());

            state.calls.push({ id: job.id, payload, scheduledAt, attempt: job.attempt });
            state.startedAt.push(Date.now());
            state.active++;
            state.maxActive = Math.max(state.maxActive, state.active);

            try {
                if ((index === 0 && job.attempt === 1) || index === 1) {
                    throw new Error('fails');
                }

                await sleep(index === 0 ? 1300 : 100);
            } finally {
                state.active--;
            }
        },
    };

    return state;
}

/**
 * @param {number} now The database time.
 * @returns {{ slot: number, options: { every: string, jitter: string, key: string } }} The next slot of
 *     `every: '10s'` at least 1.5 s away, and a key whose jitter of `9s` puts the job of the slot 3 s or more after it.
 */
function slotWithOffset(now) {
    const slot = (Math.floor((now + 1500) / 10_000) + 1) * 10_000;

    for (let index = 0; ; index++) {
        const options = { every: '10s', jitter: '9s', key: `k${index}` };

        if (dueOf(checkSchedule('tick', options), slot) - slot >= 3000) {
            return { slot, options };
        }
    }
}

/**
 * The wake of another process: NOTIFY on PostgreSQL, a hint in memory on MySQL and MariaDB.
 * @returns {Record<string, unknown>}
 */
function wakeOptions() {
    if (isPostgres) {
        return { adapter: pgAdapter(testAdapter.pool, { notify: true }), pollInterval: '1m' };
    }

    /** @type {Set<(message: string) => void>} */
    const subscribers = new Set();

    return {
        pollInterval: '1m',
        hint: {
            publish: async (/** @type {string} */ _, /** @type {string} */ message) => {
                for (const onMessage of subscribers) {
                    onMessage(message);
                }
            },
            subscribe: async (/** @type {string} */ _, /** @type {(message: string) => void} */ onMessage) => {
                subscribers.add(onMessage);

                return async () => {
                    subscribers.delete(onMessage);
                };
            },
        },
    };
}

const CREATED_MS = isPostgres
    ? 'floor(EXTRACT(EPOCH FROM created_at) * 1000)::bigint'
    : 'TIMESTAMPDIFF(MICROSECOND, \'1970-01-01\', created_at) DIV 1000';

/**
 * The fire of the store, as the scheduler calls it, for the candidates of `every` schedules.
 * @param {string} p
 * @param {{ id: string, slot: number, spec?: string, insertMissing?: boolean, catchUpFrom?: number }[]} slots
 * @param {Partial<import('../../src/store/fire_slots.js').FireParams>} [params]
 * @returns {Promise<FireResult>}
 */
function fire(p, slots, params = {}) {
    const candidates = slots.map(({ id, slot, spec = 'every 3600000', insertMissing, catchUpFrom = -Infinity }) => ({
        id,
        name: id,
        spec,
        slot,
        due: slot,
        missed: /** @type {const} */ ('once'),
        overlap: /** @type {const} */ ('allow'),
        catchUpFrom,
        insertMissing,
    })).toSorted((a, b) => (a.id < b.id ? -1 : 1));

    return createStore(testAdapter.adapter, p).fireSlots({
        candidates,
        buildJob: slotJob,
        notifyChannel: null,
        now: Date.now,
        graceMs: 60_000,
        futureMs: 1000,
        ...params,
    });
}

/**
 * Registers schedules with a cursor, as start() does, with the cursor moved back.
 * @param {string} p
 * @param {string[]} ids
 * @param {number} lastSlotMs
 */
async function register(p, ids, lastSlotMs) {
    await createStore(testAdapter.adapter, p).registerSchedules(
        ids.map(id => ({ id, name: id, spec: 'every 3600000' })),
        Date.now,
    );

    for (const id of ids) {
        // oxlint-disable-next-line no-await-in-loop -- one row after the other
        await setCursor(p, id, lastSlotMs);
    }
}

/**
 * @param {FireResult[]} results
 * @returns {string[]} The outcomes of all results, sorted.
 */
function outcomes(results) {
    return results.flatMap(result => [...result.decided.map(({ outcome }) => outcome), ...result.busy.map(() => 'busy')])
        .toSorted();
}

describe('start()', () => {
    test('without the migration: a ConfigError that says to run migrate(), and no timer', async () => {
        const p = nextPrefix();
        const { sqlane } = instanceOn(p);

        sqlane.schedule('tick', { every: '1s' });

        await expect(sqlane.start()).rejects.toThrow(ConfigError);
        await expect(sqlane.start()).rejects.toThrow(`start(): the table ${p}schedules is missing: run migrate()`);
    });

    test('a database that is down: start() resolves, reports the error, and registers when it is back', async () => {
        const { p } = await freshSqlane();
        const { adapter, state } = flakyAdapter();
        const { sqlane, events } = instanceOn(p, { adapter, timings: { schedules: { retryMs: 200 } } });

        sqlane.schedule('tick', { every: '1s' });
        await sqlane.start();
        expect(events).toMatchObject([{ type: 'error', operation: 'schedule' }]);
        state.down = false;
        await waitFor(async () => (await readJobs(p)).length > 0);
    });
});

describe('the fire of the store', () => {
    test('10 concurrent fires of one on-time slot: one job; the others are busy or lost, and never wait', async () => {
        const p = nextPrefix();
        const { sqlane } = instanceOn(p);

        await sqlane.migrate();

        const slot = Math.floor((await dbNow()) / 1000) * 1000;

        await register(p, ['tick'], slot - HOUR_MS);

        const results = await Promise.all(Array.from({ length: 10 }, () => fire(p, [{ id: 'tick', slot }])));

        expect(outcomes(results).filter(outcome => outcome === 'enqueued')).toHaveLength(1);
        expect(outcomes(results).filter(outcome => !['busy', 'lost'].includes(outcome))).toStrictEqual(['enqueued']);
        await expect(readJobs(p)).resolves.toMatchObject([{ id: `tick:schedule:${new Date(slot).toISOString()}` }]);
    });

    test('a holder that sleeps under the lock: the others return at once, busy', async () => {
        const { p } = await freshSqlane();
        const slot = Math.floor((await dbNow()) / 1000) * 1000;

        await register(p, ['tick'], slot - HOUR_MS);

        const holder = fire(p, [{ id: 'tick', slot }], { hooks: { afterLock: () => sleep(1500) } });

        await sleep(200);

        const startedAt = Date.now();
        const others = await Promise.all(Array.from({ length: 5 }, () => fire(p, [{ id: 'tick', slot }])));

        expect(Date.now() - startedAt).toBeLessThan(1000);
        expect(outcomes(others)).toStrictEqual(Array.from({ length: 5 }, () => 'busy'));
        expect(outcomes([await holder])).toStrictEqual(['enqueued']);
    });

    test('the winner rolls back: the next fire wins the slot, one job', async () => {
        const { p } = await freshSqlane();
        const slot = Math.floor((await dbNow()) / 1000) * 1000;

        await register(p, ['tick'], slot - HOUR_MS);

        const holder = fire(p, [{ id: 'tick', slot }], {
            hooks: {
                afterInsert: async () => {
                    await sleep(500);
                    throw new Error('rolled back');
                },
            },
        });

        await sleep(200);
        expect(outcomes([await fire(p, [{ id: 'tick', slot }])])).toStrictEqual(['busy']);
        await expect(holder).rejects.toThrow('rolled back');
        expect(outcomes([await fire(p, [{ id: 'tick', slot }])])).toStrictEqual(['enqueued']);
        await expect(readJobs(p)).resolves.toHaveLength(1);
    });

    test('two processes over overlapping ids, on time and late: no deadlock, one winner per slot', async () => {
        const { p } = await freshSqlane();
        const now = await dbNow();
        const onTime = Math.floor(now / 1000) * 1000;
        const late = onTime - (2 * HOUR_MS);
        const ids = Array.from({ length: 30 }, (_, index) => `s_${String(index).padStart(2, '0')}`);

        await register(p, ids, late - HOUR_MS);

        const results = await Promise.all(Array.from({ length: 6 }, (_, round) => fire(
            p,
            alternating(ids, round, late, onTime),
        )));
        const won = results.flatMap(result => result.decided.filter(({ outcome }) => outcome === 'enqueued'));
        const jobs = await readJobs(p);

        // A schedule can win both slots (late, then on time): one winner per slot, not per schedule
        expect(new Set(won.map(({ id, slot }) => `${id} ${slot}`)).size).toBe(won.length);
        expect(jobs.map(({ id }) => id).toSorted()).toStrictEqual(won.map(({ jobId }) => jobId).toSorted());
        expect((await readSchedules(p)).every(row => row.lastSlotMs >= late)).toBe(true);
    });

    test('monotonic: an older slot is lost; a late slot of another spec, or beyond the reach, is dropped', async () => {
        const { p } = await freshSqlane();
        const now = await dbNow();
        const slot = Math.floor(now / HOUR_MS) * HOUR_MS;

        await register(p, ['a', 'b', 'c', 'd', 'e'], slot - (3 * HOUR_MS));
        await setCursor(p, 'a', slot);

        const result = await fire(p, [
            { id: 'a', slot: slot - HOUR_MS },
            { id: 'b', slot: slot - HOUR_MS, spec: 'every 60000' },
            { id: 'c', slot: slot - HOUR_MS, catchUpFrom: slot - (2 * HOUR_MS) },
            { id: 'd', slot: now + 5000 },
            { id: 'e', slot: slot - HOUR_MS, catchUpFrom: slot - (4 * HOUR_MS) },
        ]);

        expect(result.decided.map(({ id, outcome, late }) => [id, outcome, late])).toStrictEqual([
            ['a', 'lost', true],
            ['b', 'dropped', true],
            ['c', 'dropped', true],
            ['e', 'enqueued', true],
        ]);
        expect(result.deferred).toStrictEqual(['d']);
        await expect(readJobs(p)).resolves.toMatchObject([{ id: `e:schedule:${new Date(slot - HOUR_MS).toISOString()}` }]);
    });

    test('after a manual DELETE of the row: an on-time slot creates it again and wins', async () => {
        const { p } = await freshSqlane();
        const slot = Math.floor((await dbNow()) / 1000) * 1000;

        expect(outcomes([await fire(p, [{ id: 'tick', slot }])])).toStrictEqual(['busy']);
        expect(outcomes([await fire(p, [{ id: 'tick', slot, insertMissing: true }])])).toStrictEqual(['enqueued']);
        await expect(readSchedules(p)).resolves.toMatchObject([{ id: 'tick', lastSlotMs: slot }]);
    });

    test('after the retention of the job: the cursor still holds the slot', async () => {
        const { p } = await freshSqlane();
        const slot = Math.floor((await dbNow()) / 1000) * 1000;

        await register(p, ['tick'], slot - HOUR_MS);
        expect(outcomes([await fire(p, [{ id: 'tick', slot }])])).toStrictEqual(['enqueued']);
        await query(`DELETE FROM ${p}jobs`);

        expect(outcomes([await fire(p, [{ id: 'tick', slot }])])).toStrictEqual(['lost']);
        await expect(readJobs(p)).resolves.toStrictEqual([]);
    });

    test('250 slots of 250 names: one insert statement per transaction of 100', async () => {
        const { p } = await freshSqlane();
        const slot = Math.floor((await dbNow()) / 1000) * 1000;
        const ids = Array.from({ length: 250 }, (_, index) => `n_${String(index).padStart(3, '0')}`);
        const { adapter: counting, counts } = countingAdapter(p);

        await register(p, ids, slot - HOUR_MS);

        const store = createStore(counting, p);
        const results = [];

        for (let start = 0; start < 250; start += 100) {
            counts.inserts = 0;
            // oxlint-disable-next-line no-await-in-loop -- one transaction at a time
            results.push(await store.fireSlots({
                candidates: ids.slice(start, start + 100).map(id => ({
                    id, name: id, spec: 'every 3600000', slot, due: slot, missed: 'once', overlap: 'allow', catchUpFrom: 0,
                })),
                buildJob: slotJob,
                notifyChannel: null,
                now: Date.now,
                graceMs: 60_000,
                futureMs: 1000,
            }));
            // MySQL and MariaDB: the INSERT of the jobs, once per chunk of 500
            expect(counts.inserts).toBe(1);
        }

        expect(results.map(result => result.decided.length)).toStrictEqual([100, 100, 50]);
        await expect(readJobs(p)).resolves.toHaveLength(250);
    });

    test.runIf(isPostgres)('PostgreSQL: one insert of 3 names sends 3 notifications', async () => {
        const { p } = await freshSqlane();
        const listener = new Client({ connectionString: inject('databaseUrl') });
        /** @type {string[]} */
        const messages = [];

        await listener.connect();

        try {
            listener.on('notification', message => messages.push(String(message.payload)));
            await listener.query(`LISTEN ${p}ready`);

            const jobs = ['alpha', 'beta', 'gamma', 'alpha'].map((name, index) => buildNewJob({
                name, definition: null, defaults, payload: {}, options: { jobId: `j${index}` }, maxPayloadBytes: 1024,
            }));

            await testAdapter.adapter.queueTransaction(executor => insertScheduledJobsPostgres(executor, p, jobs, {
                enqueueToken: 't',
                notifyChannel: `${p}ready`,
            }));
            await waitFor(() => messages.length >= 3, 3000);
            await sleep(100);

            expect(messages.toSorted()).toStrictEqual(['alpha', 'beta', 'gamma']);
        } finally {
            await listener.end();
        }
    });
});

describe('schedules end to end', () => {
    test('4 instances, every 1s: one job per slot, one event per job', async () => {
        const { p } = await freshSqlane();
        const all = Array.from({ length: 4 }, () => instanceOn(p));

        for (const { sqlane } of all) {
            sqlane.schedule('tick', { every: '1s' });
        }

        await Promise.all(all.map(({ sqlane }) => sqlane.start()));
        await sleep(5000);
        await Promise.all(all.map(({ sqlane }) => sqlane.close({ deadline: 0 })));

        const jobs = await readJobs(p);
        const fired = all.flatMap(({ events }) => events.filter(({ type }) => type === 'schedule_fired'));

        expect(jobs.length).toBeGreaterThanOrEqual(3);
        expect(new Set(jobs.map(({ id }) => id)).size).toBe(jobs.length);
        expect(fired).toHaveLength(jobs.length);
        expect(jobs.map(({ id }) => id.slice(-5))).toStrictEqual(jobs.map(({ id }) => id.slice(-5)).map(() => '.000Z'));
    }, 20_000);

    test('2 instances whose clocks are 20 s off, each way: one job per slot, at the time of the database', async () => {
        const { p } = await freshSqlane();
        const all = [-20_000, 20_000].map(offsetMs => instanceOn(p, {
            timings: { schedules: { now: () => Date.now() + offsetMs } },
        }));

        for (const { sqlane } of all) {
            sqlane.schedule('tick', { every: '1s' });
        }

        await Promise.all(all.map(({ sqlane }) => sqlane.start()));
        await sleep(4000);
        await Promise.all(all.map(({ sqlane }) => sqlane.close({ deadline: 0 })));

        const jobs = await readJobs(p);
        const created = await query(`SELECT id, ${CREATED_MS} AS created_ms FROM ${p}jobs`);

        expect(jobs.length).toBeGreaterThanOrEqual(2);
        expect(new Set(jobs.map(({ id }) => id)).size).toBe(jobs.length);

        // Each job is added within 2 s after its slot, by the database clock
        for (const row of created) {
            const slot = Date.parse(String(row.id).slice('tick:schedule:'.length));

            expect(Number(row.created_ms) - slot).toBeLessThan(2000);
            expect(Number(row.created_ms) - slot).toBeGreaterThanOrEqual(-1000);
        }
    }, 20_000);

    test('a slot missed during a restart runs once, late, due now; not beyond the reach, not with skip', async () => {
        const { p } = await freshSqlane();
        const now = await awayFromSlot();
        const latest = Math.floor(now / HOUR_MS) * HOUR_MS;
        const first = instanceOn(p);

        first.sqlane.schedule('once', { every: '1h' });
        first.sqlane.schedule('far', { every: '1h' });
        first.sqlane.schedule('skip', { every: '1h', missed: 'skip' });
        await first.sqlane.start();
        await first.sqlane.close({ deadline: 0 });
        await setCursor(p, 'once', latest - HOUR_MS);
        await setCursor(p, 'far', latest - HOUR_MS - (2 * DAY_MS));
        await setCursor(p, 'skip', latest - HOUR_MS);

        const { sqlane, events } = instanceOn(p);
        /** @type {Date[]} */
        const scheduledAt = [];

        sqlane.handle('once', ({ job }) => {
            scheduledAt.push(/** @type {Date} */ (job.scheduledAt));
        });
        sqlane.schedule('once', { every: '1h' });
        sqlane.schedule('far', { every: '1h' });
        sqlane.schedule('skip', { every: '1h', missed: 'skip' });
        await sqlane.start();
        await waitFor(() => scheduledAt.length === 1);

        expect(scheduledAt).toStrictEqual([new Date(latest)]);
        expect(events.filter(({ type }) => type === 'schedule_fired')).toMatchObject([
            { scheduleId: 'once', scheduledAt: new Date(latest), late: true, jobId: `once:schedule:${new Date(latest).toISOString()}` },
        ]);
        await expect(readJobs(p)).resolves.toMatchObject([{ id: `once:schedule:${new Date(latest).toISOString()}` }]);
    }, 120_000);

    test('a deploy that changes the spec: no late catch-up for it; an on-time slot runs and stores the new spec', async () => {
        const { p } = await freshSqlane();
        const now = await awayFromSlot();
        const latest = Math.floor(now / HOUR_MS) * HOUR_MS;
        const first = instanceOn(p);

        first.sqlane.schedule('report', { every: '1h' });
        first.sqlane.schedule('tick', { every: '1h' });
        await first.sqlane.start();
        await first.sqlane.close({ deadline: 0 });
        await setCursor(p, 'report', latest - HOUR_MS, 'every 7200000');
        await setCursor(p, 'tick', latest - HOUR_MS, 'every 5000');

        const { sqlane } = instanceOn(p);

        sqlane.schedule('report', { every: '1h' });
        sqlane.schedule('tick', { every: '1s' });
        await sqlane.start();
        await waitFor(async () => (await readJobs(p, 'tick:%')).length > 0);

        await expect(readJobs(p, 'report:%')).resolves.toStrictEqual([]);
        await expect(readSchedules(p)).resolves.toMatchObject([
            { id: 'report', spec: 'every 7200000' },
            { id: 'tick', spec: 'every 1000' },
        ]);
        await expect(sqlane.getSchedules()).resolves.toMatchObject([
            { id: 'report', spec: 'every 7200000', registered: true },
            { id: 'tick', spec: 'every 1000', registered: true },
        ]);
    }, 120_000);

    test('overlap skip: a slot adds no job while the previous one is pending; the event has no job', async () => {
        const { sqlane, p, events } = await freshSqlane();

        sqlane.schedule('slow', { every: '1s', overlap: 'skip' });
        await sqlane.start();
        await waitFor(() => events.filter(({ type }) => type === 'schedule_fired').length >= 3);

        const fired = /** @type {import('../../src/types.js').ScheduleFiredEvent[]} */ (
            events.filter(({ type }) => type === 'schedule_fired')
        );

        expect(fired[0].jobId).toMatch(/^slow:schedule:/);
        expect(fired.slice(1, 3).map(({ jobId }) => jobId)).toStrictEqual([null, null]);
        await expect(readJobs(p)).resolves.toHaveLength(1);
    });

    test('a scheduled job is an ordinary job: the payload, scheduledAt, a retry, a mutex key, a failure job', async () => {
        const job = defineJob({
            name: 'nightly',
            timeout: '10s',
            maxAttempts: 2,
            backoff: { type: 'fixed', delay: 10, jitter: 0 },
            // One run at a time: the next slot waits for the key
            mutexKeys: () => ['nightly'],
            failureJob: 'nightly_failed',
        });
        const { sqlane } = await freshSqlane();
        const runs = scheduledRuns();
        /** @type {unknown[]} */
        const failures = [];

        sqlane.handle(job, runs.handler, { maxConcurrency: 5 });
        sqlane.handle('nightly_failed', ({ payload }) => {
            failures.push(payload);
        });
        sqlane.schedule(job, { every: '1s', payload: { region: 'eu' } });
        await sqlane.start();
        await waitFor(() => failures.length > 0, 15_000);

        const [first, second] = runs.slots;

        // Through the scheduler: the payload of the schedule, the slot in the job id and in scheduledAt
        expect(runs.calls.slice(0, 4)).toStrictEqual([
            { id: `nightly:schedule:${first.toISOString()}`, payload: { region: 'eu' }, scheduledAt: first, attempt: 1 },
            { id: `nightly:schedule:${first.toISOString()}`, payload: { region: 'eu' }, scheduledAt: first, attempt: 2 },
            { id: `nightly:schedule:${second.toISOString()}`, payload: { region: 'eu' }, scheduledAt: second, attempt: 1 },
            { id: `nightly:schedule:${second.toISOString()}`, payload: { region: 'eu' }, scheduledAt: second, attempt: 2 },
        ]);
        expect(runs.maxActive).toBe(1);
        // The second slot waited for the run of the first one: it started well after its slot
        expect(runs.startedAt[2] - second.getTime()).toBeGreaterThan(300);
        expect(failures[0]).toMatchObject({ job: { id: `nightly:schedule:${second.toISOString()}`, attempt: 2 } });
    }, 20_000);

    test('the default payload is {}', async () => {
        const { sqlane } = await freshSqlane();
        /** @type {unknown[]} */
        const payloads = [];

        sqlane.handle('tick', ({ payload }) => {
            payloads.push(payload);
        });
        sqlane.schedule('tick', { every: '1s' });
        await sqlane.start();
        await waitFor(() => payloads.length > 0);

        expect(payloads[0]).toStrictEqual({});
    });

    test('two names due at once: the worker of another process starts both at once, without a poll', async () => {
        const p = nextPrefix();
        const options = wakeOptions();
        const scheduler = instanceOn(p, options);
        const worker = instanceOn(p, options);
        /** @type {Record<string, number>} */
        const startedAt = {};

        await scheduler.sqlane.migrate();

        for (const name of ['alpha', 'beta']) {
            scheduler.sqlane.schedule(name, { every: '2s' });
            worker.sqlane.handle(name, () => {
                startedAt[name] = Date.now();
            });
        }

        await worker.sqlane.start();
        await scheduler.sqlane.start();
        await waitFor(() => Object.keys(startedAt).length === 2, 5000);

        const fired = /** @type {import('../../src/types.js').ScheduleFiredEvent[]} */ (scheduler.events
            .filter(({ type }) => type === 'schedule_fired'));
        const slot = fired[0].scheduledAt.getTime();

        expect(startedAt.alpha - slot).toBeLessThan(1000);
        expect(startedAt.beta - slot).toBeLessThan(1000);
    });

    test('a slot run by hand before its time: the scheduler finds its job, and moves the cursor', async () => {
        const { sqlane, p, events } = await freshSqlane();
        const slot = (Math.floor((await dbNow()) / 2000) + 2) * 2000;

        await expect(sqlane.enqueue(testAdapter.pool, 'tick', {}, { slot: { at: new Date(slot) } }))
            .resolves.toStrictEqual({ id: `tick:schedule:${new Date(slot).toISOString()}`, created: true });
        sqlane.schedule('tick', { every: '2s' });
        await sqlane.start();
        await waitFor(() => events.some(event => /** @type {any} */ (event).scheduledAt?.getTime() === slot));

        expect(events.findLast(({ type }) => type === 'schedule_fired')).toMatchObject({
            scheduledAt: new Date(slot),
            jobId: `tick:schedule:${new Date(slot).toISOString()}`,
        });
        await expect(readSchedules(p)).resolves.toMatchObject([{ lastSlotMs: slot }]);
        await expect(sqlane.enqueue(testAdapter.pool, 'tick', {}, { slot: { at: new Date(slot) } }))
            .resolves.toMatchObject({ created: false });
        await expect(readJobs(p, `tick:schedule:${new Date(slot).toISOString()}`)).resolves.toHaveLength(1);
    });

    test('getSchedules: the rows of other services, a schedule without a row, the cursor and the last job', async () => {
        const { sqlane, p } = await freshSqlane();
        const other = instanceOn(p);

        other.sqlane.schedule('other', { every: '1h' });
        await other.sqlane.start();
        await other.sqlane.close({ deadline: 0 });
        sqlane.schedule('tick', { every: '1s', key: 'k' });

        await expect(sqlane.getSchedules()).resolves.toMatchObject([
            { id: 'other', name: 'other', spec: 'every 3600000', registered: false, nextAt: null, lastJobId: null },
            { id: 'tick:k', name: 'tick', registered: true, lastSlotAt: null, lastJobId: null },
        ]);
        await sqlane.start();
        await waitFor(async () => (await readJobs(p)).length > 0);

        const [, tick] = await sqlane.getSchedules();

        expect(tick.lastJobId).toMatch(/^tick:schedule:k:/);
        expect(tick.lastSlotAt?.getTime()).toBe(Date.parse(String(tick.lastJobId).slice('tick:schedule:k:'.length)));
        expect(Number(tick.nextAt) - Number(tick.lastSlotAt)).toBeGreaterThanOrEqual(1000);
    });

    test('without schedules: no statement on the table of the schedules', async () => {
        const { p } = await freshSqlane();
        /** @type {string[]} */
        const statements = [];
        const { queue } = testAdapter.adapter;
        const adapter = {
            ...testAdapter.adapter,
            queue: {
                ...queue,
                query: (/** @type {string} */ sql, /** @type {unknown[]} */ params) => {
                    statements.push(sql);

                    return queue.query(sql, params);
                },
            },
        };
        const { sqlane } = instanceOn(p, { adapter });

        sqlane.handle('tick', () => {});
        await sqlane.start();
        await sqlane.enqueue(testAdapter.pool, 'tick', {});
        await sleep(500);
        await sqlane.close({ deadline: 0 });

        expect(statements.length).toBeGreaterThan(0);
        expect(statements.filter(sql => sql.includes(`${p}schedules`))).toStrictEqual([]);
    });
});

describe('jitter', () => {
    test('3 instances, every 2s, jitter 1s: one job per slot, due at its offset, never ahead of the database', async () => {
        const { p } = await freshSqlane();
        const all = Array.from({ length: 3 }, () => instanceOn(p));
        const options = { every: '2s', jitter: '1s' };
        const entry = checkSchedule('tick', options);
        let maxAheadMs = -Infinity;

        for (const { sqlane } of all) {
            sqlane.schedule('tick', options);
        }

        await Promise.all(all.map(({ sqlane }) => sqlane.start()));

        for (let sample = 0; sample < 30; sample++) {
            // oxlint-disable-next-line no-await-in-loop -- samples over time
            const [jobs, now] = await Promise.all([readJobs(p), dbNow()]);

            maxAheadMs = Math.max(maxAheadMs, ...jobs.filter(({ status }) => status === 'pending').map(({ runAtMs }) => runAtMs - now));
            // oxlint-disable-next-line no-await-in-loop -- samples over time
            await sleep(200);
        }

        await Promise.all(all.map(({ sqlane }) => sqlane.close({ deadline: 0 })));

        const jobs = await readJobs(p);

        expect(jobs.length).toBeGreaterThanOrEqual(2);
        expect(new Set(jobs.map(({ id }) => id)).size).toBe(jobs.length);
        expect(jobs.map(({ id, runAtMs }) => runAtMs - dueOf(entry, Date.parse(id.slice('tick:schedule:'.length)))))
            .toStrictEqual(jobs.map(() => 0));
        expect(maxAheadMs).toBeLessThanOrEqual(1000);
    }, 20_000);

    test('a restart inside the window: the slot runs once, at its due time; nextRunAt', async () => {
        const { p } = await freshSqlane();
        // The next slot, 1.5 s away or more, and a key whose job of that slot is due 3 s or more after it
        const { slot, options } = slotWithOffset(await dbNow());
        const due = dueOf(checkSchedule('tick', options), slot);
        const jobId = `tick:schedule:${options.key}:${new Date(slot).toISOString()}`;
        const first = instanceOn(p);

        first.sqlane.schedule('tick', options);
        await first.sqlane.start();
        await sleep(slot + 200 - (await dbNow()));
        await first.sqlane.close({ deadline: 0 });

        const { sqlane, events } = instanceOn(p);

        sqlane.schedule('tick', options);
        await sleep(300);
        await sqlane.start();

        await expect(sqlane.getSchedules())
            .resolves.toMatchObject([{ nextAt: new Date(slot), nextRunAt: new Date(due) }]);
        await waitFor(() => events.some(({ type }) => type === 'schedule_fired'), 12_000);

        // The first instance may have run the slots before
        await expect(readJobs(p, jobId)).resolves.toStrictEqual([{ id: jobId, status: 'pending', runAtMs: due }]);
        expect(events.filter(({ type }) => type === 'schedule_fired')).toMatchObject([{ scheduledAt: new Date(slot) }]);
    }, 30_000);
});
