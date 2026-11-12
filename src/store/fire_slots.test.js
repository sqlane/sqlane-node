import { describe, expect, test } from 'vitest';
import { decideSlot, runFire } from './fire_slots.js';

/** @typedef {import('./fire_slots.js').SlotCandidate} SlotCandidate */
/** @typedef {import('./fire_slots.js').ScheduleRow} ScheduleRow */

const LIMITS = { graceMs: 60_000, futureMs: 1000 };
const NOW = 1_000_000_000;

/**
 * @param {Partial<SlotCandidate>} fields
 * @returns {SlotCandidate}
 */
function candidate(fields = {}) {
    return {
        id: 'report',
        name: 'report',
        spec: 'every 60000',
        slot: NOW - 1000,
        missed: 'once',
        overlap: 'allow',
        catchUpFrom: -Infinity,
        ...fields,
        due: fields.due ?? fields.slot ?? NOW - 1000,
    };
}

/**
 * @param {Partial<ScheduleRow>} fields
 * @returns {ScheduleRow}
 */
function row(fields = {}) {
    return { id: 'report', jobName: 'report', spec: 'every 60000', lastSlotMs: 0, lastJobId: null, ...fields };
}

describe('decideSlot', () => {
    test.each([
        ['a slot ahead of the database clock', candidate({ slot: NOW + 1001 }), row(), 'deferred'],
        ['a slot just ahead of it', candidate({ slot: NOW + 1000 }), row(), 'on_time'],
        ['a slot whose jitter is ahead', candidate({ slot: NOW - 5000, due: NOW + 1001 }), row(), 'deferred'],
        ['a late slot whose jitter is on time', candidate({ slot: NOW - 120_000, due: NOW - 1000 }), row(), 'on_time'],
        ['a slot whose jitter is late', candidate({ slot: NOW - 120_000, due: NOW - 60_001 }), row(), 'late'],
        ['a slot at the cursor', candidate(), row({ lastSlotMs: NOW - 1000 }), 'lost'],
        ['a slot before the cursor', candidate(), row({ lastSlotMs: NOW }), 'lost'],
        ['a slot within the grace', candidate({ slot: NOW - 60_000 }), row(), 'on_time'],
        ['a late slot, once', candidate({ slot: NOW - 60_001 }), row(), 'late'],
        ['a late slot, skip', candidate({ slot: NOW - 60_001, missed: 'skip' }), row(), 'dropped'],
        ['a late slot of another spec', candidate({ slot: NOW - 60_001 }), row({ spec: 'every 1000' }), 'dropped'],
        [
            'a late slot beyond the catch-up reach',
            candidate({ slot: NOW - 60_001, catchUpFrom: 5 }),
            row({ lastSlotMs: 4 }),
            'dropped',
        ],
        [
            'a late slot within the catch-up reach',
            candidate({ slot: NOW - 60_001, catchUpFrom: 5 }),
            row({ lastSlotMs: 5 }),
            'late',
        ],
    ])('%s: %s', (_, slot, scheduleRow, expected) => {
        expect(decideSlot(slot, scheduleRow, NOW, LIMITS)).toBe(expected);
    });
});

/**
 * Statements over rows in memory: what they were called with.
 * @param {ScheduleRow[]} rows The rows that the lock pass returns.
 * @param {string[]} [unfinished]
 * @returns {{ statements: import('./fire_slots.js').FireStatements, calls: Record<string, unknown[]> }}
 */
function stubStatements(rows, unfinished = []) {
    /** @type {Record<string, unknown[]>} */
    const calls = { insertMissing: [], lockRows: [], findUnfinishedJobs: [], insertJobs: [], updateCursors: [] };

    return {
        calls,
        statements: {
            insertMissing: async (_, __, candidates) => {
                calls.insertMissing.push(candidates.map(({ id }) => id));
            },
            lockRows: async (_, __, ids) => {
                calls.lockRows.push(ids);

                return { dbNowMs: rows.length ? NOW : null, rows: rows.filter(({ id }) => ids.includes(id)) };
            },
            findUnfinishedJobs: async (_, __, jobIds) => {
                calls.findUnfinishedJobs.push(jobIds);

                return new Set(jobIds.filter(id => unfinished.includes(id)));
            },
            insertJobs: async (_, __, jobs) => {
                calls.insertJobs.push(jobs.map(({ id }) => id));

                return new Set(jobs.map(({ id }) => id).filter(id => !id.includes('exists')));
            },
            updateCursors: async (_, __, winners) => {
                calls.updateCursors.push(winners);
            },
        },
    };
}

/**
 * @param {import('./fire_slots.js').FireStatements} statements
 * @param {SlotCandidate[]} candidates
 * @returns {Promise<import('./fire_slots.js').FireResult>}
 */
