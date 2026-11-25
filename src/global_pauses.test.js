import { describe, expect, test, vi } from 'vitest';
import { createSqlane } from './create_sqlane.js';
import { defineLane } from './define_lane.js';
import { defineSchedule } from './define_schedule.js';
import { ConfigError, InvalidOptionsError } from './errors.js';
import { createGlobalPauses, PLACEHOLDER_SPEC, scheduleOf } from './global_pauses.js';

const report = defineLane({ name: 'report' });
const daily = defineSchedule(report, { key: 'daily:eu', cron: '0 6 * * *', timezone: 'Europe/Berlin' });

/**
 * A store in memory: the calls of its pause methods, and the stats and the paused lanes that it reads.
 * @param {object} [state]
 * @param {import('./store/store.js').LaneCounts[]} [state.stats]
 * @param {string[]} [state.paused]
 * @param {string[]} [state.blockedKeys]
 * @param {boolean} [state.wasPaused] What resumeLane gives. Default: true.
 * @returns {{ store: any, calls: unknown[][] }}
 */
function fakeStore({ stats = [], paused = [], blockedKeys = [], wasPaused = true } = {}) {
    /** @type {unknown[][]} */
    const calls = [];
    /**
     * @param {string} name
     * @param {unknown} result
     * @returns {(...args: unknown[]) => Promise<unknown>}
     */
    const record = (name, result) => async (...args) => {
        calls.push([name, ...args]);

        return result;
    };

    return {
        calls,
        store: {
            pauseLane: record('pauseLane', undefined),
            resumeLane: record('resumeLane', wasPaused),
            forgetPausedLanes: () => {
                calls.push(['forgetPausedLanes']);
            },
            readPausedLanes: async () => paused,
            blockedKeysOfLane: record('blockedKeysOfLane', blockedKeys),
            unblockRates: record('unblockRates', { lanes: [], waits: [] }),
            getStats: async () => stats,
            pauseSchedule: record('pauseSchedule', undefined),
            resumeSchedule: record('resumeSchedule', true),
            removeSchedule: record('removeSchedule', true),
        },
    };
}

/**
 * @param {Partial<import('./global_pauses.js').GlobalPausesParams>} [params]
 * @returns {ReturnType<typeof createGlobalPauses> & { calls: unknown[][], published: string[], unblocked: string[][] }}
 */
function pausesOf(params = {}) {
    const { store, calls } = fakeStore();
    /** @type {string[]} */
    const published = [];
    /** @type {string[][]} */
    const unblocked = [];
    const pauses = createGlobalPauses({
        store,
        adapter: /** @type {any} */ ({ dialect: 'postgres' }),
        attached: () => null,
        hintChannel: /** @type {any} */ ({ publish: (/** @type {string} */ lane) => published.push(lane) }),
        unblockKeys: async (keys) => {
            unblocked.push(keys);
        },
        reportError: () => {},
        isClosed: () => false,
        ...params,
    });

    return { ...pauses, calls, published, unblocked };
}

/**
 * @param {string} lane
 * @returns {import('./store/store.js').LaneCounts}
 */
function statsOf(lane) {
    return {
        name: lane, pending: 1, blocked: 0, due: 1, running: 0, stuck: 0, failed: 0, completed: 0, oldestDueAgeMs: 5,
    };
}

describe('the lane of a pause', () => {
    test('a definition or a name', async () => {
        const { lanes, calls } = pausesOf();

        await lanes.pauseGlobally(report);
        await lanes.pauseGlobally('other_lane');
        expect(calls).toStrictEqual([['pauseLane', 'report', undefined], ['pauseLane', 'other_lane', undefined]]);
    });

    test.each([
        ['a number', 3],
        ['a name with an uppercase letter', 'Report'],
        ['a name with a colon', 'report:daily'],
        ['an empty name', ''],
    ])('%s: an InvalidOptionsError, and no statement', async (_, lane) => {
        const { lanes, calls } = pausesOf();

        await expect(lanes.pauseGlobally(/** @type {any} */ (lane))).rejects.toThrow(InvalidOptionsError);
        await expect(lanes.resumeGlobally(/** @type {any} */ (lane))).rejects.toThrow(
            'lanes.resumeGlobally(): the lane must be a lane definition or a name matching',
        );
        expect(calls).toStrictEqual([]);
    });

    test('an unknown option: an InvalidOptionsError', async () => {
        const { lanes } = pausesOf();

        await expect(lanes.pauseGlobally(report, /** @type {any} */ ({ transaction: {} })))
            .rejects.toThrow(new InvalidOptionsError('lanes.pauseGlobally(): unknown options: transaction'));
    });
});

