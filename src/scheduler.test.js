import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveDefaults } from './defaults.js';
import { parseCron } from './cron.js';
import { checkSchedule, dueOf } from './schedule.js';
import { createScheduler } from './scheduler.js';
import { decideSlot } from './store/fire_slots.js';

/** @typedef {import('./store/fire_slots.js').ScheduleRow} ScheduleRow */
/** @typedef {import('./store/fire_slots.js').FireParams} FireParams */
/** @typedef {import('./store/fire_slots.js').FireResult} FireResult */

const START = Date.parse('2026-06-01T12:00:00.000Z');
const SECOND_MS = 1000;
const MINUTE_MS = 60_000;

/**
 * @typedef {object} FakeDatabase
 * @property {Map<string, ScheduleRow>} rows
 * @property {Set<string>} locked The ids that another transaction holds.
 * @property {string[]} jobs The ids of the added jobs.
 * @property {Set<string>} unfinished
 * @property {FireParams[]} fires
 * @property {(string[] | null)[]} reads
 * @property {string[][]} registers
 * @property {number} rttMs The round trip of each statement, on the process clock.
 * @property {((params: FireParams) => Promise<FireResult> | FireResult) | null} failFire Replaces a fire.
 * @property {unknown} failRead Thrown by the reads.
 * @property {(params: FireParams) => FireResult} fire The fire of the fake store.
 * @property {{ job: import('./new_job.js').NewJob, firedAt: number }[]} built The jobs of the slots, when they were
 *     inserted.
 */

/**
 * A store over rows in memory, with the decision of the real store. The database clock is Date.now() (fake timers).
 * @param {() => number} now
 * @returns {{ database: FakeDatabase, store: import('./store/store.js').Store }}
 */
function fakeStore(now) {
    /** @type {FakeDatabase} */
    const database = {
        rows: new Map(),
        locked: new Set(),
        jobs: [],
        unfinished: new Set(),
        fires: [],
        reads: [],
        registers: [],
        rttMs: 0,
        failFire: null,
        failRead: null,
        fire: params => fire(params),
        built: [],
    };
    /** @returns {import('./store/fire_slots.js').ClockSample} */
    const clock = () => ({ dbNowMs: Date.now(), sentAt: now(), receivedAt: now() + database.rttMs });
    /**
     * @param {string[] | null} ids
     * @returns {import('./store/store.js').ScheduleRead}
     */
    const read = ids => ({
        clock: clock(),
        rows: [...database.rows.values()].filter(row => ids === null || ids.includes(row.id))
            .toSorted((a, b) => (a.id < b.id ? -1 : 1)),
    });

    /**
     * @param {FireParams} params
     * @returns {FireResult}
     */
    function fire(params) {
        /** @type {FireResult} */
        const result = { clock: clock(), decided: [], busy: [], deferred: [] };

        for (const candidate of params.candidates) {
            if (candidate.insertMissing && !database.rows.has(candidate.id)) {
                database.rows.set(candidate.id, {
                    id: candidate.id, jobName: candidate.name, spec: candidate.spec, lastSlotMs: 0, lastJobId: null,
                });
            }

            const row = database.rows.get(candidate.id);

            if (!row || database.locked.has(candidate.id)) {
                result.busy.push(candidate.id);
                continue;
            }

            const decision = decideSlot(candidate, row, Date.now(), params);
            const late = Date.now() - candidate.slot > params.graceMs;

            if (decision === 'deferred') {
                result.deferred.push(candidate.id);
            } else if (decision === 'lost' || decision === 'dropped') {
                result.decided.push({ ...candidate, late, outcome: decision, jobId: null, created: false });
            } else {
                const skip = candidate.overlap === 'skip' && row.lastJobId !== null && database.unfinished.has(row.lastJobId);
                const job = skip ? null : params.buildJob(candidate, decision === 'late');
                const jobId = job?.id ?? null;

                if (job) {
                    database.jobs.push(job.id);
                    database.built.push({ job, firedAt: Date.now() });
                }

                database.rows.set(row.id, {
                    ...row, spec: candidate.spec, lastSlotMs: candidate.slot, lastJobId: jobId ?? row.lastJobId,
                });
                result.decided.push({
                    id: candidate.id,
                    name: candidate.name,
                    slot: candidate.slot,
                    late: decision === 'late',
                    outcome: skip ? 'skipped' : 'enqueued',
                    jobId,
                    created: Boolean(jobId),
                });
            }
        }

        return result;
    }

    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        registerSchedules: async (/** @type {{ id: string, name: string, spec: string }[]} */ entries) => {
            database.registers.push(entries.map(({ id }) => id));

            if (database.failRead) {
                throw database.failRead;
            }

            for (const entry of entries) {
                if (!database.rows.has(entry.id)) {
                    database.rows.set(entry.id, {
                        id: entry.id, jobName: entry.name, spec: entry.spec, lastSlotMs: Date.now(), lastJobId: null,
                    });
                }
            }

            return read(entries.map(({ id }) => id));
        },
        readSchedules: async (/** @type {string[] | null} */ ids) => {
            database.reads.push(ids);

            if (database.failRead) {
                throw database.failRead;
            }

            return read(ids);
        },
        fireSlots: async (/** @type {FireParams} */ params) => {
            database.fires.push(params);

            return database.failFire ? database.failFire(params) : fire(params);
        },
    }));

    return { database, store };
}

