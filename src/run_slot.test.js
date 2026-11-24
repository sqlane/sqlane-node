import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createRunner } from './create_runner.js';
import { createSqlane } from './create_sqlane.js';
import { defineHandler } from './define_handler.js';
import { defineLane } from './define_lane.js';
import { defineSchedule } from './define_schedule.js';
import { InvalidOptionsError } from './errors.js';

const NOW = Date.parse('2026-06-01T12:34:56.789Z');
const report = defineLane({ name: 'report', maxAttempts: 5 });
const hourly = defineSchedule(report, { key: 'hourly', cron: '0 * * * *', payload: { kind: 'full' }, jitter: '10m' });

/**
 * A sqlane over an adapter that records the inserted jobs: each insert creates its job once. A PostgreSQL 18 server.
 * @param {{ afterCommit?: (connection: unknown, onCommit: () => void) => boolean }} [options] The after-commit hook of
 *     the adapter.
 * @returns {{ sqlane: import('./types.js').Sqlane<any>, inserts: unknown[][], published: string[] }}
 */
function recordingSqlane({ afterCommit } = {}) {
    /** @type {unknown[][]} */
    const inserts = [];
    /** @type {string[]} */
    const published = [];
    /** @type {Set<string>} */
    const ids = new Set();
    /** @type {import('./types.js').Executor} */
    const executor = {
        query: async (sql, params) => {
            if (sql === 'SELECT VERSION() AS version') {
                return [{ version: 'PostgreSQL 18.6 on x86_64' }];
            }

            if (sql === 'SELECT id FROM sqlane_migrations') {
                return [{ id: '0010_pause' }];
            }

            if (!sql.includes('INSERT')) {
                return [];
            }

            inserts.push([...params]);

            const [id] = /** @type {RegExpMatchArray} */ (/report:schedule:[^"\\]+/u.exec(JSON.stringify(params)));
            const created = !ids.has(id);

            ids.add(id);

            return created ? [{ id }] : [];
        },
        run: async () => 0,
    };
    const adapter = /** @type {import('./types.js').Adapter<any>} */ (/** @type {unknown} */ ({
        dialect: 'postgres',
        queue: executor,
        inTransaction: (/** @type {unknown} */ _connection, /** @type {(executor: unknown) => unknown} */ func) => (
            func(executor)
        ),
        queueTransaction: (/** @type {(executor: unknown) => unknown} */ func) => func(executor),
        withConnection: (/** @type {(executor: unknown) => unknown} */ func) => func(executor),
        afterCommit,
    }));
    const hint = {
        publish: async (/** @type {string} */ _channel, /** @type {string} */ message) => {
            published.push(message);
        },
        subscribe: async () => async () => {},
    };

    return { sqlane: createSqlane({ adapter, hint }), inserts, published };
}

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(() => {
    vi.useRealTimers();
});

test('the default slot: the latest slot of the spec at or before now, by the clock of this process', async () => {
    const { sqlane, published } = recordingSqlane();

    await expect(sqlane.schedules.runSlot(hourly)).resolves.toStrictEqual({
        id: 'report:schedule:hourly:2026-06-01T12:00:00.000Z',
        created: true,
    });
    // No runner here: the hint wakes the others
    expect(published).toStrictEqual(['report']);
});

test('a slot of the spec: its job with the dedupe key of the slot, the payload of the schedule, its lane options; '
    + 'a second run: created false', async () => {
    const { sqlane, inserts } = recordingSqlane();
    const at = new Date('2026-06-01T10:00:00.000Z');

    await expect(sqlane.schedules.runSlot(hourly, { at })).resolves.toStrictEqual({
        id: 'report:schedule:hourly:2026-06-01T10:00:00.000Z',
        created: true,
    });
    await expect(sqlane.schedules.runSlot(hourly, { at, connection: {} })).resolves.toMatchObject({ created: false });
    // The payload of the schedule, the maxAttempts of the definition of the lane, due now
    expect(JSON.parse(String(inserts[0][0]))).toMatchObject([{
        payload: JSON.stringify({ kind: 'full' }),
        max_attempts: 5,
        delay_ms: 0,
        run_at: null,
    }]);
});

test.each([
    ['a time that is not a slot of the spec', { at: new Date('2026-06-01T10:30:00.000Z') }, 'is not a slot of'],
    ['a slot in the future', { at: new Date('2026-06-01T13:00:00.000Z') }, 'is in the future'],
    ['an invalid Date', { at: new Date(Number.NaN) }, '"at" must be a valid Date'],
    ['a time that is not a Date', { at: '2026-06-01T10:00:00.000Z' }, '"at" must be a valid Date'],
    ['an unknown option', { at: new Date('2026-06-01T10:00:00.000Z'), key: 'x' }, 'unknown options: key'],
])('%s: an InvalidOptionsError, and no insert', async (_, options, message) => {
    const { sqlane, inserts } = recordingSqlane();
    const running = sqlane.schedules.runSlot(hourly, /** @type {any} */ (options));

    await expect(running).rejects.toThrow(InvalidOptionsError);
    await expect(sqlane.schedules.runSlot(hourly, /** @type {any} */ (options))).rejects.toThrow(message);
    expect(inserts).toStrictEqual([]);
});

test('a schedule id or a lane: an InvalidOptionsError (runSlot needs the payload of the definition)', async () => {
    const { sqlane } = recordingSqlane();

    await expect(sqlane.schedules.runSlot(/** @type {any} */ ('report:hourly'))).rejects.toThrow(InvalidOptionsError);
    await expect(sqlane.schedules.runSlot(/** @type {any} */ (report))).rejects.toThrow(
        'schedules.runSlot(): the schedule must be a schedule definition, from defineSchedule()',
    );
});

test('an interval: its slots in UTC', async () => {
    const { sqlane } = recordingSqlane();
    const every = defineSchedule(report, { key: 'quarter', every: '15m' });

    await expect(sqlane.schedules.runSlot(every)).resolves.toMatchObject({
        id: 'report:schedule:quarter:2026-06-01T12:30:00.000Z',
    });
});

test('a slot at now, by the clock of this process: not in the future', async () => {
    const { sqlane } = recordingSqlane();
    const slot = Date.parse('2026-06-01T13:00:00.000Z');

    vi.setSystemTime(slot);
    await expect(sqlane.schedules.runSlot(hourly, { at: new Date(slot) })).resolves.toStrictEqual({
        id: 'report:schedule:hourly:2026-06-01T13:00:00.000Z',
        created: true,
    });
});

test('your connection: the wake and the hint after the commit of your transaction, as for an enqueue', async () => {
    /** @type {(() => void)[]} */
    const commits = [];
    /** @type {unknown[]} */
    const hooked = [];
    const connection = { transaction: 1 };
    const { sqlane, published } = recordingSqlane({
        afterCommit: (given, onCommit) => {
            hooked.push(given);
            commits.push(onCommit);

            return true;
        },
    });

    await sqlane.schedules.runSlot(hourly, { connection });
    expect(hooked).toStrictEqual([connection]);
    expect(published).toStrictEqual([]);
    commits[0]();
    expect(published).toStrictEqual(['report']);
});

test('a started runner of this process that can run the lane: it starts the job, no hint', async () => {
    const { sqlane, published } = recordingSqlane();
    const runner = createRunner(sqlane);

    runner.mount([defineHandler(report, () => {})]);
    await runner.start();

    try {
        await sqlane.schedules.runSlot(hourly);
        expect(published).toStrictEqual([]);
    } finally {
        await runner.close({ deadline: 0 });
    }
});