describe('the schedule of a pause', () => {
    test('a definition: its id, lane and spec', () => {
        expect(scheduleOf(daily, 'w')).toStrictEqual({
            id: 'report:daily:eu', lane: 'report', spec: 'cron 0 6 * * * Europe/Berlin',
        });
    });

    test('an id: the lane before its first colon, the placeholder spec', () => {
        expect(scheduleOf('report:daily:eu', 'w')).toStrictEqual({
            id: 'report:daily:eu', lane: 'report', spec: PLACEHOLDER_SPEC,
        });
    });

    test.each([
        ['a lane only', 'report'],
        ['an uppercase lane', 'Report:daily'],
        ['an empty key', 'report:'],
        ['a key with a space at its end', 'report:daily '],
        ['a key of 65 characters', `report:${'k'.repeat(65)}`],
        ['a number', 7],
    ])('%s: an InvalidOptionsError', (_, schedule) => {
        expect(() => scheduleOf(schedule, 'schedules.pauseGlobally()')).toThrow(new InvalidOptionsError(
            'schedules.pauseGlobally(): the schedule must be a schedule definition, from defineSchedule(), or an id '
            + '`<lane>:<key>`',
        ));
    });

    test('remove: a lane only too, the id of a keyless schedule of 9.x', async () => {
        const { schedules, calls } = pausesOf();

        await expect(schedules.remove('report')).resolves.toStrictEqual({ removed: true });
        await expect(schedules.remove('Report')).rejects.toThrow('or `<lane>`, a schedule of 9.x');
        expect(calls).toStrictEqual([['removeSchedule', 'report', undefined]]);
    });

    test('pause, resume and remove: by definition or id, with the connection', async () => {
        const { schedules, calls } = pausesOf();
        const connection = { tx: 1 };

        await schedules.pauseGlobally(daily, { connection });
        await schedules.pauseGlobally('report:weekly');
        await schedules.resumeGlobally('report:daily:eu', { connection });
        await schedules.remove(daily);
        expect(calls).toStrictEqual([
            ['pauseSchedule', { id: 'report:daily:eu', lane: 'report', spec: 'cron 0 6 * * * Europe/Berlin' }, connection],
            ['pauseSchedule', { id: 'report:weekly', lane: 'report', spec: PLACEHOLDER_SPEC }, undefined],
            ['resumeSchedule', 'report:daily:eu', connection],
            ['removeSchedule', 'report:daily:eu', undefined],
        ]);
    });
});

describe('lanes.stats()', () => {
    test('pausedGlobally on each lane; a paused lane without jobs too, in the order of the names', async () => {
        const { store } = fakeStore({ stats: [statsOf('b'), statsOf('d')], paused: ['a', 'd'] });
        const { lanes } = pausesOf({ store });

        await expect(lanes.stats()).resolves.toStrictEqual([
            {
                name: 'a', pending: 0, blocked: 0, due: 0, running: 0, stuck: 0, failed: 0, completed: 0,
                oldestDueAgeMs: null, pausedGlobally: true,
            },
            { ...statsOf('b'), pausedGlobally: false },
            { ...statsOf('d'), pausedGlobally: true },
        ]);
    });
});