/**
 * Fails the next fires of the fake store, then lets them through.
 * @param {FakeDatabase} database
 * @param {number} times
 * @param {(params: FireParams) => FireResult} failure Throws, or gives another result.
 */
function failNext(database, times, failure) {
    let left = times;

    database.failFire = (params) => {
        left--;

        return left >= 0 ? failure(params) : database.fire(params);
    };
}

/**
 * The database is down until a time.
 * @param {FakeDatabase} database
 * @param {number} until
 */
function failUntil(database, until) {
    database.failFire = (params) => {
        if (Date.now() < until) {
            throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
        }

        return database.fire(params);
    };
}

/**
 * The first fire is busy (another process holds the row), then the database clock is behind the process by `behindMs`
 * for the fires that follow, so they are deferred until the database reaches the slot.
 * @param {FakeDatabase} database
 * @param {number} behindMs
 */
function deferBehind(database, behindMs) {
    let fires = 0;

    database.failFire = (params) => {
        fires++;

        const dbNowMs = Date.now() - behindMs;
        const [candidate] = params.candidates;

        if (fires === 1) {
            return { clock: null, decided: [], busy: [candidate.id], deferred: [] };
        }

        if (candidate.due > dbNowMs + params.futureMs) {
            const clock = { dbNowMs, sentAt: Date.now(), receivedAt: Date.now() + 100 };

            return { clock, decided: [], busy: [], deferred: [candidate.id] };
        }

        return database.fire(params);
    };
}

/**
 * Fails each fire of the fake store with a schedule, decides the others.
 * @param {FakeDatabase} database
 * @param {string} id
 * @returns {{ calls: number }}
 */
function failWith(database, id) {
    const counter = { calls: 0 };

    database.failFire = (params) => {
        counter.calls++;

        if (params.candidates.some(candidate => candidate.id === id)) {
            throw new Error('a constraint');
        }

        return database.fire(params);
    };

    return counter;
}

/**
 * @typedef {object} TestContext
 * @property {import('./scheduler.js').Scheduler} scheduler
 * @property {FakeDatabase} database
 * @property {import('./types.js').SqlaneEvent[]} events
 * @property {string[]} created The names of onCreated().
 * @property {{ debug: import('vitest').Mock, info: import('vitest').Mock, warn: import('vitest').Mock,
 *     error: import('vitest').Mock }} logger
 * @property {() => Promise<void>} start Registers and starts, as createSqlane.start() does.
 * @property {import('./schedule.js').ScheduleEntry[]} entries
 */

/**
 * @param {{ schedules: [string, object][], localOffsetMs?: number, offset?: { ms: number }, timings?: object }} options
 *     `offset`: an offset of the process clock that the test changes.
 * @returns {TestContext}
 */
function setup({ schedules, localOffsetMs = 0, offset = { ms: localOffsetMs }, timings = {} }) {
    const now = () => Date.now() + offset.ms;
    const { database, store } = fakeStore(now);
    /** @type {import('./types.js').SqlaneEvent[]} */
    const events = [];
    /** @type {string[]} */
    const created = [];
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = createScheduler({
        store,
        defaults: resolveDefaults(),
        maxPayloadBytes: 1024,
        findDefinition: () => null,
        unknownJobs: 'allow',
        notifyChannel: null,
        onCreated: name => created.push(name),
        emit: event => events.push(event),
        logger,
        // The fake timers move Date.now() only: as the monotonic clock too, so setSystemTime() is a stall, not a step
        timings: { now, monotonic: () => Date.now(), ...timings },
    });

    const entries = schedules.map(([name, options]) => checkSchedule(name, options));

    for (const entry of entries) {
        scheduler.add(entry);
    }

    scheduler.prepare();

    /** Registers and starts, as createSqlane.start() does */
    const start = async () => {
        scheduler.start(await scheduler.register());
        await vi.advanceTimersByTimeAsync(0);
    };

    return { scheduler, database, events, created, logger, start, entries };
}

/**
 * @param {FakeDatabase} database
 * @returns {string[][]} The schedule ids and slots of each fire.
 */
function firedSlots(database) {
    return database.fires.map(({ candidates }) => candidates.map(({ id, slot }) => `${id}@${new Date(slot).toISOString()}`));
}

/** @type {(() => Promise<void>)[]} */
let stops = [];

beforeEach(() => {
    vi.useFakeTimers({ now: START });
});

afterEach(async () => {
    await Promise.all(stops.map(stop => stop()));
    stops = [];
    vi.useRealTimers();
});