function fire(statements, candidates) {
    return runFire(/** @type {any} */ ({}), 'q_', statements, {
        candidates,
        buildJob: (slot, late) => /** @type {any} */ ({ id: `${slot.name}:${slot.id}:${late ? 'late' : 'on_time'}` }),
        notifyChannel: null,
        now: () => 0,
        ...LIMITS,
    });
}

describe('runFire', () => {
    test('one lock pass, one insert of all the names, one update; losers write nothing', async () => {
        const { statements, calls } = stubStatements([
            row({ id: 'a', jobName: 'a' }),
            row({ id: 'b', jobName: 'b', lastSlotMs: NOW }),
            row({ id: 'c', jobName: 'c', spec: 'other' }),
        ]);
        const result = await fire(statements, [
            candidate({ id: 'a', name: 'a' }),
            candidate({ id: 'b', name: 'b' }),
            candidate({ id: 'c', name: 'c', slot: NOW - 120_000 }),
            candidate({ id: 'd', name: 'd' }),
        ]);

        expect(calls.lockRows).toStrictEqual([['a', 'b', 'c', 'd']]);
        expect(calls.insertJobs).toStrictEqual([['a:a:on_time']]);
        expect(calls.updateCursors).toStrictEqual([[
            { id: 'a', name: 'a', spec: 'every 60000', slot: NOW - 1000, jobId: 'a:a:on_time' },
        ]]);
        expect(result).toStrictEqual({
            clock: { dbNowMs: NOW, sentAt: 0, receivedAt: 0 },
            decided: [
                { id: 'b', name: 'b', slot: NOW - 1000, late: false, outcome: 'lost', jobId: null, created: false },
                { id: 'c', name: 'c', slot: NOW - 120_000, late: true, outcome: 'dropped', jobId: null, created: false },
                { id: 'a', name: 'a', slot: NOW - 1000, late: false, outcome: 'enqueued', jobId: 'a:a:on_time', created: true },
            ],
            busy: ['d'],
            deferred: [],
        });
    });

    test('overlap skip: the slot wins without a job while the last job is not done', async () => {
        const { statements, calls } = stubStatements([
            row({ id: 'a', lastJobId: 'report:running' }),
            row({ id: 'b', lastJobId: 'report:done' }),
        ], ['report:running']);
        const result = await fire(statements, [
            candidate({ id: 'a', overlap: 'skip' }),
            candidate({ id: 'b', overlap: 'skip' }),
        ]);

        expect(calls.findUnfinishedJobs).toStrictEqual([['report:running', 'report:done']]);
        expect(calls.insertJobs).toStrictEqual([['report:b:on_time']]);
        expect(result.decided.map(({ id, outcome, jobId }) => ({ id, outcome, jobId }))).toStrictEqual([
            { id: 'a', outcome: 'skipped', jobId: null },
            { id: 'b', outcome: 'enqueued', jobId: 'report:b:on_time' },
        ]);
        expect(calls.updateCursors).toStrictEqual([[
            { id: 'a', name: 'report', spec: 'every 60000', slot: NOW - 1000, jobId: null },
            { id: 'b', name: 'report', spec: 'every 60000', slot: NOW - 1000, jobId: 'report:b:on_time' },
        ]]);
    });

    test('a job that exists already is the job of the slot', async () => {
        const { statements } = stubStatements([row({ id: 'exists' })]);
        const result = await fire(statements, [candidate({ id: 'exists' })]);

        expect(result.decided).toMatchObject([{ outcome: 'enqueued', jobId: 'report:exists:on_time', created: false }]);
    });

    test('a late catch-up gets a late job; a deferred slot writes nothing', async () => {
        const { statements, calls } = stubStatements([row({ id: 'a' }), row({ id: 'b' })]);
        const result = await fire(statements, [
            candidate({ id: 'a', slot: NOW - 3_600_000 }),
            candidate({ id: 'b', slot: NOW + 5000 }),
        ]);

        expect(calls.insertJobs).toStrictEqual([['report:a:late']]);
        expect(result.deferred).toStrictEqual(['b']);
        expect(result.decided).toMatchObject([{ id: 'a', late: true, outcome: 'enqueued' }]);
    });

    test('the missing rows of a recheck are inserted first; no row back: busy, no clock', async () => {
        const { statements, calls } = stubStatements([]);
        const result = await fire(statements, [candidate({ id: 'a', insertMissing: true }), candidate({ id: 'b' })]);

        expect(calls.insertMissing).toStrictEqual([['a']]);
        expect(calls.insertJobs).toStrictEqual([]);
        expect(result).toStrictEqual({ clock: null, decided: [], busy: ['a', 'b'], deferred: [] });
    });
});