describe('a schema without 0010_pause', () => {
    test.each([
        ['a missing table', { code: '42P01' }],
        ['a missing column', { code: 'ER_BAD_FIELD_ERROR', errno: 1054 }],
    ])('%s: a ConfigError that asks for schema.migrate()', async (_, cause) => {
        const failing = async () => {
            throw Object.assign(new Error('missing'), cause);
        };
        const { store } = fakeStore();
        const { lanes, schedules } = pausesOf({
            store: {
                ...store,
                pauseLane: failing,
                readPausedLanes: failing,
                pauseSchedule: failing,
                removeSchedule: failing,
            },
        });
        const message = 'the schema is not migrated: run schema.migrate()';

        await expect(lanes.pauseGlobally(report)).rejects.toThrow(new ConfigError(`lanes.pauseGlobally(): ${message}`));
        await expect(lanes.stats()).rejects.toThrow(new ConfigError(`lanes.stats(): ${message}`));
        await expect(schedules.pauseGlobally(daily)).rejects.toThrow(ConfigError);
        await expect(schedules.remove(daily)).rejects.toThrow(ConfigError);
    });

    test('another error: as it is', async () => {
        const down = Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
        const { store } = fakeStore();
        const { lanes } = pausesOf({
            store: {
                ...store,
                pauseLane: async () => {
                    throw down;
                },
            },
        });

        await expect(lanes.pauseGlobally(report)).rejects.toBe(down);
    });
});