/**
 * @param {Parameters<typeof setup>[0]} options
 * @returns {ReturnType<typeof setup>}
 */
function started(options) {
    const context = setup(options);

    stops.push(context.scheduler.stop);

    return context;
}

describe('start', () => {
    test('with no schedules: no statement, no timer', async () => {
        const { scheduler, database } = started({ schedules: [] });

        scheduler.start(null);
        await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

        expect(vi.getTimerCount()).toBe(0);
        expect([database.registers, database.reads, database.fires]).toStrictEqual([[], [], []]);
    });

    test('a new row: no slot before the registration runs', async () => {
        const { database, start } = started({ schedules: [['tick', { every: '1m' }]] });

        await start();

        expect(database.registers).toStrictEqual([['tick']]);
        expect(database.fires).toStrictEqual([]);
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(firedSlots(database)).toStrictEqual([['tick@2026-06-01T12:01:00.000Z']]);
    });

    test('a slot missed during a restart: on time, late with once and the same spec, none otherwise', async () => {
        const { database, start } = started({
            schedules: [
                ['on_time', { every: '1m' }],
                ['late_once', { every: '1h' }],
                ['late_skip', { every: '1h', missed: 'skip' }],
                ['late_other_spec', { every: '1h' }],
                ['done', { every: '1m' }],
            ],
        });
        const row = (/** @type {string} */ id, /** @type {number} */ lastSlotMs, spec = 'every 3600000') => {
            database.rows.set(id, { id, jobName: id, spec, lastSlotMs, lastJobId: null });
        };

        // 12:00:30: the slot 12:00 of `on_time` is 30 s old, the slot 12:00 of the others too
        vi.setSystemTime(START + (30 * SECOND_MS));
        row('on_time', START - MINUTE_MS, 'every 60000');
        row('done', START + (2 * MINUTE_MS), 'every 60000');
        vi.setSystemTime(START + (2 * MINUTE_MS));
        row('late_once', START - 3_600_000);
        row('late_skip', START - 3_600_000);
        row('late_other_spec', START - 3_600_000, 'every 60');
        await start();

        expect(firedSlots(database)).toStrictEqual([[
            'late_once@2026-06-01T12:00:00.000Z',
            'on_time@2026-06-01T12:02:00.000Z',
        ]]);
        expect(database.jobs).toStrictEqual([
            'late_once:schedule:2026-06-01T12:00:00.000Z',
            'on_time:schedule:2026-06-01T12:02:00.000Z',
        ]);
    });
});