describe('lanes.resumeGlobally()', () => {
    test('then the blocked jobs of the lane: concurrency keys unblocked, rate keys armed in the runner; then the wake '
        + 'and the hint', async () => {
        const { store, calls } = fakeStore({ blockedKeys: ['order:1', '@api:2', 'order:3'] });
        const runner = { armRateWake: vi.fn(), wake: vi.fn(), isBusy: () => true };
        const { lanes, published, unblocked } = pausesOf({ store, attached: () => /** @type {any} */ (runner) });

        await lanes.resumeGlobally(report);
        // The paused lanes that the store saw at its last probe still list it: forgotten before the unblocks
        expect(calls).toStrictEqual([
            ['resumeLane', 'report', undefined],
            ['forgetPausedLanes'],
            ['blockedKeysOfLane', 'report'],
        ]);
        expect(unblocked).toStrictEqual([['order:1', 'order:3']]);
        expect(runner.armRateWake.mock.calls).toStrictEqual([['@api:2', 0]]);
        expect(runner.wake.mock.calls).toStrictEqual([[['report']]]);
        expect(published).toStrictEqual(['report']);
    });

    test('a runner that is not started nor draining: one unblock of the rate keys, no timer', async () => {
        const { store, calls } = fakeStore({ blockedKeys: ['@api:2'] });
        const runner = { armRateWake: vi.fn(), wake: vi.fn(), isBusy: () => false };
        const { lanes } = pausesOf({ store, attached: () => /** @type {any} */ (runner) });

        await lanes.resumeGlobally(report);
        expect(calls.at(-1)).toStrictEqual(['unblockRates', ['@api:2']]);
        expect(runner.armRateWake).not.toHaveBeenCalled();
    });

    test('a lane that was not paused: no read of its blocked jobs, no wake, no hint', async () => {
        const { store, calls } = fakeStore({ wasPaused: false, blockedKeys: ['order:1'] });
        const runner = { armRateWake: vi.fn(), wake: vi.fn(), isBusy: () => true };
        const { lanes, published, unblocked } = pausesOf({ store, attached: () => /** @type {any} */ (runner) });

        await lanes.resumeGlobally(report);
        expect(calls).toStrictEqual([['resumeLane', 'report', undefined]]);
        expect([unblocked, published, runner.wake.mock.calls]).toStrictEqual([[], [], []]);
    });

    test('no blocked job: no unblock of keys', async () => {
        const { store } = fakeStore();
        const { lanes, unblocked, published } = pausesOf({ store });

        await lanes.resumeGlobally(report);
        expect(unblocked).toStrictEqual([]);
        expect(published).toStrictEqual(['report']);
    });

    test('with a connection whose commit the adapter cannot tell: at once, then the re-probes of an enqueue and the '
        + 'unblocks once more, after the commit can have happened', async () => {
        vi.useFakeTimers();

        try {
            const { store, calls } = fakeStore({ blockedKeys: ['order:1'] });
            const runner = { armRateWake: vi.fn(), wake: vi.fn(), onEnqueued: vi.fn(), isBusy: () => true };
            const { lanes, published, unblocked } = pausesOf({
                store,
                adapter: /** @type {any} */ ({ dialect: 'postgres', afterCommit: () => false }),
                attached: () => /** @type {any} */ (runner),
            });

            await lanes.resumeGlobally(report, { connection: {} });
            expect(runner.onEnqueued.mock.calls).toStrictEqual([[['report']]]);
            expect(runner.wake).not.toHaveBeenCalled();
            expect(published).toStrictEqual(['report']);
            expect(unblocked).toStrictEqual([['order:1']]);
            await vi.advanceTimersByTimeAsync(1000);
            expect(unblocked).toStrictEqual([['order:1'], ['order:1']]);
            await vi.advanceTimersByTimeAsync(4000);
            // A commit later than a second: once more at 5 s
            expect(unblocked).toHaveLength(3);
            expect(calls.filter(([name]) => name === 'blockedKeysOfLane')).toHaveLength(3);
            expect(calls.filter(([name]) => name === 'forgetPausedLanes')).toHaveLength(3);
        } finally {
            vi.useRealTimers();
        }
    });

    test('with a connection whose commit the adapter cannot tell, then a close: no unblock after the close', async () => {
        vi.useFakeTimers();

        try {
            const { store } = fakeStore({ blockedKeys: ['order:1'] });
            let closed = false;
            const { lanes, unblocked } = pausesOf({
                store,
                adapter: /** @type {any} */ ({ dialect: 'postgres', afterCommit: () => false }),
                isClosed: () => closed,
            });

            await lanes.resumeGlobally(report, { connection: {} });
            closed = true;
            await vi.advanceTimersByTimeAsync(10_000);
            expect(unblocked).toStrictEqual([['order:1']]);
        } finally {
            vi.useRealTimers();
        }
    });

    test('without a runner: one unblock of the rate keys', async () => {
        const { store, calls } = fakeStore({ blockedKeys: ['@api:2', '@api:1'] });
        const { lanes, published } = pausesOf({ store });

        await lanes.resumeGlobally('report');
        expect(calls.at(-1)).toStrictEqual(['unblockRates', ['@api:2', '@api:1']]);
        expect(published).toStrictEqual(['report']);
    });

    test('with a connection: after its commit, when the adapter knows it', async () => {
        const { store, calls } = fakeStore();
        /** @type {(() => void)[]} */
        const hooks = [];
        const { lanes, published } = pausesOf({
            store,
            adapter: /** @type {any} */ ({
                dialect: 'postgres',
                afterCommit: (/** @type {unknown} */ _connection, /** @type {() => void} */ hook) => (
                    hooks.push(hook) > 0
                ),
            }),
        });

        await lanes.resumeGlobally(report, { connection: {} });
        expect(calls).toStrictEqual([['resumeLane', 'report', {}]]);
        expect(published).toStrictEqual([]);
        hooks[0]();
        await vi.waitFor(() => {
            expect(published).toStrictEqual(['report']);
        });
        expect(calls.at(-1)).toStrictEqual(['blockedKeysOfLane', 'report']);
    });

    test('a failed read of the blocked keys: reported; the wake and the hint all the same', async () => {
        const { store } = fakeStore();
        const reportError = vi.fn();
        const failure = new Error('read failed');
        const { lanes, published } = pausesOf({
            store: {
                ...store,
                blockedKeysOfLane: async () => {
                    throw failure;
                },
            },
            reportError,
        });

        await lanes.resumeGlobally(report);
        expect(reportError).toHaveBeenCalledWith('resume', failure);
        expect(published).toStrictEqual(['report']);
    });
});

test('sqlane.lanes and sqlane.schedules have the methods of the pauses; frozen', () => {
    const sqlane = createSqlane({ adapter: /** @type {any} */ ({ dialect: 'postgres' }) });

    expect(Object.isFrozen(sqlane.lanes)).toBe(true);
    expect(Object.keys(sqlane.lanes).toSorted())
        .toStrictEqual(['groupStats', 'pauseGlobally', 'resumeGlobally', 'stats']);
    expect(Object.keys(sqlane.schedules).toSorted())
        .toStrictEqual(['list', 'pauseGlobally', 'remove', 'resumeGlobally', 'runSlot']);
});