describe('tick', () => {
    test('the schedules due at the same instant go in one fire; nextAt advances', async () => {
        const { database, scheduler, start, events, created } = started({
            schedules: [['a', { every: '1m' }], ['b', { cron: '* * * * *' }], ['c', { every: '1h' }]],
        });

        await start();
        await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

        expect(firedSlots(database)).toStrictEqual([
            ['a@2026-06-01T12:01:00.000Z', 'b@2026-06-01T12:01:00.000Z'],
            ['a@2026-06-01T12:02:00.000Z', 'b@2026-06-01T12:02:00.000Z'],
        ]);
        expect(events.filter(({ type }) => type === 'schedule_fired')).toHaveLength(4);
        expect(events[0]).toStrictEqual({
            type: 'schedule_fired',
            scheduleId: 'a',
            jobName: 'a',
            scheduledAt: new Date('2026-06-01T12:01:00.000Z'),
            late: false,
            jobId: 'a:schedule:2026-06-01T12:01:00.000Z',
        });
        expect(created).toStrictEqual(['a', 'b', 'a', 'b']);
        await expect(scheduler.list()).resolves.toMatchObject([
            { id: 'a', nextAt: new Date('2026-06-01T12:03:00.000Z'), lastSlotAt: new Date('2026-06-01T12:02:00.000Z') },
            { id: 'b', nextAt: new Date('2026-06-01T12:03:00.000Z') },
            { id: 'c', nextAt: new Date('2026-06-01T13:00:00.000Z'), lastJobId: null },
        ]);
    });

    test('on-time jobs are due at their slot, late ones now', async () => {
        const { database, start } = started({ schedules: [['tick', { every: '1m' }]] });

        await start();

        const fireParams = /** @type {FireParams[]} */ ([]);

        database.failFire = (params) => {
            fireParams.push(params);

            return { clock: null, decided: [], busy: [], deferred: [] };
        };
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        const [candidate] = fireParams[0].candidates;

        expect(fireParams[0].buildJob(candidate, false)).toMatchObject({
            id: 'tick:schedule:2026-06-01T12:01:00.000Z',
            runAt: new Date('2026-06-01T12:01:00.000Z'),
            payloadJson: '{}',
        });
        expect(fireParams[0].buildJob(candidate, true)).toMatchObject({ runAt: null, delayMs: 0 });
    });

    test('a stall of 30 s on every 1s fires the latest slot, once', async () => {
        const { database, start } = started({ schedules: [['tick', { every: '1s' }]] });

        await start();
        // The event loop blocks: the clock moves, no timer runs
        vi.setSystemTime(Date.now() + (29 * SECOND_MS));
        await vi.advanceTimersByTimeAsync(SECOND_MS);

        expect(firedSlots(database)).toStrictEqual([['tick@2026-06-01T12:00:30.000Z']]);
    });

    test.each([
        ['once', ['tick@2026-06-01T15:00:00.000Z']],
        ['skip', []],
    ])('a stall past the grace, missed %s', async (missed, expected) => {
        const { database, start } = started({ schedules: [['tick', { every: '1h', missed }]] });

        await start();
        // The timer sleeps 1 minute at most
        vi.setSystemTime(Date.now() + (3.5 * 3_600_000) - MINUTE_MS);
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(firedSlots(database).flat()).toStrictEqual(expected);
    });

    test('a deferred slot keeps its next slot, and fires when the database reaches it', async () => {
        const { database, start } = started({ schedules: [['tick', { every: '1m' }]] });
        await start();
        // The database clock is behind the slot, once
        failNext(database, 1, params => ({
            clock: null, decided: [], busy: [], deferred: params.candidates.map(({ id }) => id),
        }));
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(firedSlots(database)).toStrictEqual([['tick@2026-06-01T12:01:00.000Z']]);
        expect(database.jobs).toStrictEqual([]);
        await vi.advanceTimersByTimeAsync(100);
        expect(firedSlots(database).flat()).toStrictEqual(['tick@2026-06-01T12:01:00.000Z', 'tick@2026-06-01T12:01:00.000Z']);
        expect(database.jobs).toStrictEqual(['tick:schedule:2026-06-01T12:01:00.000Z']);
    });

    test('overlap skip: the event has no job', async () => {
        const { database, start, events, created } = started({ schedules: [['tick', { every: '1m', overlap: 'skip' }]] });

        await start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        database.unfinished.add('tick:schedule:2026-06-01T12:01:00.000Z');
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        /** @type {import('./types.js').ScheduleFiredEvent[]} */
        const fired = /** @type {any[]} */ (events);

        expect(fired.map(event => event.jobId)).toStrictEqual([
            'tick:schedule:2026-06-01T12:01:00.000Z',
            null,
        ]);
        expect(created).toStrictEqual(['tick']);
    });

    test('a slot 30 days away, beyond the limit of setTimeout, fires', async () => {
        const { database, start } = started({ schedules: [['monthly', { cron: '0 0 1 * *' }]] });

        await start();
        await vi.advanceTimersByTimeAsync(30 * 24 * 60 * MINUTE_MS);

        expect(firedSlots(database)).toStrictEqual([['monthly@2026-07-01T00:00:00.000Z']]);
    });

    test('a schedule with no slot within the horizon is left out of the timer', async () => {
        const { database, scheduler, start, entries } = started({ schedules: [['never', { cron: '0 0 1 1 *' }]] });

        // As if the cron had no slot within the horizon
        Object.assign(entries[0].timing, { cron: parseCron('0 0 30 2 *') });
        await start();
        await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

        expect(database.fires).toStrictEqual([]);
        await expect(scheduler.list()).resolves.toMatchObject([{ id: 'never', nextAt: null }]);
    });
});

describe('the clock of the database', () => {
    test.each([
        ['30 s behind', -30_000],
        ['30 s ahead', 30_000],
        ['1 h ahead', 3_600_000],
    ])('a process clock %s fires at the slot of the database', async (_, localOffsetMs) => {
        const { database, start, logger } = started({ schedules: [['tick', { every: '1m' }]], localOffsetMs });

        await start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS - 1);
        expect(database.fires).toStrictEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(firedSlots(database)).toStrictEqual([['tick@2026-06-01T12:01:00.000Z']]);
        expect(database.jobs).toStrictEqual(['tick:schedule:2026-06-01T12:01:00.000Z']);
        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            { skewMs: -localOffsetMs },
            'sqlane: the clock of this process differs from the database clock',
        );
    });

    test('a sample with a round trip over 50 ms does not move a known skew, and gives no warning', async () => {
        const { database, start, logger } = started({ schedules: [['tick', { every: '1m' }]], localOffsetMs: -3000 });

        await start();
        // Then each statement waits 2 s for a lock
        database.rttMs = 2000;
        // 9 minutes: the good sample of the start stays in its window of 10 minutes
        await vi.advanceTimersByTimeAsync((9 * MINUTE_MS) + 100);

        expect(database.fires.map(({ candidates }) => candidates[0].slot - Date.parse('2026-06-01T12:00:00Z')))
            .toStrictEqual(Array.from({ length: 9 }, (_, index) => (index + 1) * MINUTE_MS));
        expect(database.jobs).toHaveLength(9);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('the registration seeds the skew, even with a slow round trip: a deferred slot at start still fires', async () => {
        const { database, start, logger } = started({ schedules: [['tick', { every: '1m' }]], localOffsetMs: 5000 });

        database.rows.set('tick', { id: 'tick', jobName: 'tick', spec: 'every 60000', lastSlotMs: START - MINUTE_MS, lastJobId: null });
        database.rttMs = 60;
        vi.setSystemTime(START + (59.5 * SECOND_MS));
        await start();
        await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

        expect(database.jobs.slice(0, 2)).toStrictEqual([
            'tick:schedule:2026-06-01T12:00:00.000Z',
            'tick:schedule:2026-06-01T12:01:00.000Z',
        ]);
        expect(logger.warn).not.toHaveBeenCalled();
    });
});

describe('busy rows', () => {
    test('a busy row is read again after 1 s: the holder took the slot', async () => {
        const { database, start, events } = started({ schedules: [['tick', { every: '1m' }]] });

        await start();
        database.locked.add('tick');
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        // The holder moves the cursor, and commits
        const row = /** @type {ScheduleRow} */ (database.rows.get('tick'));

        database.rows.set('tick', { ...row, lastSlotMs: START + MINUTE_MS });
        database.locked.delete('tick');
        await vi.advanceTimersByTimeAsync(SECOND_MS);

        expect(database.reads).toStrictEqual([['tick']]);
        expect(database.fires).toHaveLength(1);
        expect(events).toStrictEqual([]);
    });

    test('the holder rolled back: the recheck fires the slot again', async () => {
        const { database, start } = started({ schedules: [['tick', { every: '1m' }]] });

        await start();
        database.locked.add('tick');
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        database.locked.delete('tick');
        await vi.advanceTimersByTimeAsync(SECOND_MS);

        expect(firedSlots(database)).toStrictEqual([
            ['tick@2026-06-01T12:01:00.000Z'],
            ['tick@2026-06-01T12:01:00.000Z'],
        ]);
        expect(database.jobs).toStrictEqual(['tick:schedule:2026-06-01T12:01:00.000Z']);
    });

    test('a missing row: on time, fired with insertMissing', async () => {
        const { database, start } = started({ schedules: [['tick', { every: '1m' }]] });

        await start();
        database.rows.delete('tick');
        await vi.advanceTimersByTimeAsync(MINUTE_MS + SECOND_MS);

        expect(database.fires.map(({ candidates }) => candidates[0].insertMissing)).toStrictEqual([undefined, true]);
        expect(database.jobs).toStrictEqual(['tick:schedule:2026-06-01T12:01:00.000Z']);
    });

    test('a row that stays busy: the rechecks back off, up to 60 s, and warn once past the grace', async () => {
        const { database, start, logger } = started({ schedules: [['daily', { cron: '0 0 * * *' }]] });
        const firedAt = /** @type {number[]} */ ([]);

        vi.setSystemTime(Date.parse('2026-06-01T23:59:00Z'));
        await start();
        database.failFire = (params) => {
            firedAt.push(Date.now());

            return { clock: null, decided: [], busy: params.candidates.map(({ id }) => id), deferred: [] };
        };
        await vi.advanceTimersByTimeAsync(11 * MINUTE_MS);

        const gaps = firedAt.slice(1).map((at, index) => (at - firedAt[index]) / SECOND_MS);

        expect(new Date(firedAt[0]).toISOString()).toBe('2026-06-02T00:00:00.000Z');
        expect(gaps.slice(0, 8)).toStrictEqual([1, 2, 4, 8, 16, 32, 60, 60]);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ scheduleId: 'daily' }),
            'sqlane: the row of a schedule stays locked by another transaction',
        );
    });
});

describe('errors', () => {
    const transient = Object.assign(new Error('deadlock'), { code: '40P01' });
    const connection = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    test('a transient error retries the chunk once, at once', async () => {
        const { database, start } = started({ schedules: [['tick', { every: '1m' }]] });

        await start();

        failNext(database, 1, () => {
            throw transient;
        });
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(database.fires).toHaveLength(2);
        expect(database.jobs).toStrictEqual(['tick:schedule:2026-06-01T12:01:00.000Z']);
    });

    test('a connection error with 500 due slots: one fire per backoff step, one error, then recovery', async () => {
        const schedules = /** @type {[string, object][]} */ (
            Array.from({ length: 500 }, (_, index) => [`job_${String(index).padStart(3, '0')}`, { every: '1m' }])
        );
        const { database, start, logger, events, scheduler } = started({ schedules });

        await start();
        database.failFire = () => {
            throw connection;
        };
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(database.fires).toHaveLength(1);
        expect(database.fires[0].candidates).toHaveLength(100);

        // The backoff
        for (const [index, seconds] of [5, 10, 20, 40, 60, 60].entries()) {
            // oxlint-disable-next-line no-await-in-loop -- one step after the other
            await vi.advanceTimersByTimeAsync((seconds * SECOND_MS) - 1);
            expect(database.fires).toHaveLength(index + 1);
            // oxlint-disable-next-line no-await-in-loop -- one step after the other
            await vi.advanceTimersByTimeAsync(1);
            expect(database.fires).toHaveLength(index + 2);
        }

        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(events.filter(({ type }) => type === 'error')).toHaveLength(1);
        expect(logger.debug).toHaveBeenCalledTimes(6);

        database.failFire = null;
        await vi.advanceTimersByTimeAsync(60 * SECOND_MS);

        expect(database.jobs).toHaveLength(500);
        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith({ late: 0 }, 'sqlane: schedules enqueue their slots again');

        // close() during an outage: resolves after the fire in flight, and none comes after it
        database.failFire = () => {
            throw connection;
        };
        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

        const fires = database.fires.length;

        await scheduler.stop();
        await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
        expect(database.fires).toHaveLength(fires);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('another error of one schedule in a chunk of 100: the bisect finds it, the 99 others are enqueued', async () => {
        const schedules = /** @type {[string, object][]} */ (
            Array.from({ length: 100 }, (_, index) => [`job_${String(index).padStart(3, '0')}`, { every: '1m' }])
        );
        const { database, start, logger } = started({ schedules });

        await start();

        const counter = failWith(database, 'job_042');

        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(counter.calls).toBeLessThanOrEqual(15);
        // One error for the bad schedule, not a second one for the outage
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(database.jobs).toHaveLength(99);
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ scheduleId: 'job_042' }),
            'sqlane: a schedule could not enqueue its slot',
        );
    });
});

describe('stop', () => {
    test('waits for the fire in flight; no fire comes after it', async () => {
        const { database, start, scheduler } = started({ schedules: [['tick', { every: '1m' }]] });

        await start();

        const { promise, resolve: release } = /** @type {PromiseWithResolvers<FireResult>} */ (Promise.withResolvers());

        database.failFire = () => promise;
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        let stopped = false;
        const stopping = (async () => {
            await scheduler.stop();
            stopped = true;
        })();

        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        release({ clock: null, decided: [], busy: [], deferred: [] });
        await stopping;
        await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

        expect(database.fires).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('a stop before start(): no timer, no fire', async () => {
        const { database, scheduler } = started({ schedules: [['tick', { every: '1m' }]] });
        const read = await scheduler.register();

        await scheduler.stop();
        scheduler.start(read);
        await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

        expect(database.fires).toStrictEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('a failed registration retries in the background', async () => {
        const { database, scheduler } = started({ schedules: [['tick', { every: '1m' }]] });

        database.failRead = Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
        scheduler.start(null);
        await vi.advanceTimersByTimeAsync(15 * SECOND_MS);
        expect(database.registers).toHaveLength(2);
        database.failRead = null;
        await vi.advanceTimersByTimeAsync(20 * SECOND_MS);
        expect(database.registers).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(database.jobs).toHaveLength(1);
    });
});

describe('add and list', () => {
    test('a second schedule with the same id throws', () => {
        const { scheduler } = setup({ schedules: [['tick', { every: '1m' }]] });

        expect(() => scheduler.add(checkSchedule('tick', { every: '1h' }))).toThrow(/exists already/);
        expect(() => scheduler.add(checkSchedule('tick', { every: '1h', key: 'k' }))).not.toThrow();
    });

    test('lists the rows of other services, and the registered schedules without a row', async () => {
        const { scheduler, database } = setup({ schedules: [['tick', { every: '1m' }]] });

        database.rows.set('gone', { id: 'gone', jobName: 'gone', spec: 'every 1000', lastSlotMs: 5, lastJobId: 'gone:x' });

        await expect(scheduler.list()).resolves.toStrictEqual([
            {
                id: 'gone',
                name: 'gone',
                spec: 'every 1000',
                registered: false,
                nextAt: null,
                nextRunAt: null,
                lastSlotAt: new Date(5),
                lastJobId: 'gone:x',
            },
            {
                id: 'tick',
                name: 'tick',
                spec: 'every 60000',
                registered: true,
                nextAt: new Date('2026-06-01T12:01:00.000Z'),
                nextRunAt: new Date('2026-06-01T12:01:00.000Z'),
                lastSlotAt: null,
                lastJobId: null,
            },
        ]);
    });

    test('a missing table is an empty one', async () => {
        const { scheduler, database } = setup({ schedules: [] });

        database.failRead = Object.assign(new Error('no table'), { code: '42P01' });

        await expect(scheduler.list()).resolves.toStrictEqual([]);
    });
});

/**
 * @param {string} id
 * @param {object} options
 * @param {string} slot
 * @returns {number} The due time of the slot.
 */
function dueTime(id, options, slot) {
    return dueOf(checkSchedule(id, options), Date.parse(slot));
}

describe('jitter', () => {
    // job_0, every 1h, jitter 59m: the slot 10:00 is due at 10:46:03
    const hourly = { every: '1h', jitter: '59m' };

    test.each(['once', 'skip'])('a restart inside the window, missed %s: the slot fires at its due time, on time', async (missed) => {
        const options = { ...hourly, missed };
        const { database, start, scheduler } = started({ schedules: [['job_0', options]] });
        const due = dueTime('job_0', options, '2026-06-01T10:00:00Z');

        database.rows.set('job_0', {
            id: 'job_0', jobName: 'job_0', spec: 'every 3600000', lastSlotMs: Date.parse('2026-06-01T09:00:00Z'), lastJobId: null,
        });
        vi.setSystemTime(Date.parse('2026-06-01T10:20:00Z'));
        await start();

        expect(database.fires).toStrictEqual([]);
        await expect(scheduler.list()).resolves.toMatchObject([{
            nextAt: new Date('2026-06-01T10:00:00Z'),
            nextRunAt: new Date(due),
        }]);
        await vi.advanceTimersByTimeAsync(due - Date.now());

        expect(database.built).toStrictEqual([{
            job: expect.objectContaining({ id: 'job_0:schedule:2026-06-01T10:00:00.000Z', runAt: new Date(due) }),
            firedAt: due,
        }]);
    });

    test('a fire that retries past the next slot: the next slot still fires at its due time', async () => {
        const { database, start } = started({ schedules: [['job_0', hourly]] });
        const due11 = dueTime('job_0', hourly, '2026-06-01T11:00:00Z');

        vi.setSystemTime(Date.parse('2026-06-01T09:59:00Z'));
        await start();
        failUntil(database, Date.parse('2026-06-01T11:00:30Z'));
        await vi.advanceTimersByTimeAsync(2 * 3_600_000);

        expect(database.built.map(({ job, firedAt }) => [job.id, job.delayMs, firedAt === due11])).toStrictEqual([
            ['job_0:schedule:2026-06-01T10:00:00.000Z', dueTime('job_0', hourly, '2026-06-01T10:00:00Z') - Date.parse('2026-06-01T10:00:00Z'), false],
            ['job_0:schedule:2026-06-01T11:00:00.000Z', 0, true],
        ]);
    });

    test('a gap below the jitter: 0,5 * * * * with jitter 10m fires every slot, in order, at its due time', async () => {
        const options = { cron: '0,5 * * * *', jitter: '10m' };
        const { database, start } = started({ schedules: [['report', options]] });

        await start();
        await vi.advanceTimersByTimeAsync(12 * 3_600_000);

        // 12:05, then :00 and :05 of 13:00 to 23:00
        const slots = ['2026-06-01T12:05:00.000Z', ...Array.from({ length: 22 }, (_, index) => new Date(
            START + ((Math.floor(index / 2) + 1) * 3_600_000) + ((index % 2) * 300_000),
        ).toISOString())];

        expect(database.built.map(({ job, firedAt }) => [job.id, firedAt])).toStrictEqual(
            slots.map(slot => [`report:schedule:${slot}`, dueTime('report', options, slot)]),
        );
    });

    test('a late catch-up keeps its offset as a delay', async () => {
        const { database, start } = started({ schedules: [['job_0', hourly]] });

        database.rows.set('job_0', {
            id: 'job_0', jobName: 'job_0', spec: 'every 3600000', lastSlotMs: Date.parse('2026-06-01T08:00:00Z'), lastJobId: null,
        });
        vi.setSystemTime(Date.parse('2026-06-01T10:50:00Z'));
        await start();

        expect(database.built.map(({ job }) => [job.id, job.delayMs, job.runAt])).toStrictEqual([[
            'job_0:schedule:2026-06-01T10:00:00.000Z',
            dueTime('job_0', hourly, '2026-06-01T10:00:00Z') - Date.parse('2026-06-01T10:00:00Z'),
            null,
        ]]);
    });

    test('a deferred slot at start stays tracked', async () => {
        const { database, start } = started({ schedules: [['job_0', hourly]] });
        const due = dueTime('job_0', hourly, '2026-06-01T10:00:00Z');

        database.rows.set('job_0', {
            id: 'job_0', jobName: 'job_0', spec: 'every 3600000', lastSlotMs: Date.parse('2026-06-01T09:00:00Z'), lastJobId: null,
        });
        vi.setSystemTime(due + 500);
        failNext(database, 1, params => ({
            clock: null, decided: [], busy: [], deferred: params.candidates.map(({ id }) => id),
        }));
        await start();
        await vi.advanceTimersByTimeAsync(SECOND_MS);

        expect(database.jobs).toStrictEqual(['job_0:schedule:2026-06-01T10:00:00.000Z']);
    });

    test('without jitter: no due time is computed', async () => {
        const { start, entries } = started({ schedules: [['tick', { cron: '* * * * *' }], ['every', { every: '1m' }]] });

        await start();
        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

        expect(entries.map(entry => entry.dueCache)).toStrictEqual([null, null]);
    });
});

describe('review fixes', () => {
    test('a busy slot whose recheck comes back deferred waits: no read and fire in a loop', async () => {
        const { database, start } = started({ schedules: [['tick', { every: '1m' }]] });

        await start();
        deferBehind(database, 3000);
        await vi.advanceTimersByTimeAsync(MINUTE_MS + (5 * SECOND_MS));

        // The busy fire, the recheck read and its deferred fire, the fire at the slot of the database
        expect(database.fires.length).toBeLessThanOrEqual(4);
        expect(database.reads.length).toBeLessThanOrEqual(2);
        expect(database.jobs).toStrictEqual(['tick:schedule:2026-06-01T12:01:00.000Z']);
    });

    test('a step of the process clock moves the skew: the next slot fires on time', async () => {
        const offset = { ms: 0 };
        const { database, start } = started({ schedules: [['tick', { every: '1m', missed: 'skip' }]], offset });

        await start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        // NTP steps the process clock back 2 minutes; later statements have a slower round trip than the old samples
        offset.ms = -2 * MINUTE_MS;
        database.rttMs = 10;
        await vi.advanceTimersByTimeAsync((2 * MINUTE_MS) + SECOND_MS);

        // Each within a round trip of its slot
        const lateness = database.built.map(({ job, firedAt }) => firedAt - Date.parse(job.id.slice(-24)));

        expect(database.built.map(({ job }) => job.id)).toStrictEqual([
            'tick:schedule:2026-06-01T12:01:00.000Z',
            'tick:schedule:2026-06-01T12:02:00.000Z',
            'tick:schedule:2026-06-01T12:03:00.000Z',
        ]);
        expect(Math.max(...lateness)).toBeLessThan(100);
    });

    test('a failure after fires that were only busy logs an error again', async () => {
        const { database, start, logger } = started({ schedules: [['tick', { every: '1m' }]] });

        await start();
        failNext(database, 1, () => {
            throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
        });
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        // The next fires succeed, but another process takes the slots
        database.locked.add('tick');
        await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
        database.locked.delete('tick');
        failNext(database, 1, () => {
            throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
        });
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(logger.error).toHaveBeenCalledTimes(2);
    });

    test('getSchedules() before start(), with jitter: a slot that has come and is not due yet', async () => {
        const { scheduler } = setup({ schedules: [['job_0', { every: '1h', jitter: '59m' }]] });
        const due = dueTime('job_0', { every: '1h', jitter: '59m' }, '2026-06-01T10:00:00Z');

        vi.setSystemTime(Date.parse('2026-06-01T10:20:00Z'));

        await expect(scheduler.list()).resolves.toMatchObject([{
            nextAt: new Date('2026-06-01T10:00:00Z'),
            nextRunAt: new Date(due),
        }]);
    });
});

describe('review 2 fixes', () => {
    test('a suspend (the monotonic clock stops, the wall clock goes on): the first slot after it fires on time', async () => {
        const suspended = { ms: 0 };
        const { database, start } = started({
            schedules: [['tick', { every: '1m', missed: 'skip' }]],
            timings: { monotonic: () => Date.now() - suspended.ms },
        });

        await start();
        // The host sleeps 10 min 50 s: no timer runs, the monotonic clock stands still
        vi.setSystemTime(Date.now() + (10 * MINUTE_MS) + (50 * SECOND_MS));
        suspended.ms += (10 * MINUTE_MS) + (50 * SECOND_MS);
        // The timer runs late, after the resume; then the next slot
        await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

        expect(database.built.map(({ job }) => job.id).slice(0, 2)).toStrictEqual([
            'tick:schedule:2026-06-01T12:11:00.000Z',
            'tick:schedule:2026-06-01T12:12:00.000Z',
        ]);
    });

    test('a schedule that keeps failing logs one error and one event, and no recovery, until it succeeds', async () => {
        const schedules = /** @type {[string, object][]} */ ([['bad', { every: '1m' }], ['good', { every: '1m' }]]);
        const { database, start, logger, events } = started({ schedules });

        await start();
        failWith(database, 'bad');
        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(events.filter(({ type }) => type === 'error')).toHaveLength(1);
        expect(logger.info).not.toHaveBeenCalled();
        expect(database.jobs.filter(id => id.startsWith('good:'))).toHaveLength(5);

        // It succeeds, then fails again: a new error
        database.failFire = null;
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        failWith(database, 'bad');
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(logger.error).toHaveBeenCalledTimes(2);
    });
});

test('a forward step of the process clock keeps every slot of a short period', async () => {
    // The process clock is 10 s behind the database, with good samples; then NTP steps it forward
    const offset = { ms: -10_000 };
    const { database, start } = started({ schedules: [['tick', { every: '2s', missed: 'skip' }]], offset });

    await start();
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS);
    offset.ms = 0;
    await vi.advanceTimersByTimeAsync(20 * SECOND_MS);

    const slots = database.jobs.map(id => Date.parse(id.slice(-24)));
    const gaps = slots.slice(1).map((slot, index) => slot - slots[index]);

    expect(slots.length).toBeGreaterThanOrEqual(11);
    expect(gaps.filter(gap => gap !== 2 * SECOND_MS)).toStrictEqual([]);
});
