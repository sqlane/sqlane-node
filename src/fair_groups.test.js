import { describe, expect, test } from 'vitest';
import { movedPointer, orderGroupRows, requestGroups } from './fair_groups.js';

/** @typedef {import('./fair_groups.js').FairGroup} FairGroup */

/**
 * A seeded random generator (LCG), as in fair_share.test.js.
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

const noRunning = () => 0;
const first = () => 0;

/**
 * @param {Record<string, number>} counts
 * @returns {(group: FairGroup) => number} The running counts of the groups: 0 for the others.
 */
const runningFrom = counts => group => counts[String(group)] ?? 0;

describe('requestGroups', () => {
    test('the rotation: byte order, the null group last, from the group after the pointer', () => {
        const requests = requestGroups({
            dueGroups: [null, 'b', 'a', 'c'], runningOf: noRunning, pointer: 'a', maxJobs: 1, random: first,
        });

        expect(requests.map(({ group, tie }) => [group, tie])).toStrictEqual([['b', 0], ['c', 1], [null, 2], ['a', 3]]);
    });

    test('the pointer wraps around: after the last group, the first', () => {
        const requests = requestGroups({
            dueGroups: ['a', 'b', null], runningOf: noRunning, pointer: null, maxJobs: 1, random: first,
        });

        expect(requests.map(({ group }) => group)).toStrictEqual(['a', 'b', null]);
    });

    test('the group of the pointer gone: the next group after it', () => {
        const requests = requestGroups({
            dueGroups: ['a', 'c'], runningOf: noRunning, pointer: 'b', maxJobs: 1, random: first,
        });

        expect(requests.map(({ group }) => group)).toStrictEqual(['c', 'a']);
    });

    test('no pointer yet: the rotation starts at a group drawn by the random', () => {
        const requests = requestGroups({
            dueGroups: ['a', 'b', 'c', 'd'], runningOf: noRunning, pointer: undefined, maxJobs: 1, random: () => 0.6,
        });

        expect(requests.map(({ group }) => group)).toStrictEqual(['c', 'd', 'a', 'b']);
    });

    test('the fewest running first, then the rotation', () => {
        const requests = requestGroups({
            dueGroups: ['a', 'b', 'c', 'd'],
            runningOf: runningFrom({ a: 2, c: 1 }),
            pointer: 'b',
            maxJobs: 2,
            random: first,
        });

        expect(requests.map(({ group, running: count }) => [group, count]))
            .toStrictEqual([['d', 0], ['b', 0], ['c', 1], ['a', 2]]);
    });

    test('maxJobs of a group: its water-fill share of the slots, + 1', () => {
        const requests = requestGroups({
            dueGroups: ['a', 'b', 'c'],
            runningOf: runningFrom({ a: 3 }),
            pointer: null,
            maxJobs: 5,
            random: first,
        });

        // b and c fill up to a's 3, then the 5th slot goes by the rotation (b first)
        expect(requests.map(({ group, maxJobs }) => [group, maxJobs])).toStrictEqual([['b', 4], ['c', 3], ['a', 1]]);
    });

    test('at most 4 groups per slot, and at most 8 more than the slots', () => {
        const dueGroups = Array.from({ length: 100 }, (_, at) => `g${String(at).padStart(3, '0')}`);
        const of = (/** @type {number} */ maxJobs) => requestGroups({
            dueGroups, runningOf: noRunning, pointer: undefined, maxJobs, random: first,
        }).length;

        expect([of(1), of(2), of(3), of(10)]).toStrictEqual([4, 8, 11, 18]);
    });

    test('no due group, or no slot: nothing', () => {
        expect(requestGroups({ dueGroups: [], runningOf: noRunning, pointer: null, maxJobs: 1, random: first }))
            .toStrictEqual([]);
        expect(requestGroups({ dueGroups: ['a'], runningOf: noRunning, pointer: null, maxJobs: 0, random: first }))
            .toStrictEqual([]);
    });
});

describe('orderGroupRows', () => {
    test('the heads of the groups in turn, FIFO within a group', () => {
        const requests = requestGroups({
            dueGroups: ['a', 'b', null], runningOf: noRunning, pointer: null, maxJobs: 6, random: first,
        });
        const rows = [
            { id: 'a1', fairGroup: 'a' }, { id: 'a2', fairGroup: 'a' }, { id: 'a3', fairGroup: 'a' },
            { id: 'n1', fairGroup: null }, { id: 'b1', fairGroup: 'b' },
        ];

        expect(orderGroupRows(rows, requests).map(({ id }) => id)).toStrictEqual(['a1', 'b1', 'n1', 'a2', 'a3']);
    });

    test('a group with jobs running here comes after the others', () => {
        const requests = requestGroups({
            dueGroups: ['a', 'b'], runningOf: runningFrom({ a: 2 }), pointer: null, maxJobs: 3, random: first,
        });
        const rows = [{ id: 'a1', fairGroup: 'a' }, { id: 'b1', fairGroup: 'b' }, { id: 'b2', fairGroup: 'b' },
            { id: 'b3', fairGroup: 'b' }];

        expect(orderGroupRows(rows, requests).map(({ id }) => id)).toStrictEqual(['b1', 'b2', 'a1', 'b3']);
    });
});

describe('movedPointer', () => {
    const requests = requestGroups({
        dueGroups: ['a', 'b', 'c'], runningOf: noRunning, pointer: null, maxJobs: 1, random: first,
    });

    test('past the group that won the tie', () => {
        expect(movedPointer({ requests, claimed: [{ fairGroup: 'a' }], left: ['b', 'c'], pointer: null })).toBe('a');
    });

    test('no claim, or no tie: the same pointer', () => {
        expect(movedPointer({ requests, claimed: [], left: ['a'], pointer: 'c' })).toBe('c');
        expect(movedPointer({ requests, claimed: [{ fairGroup: 'a' }], left: [], pointer: 'c' })).toBe('c');
    });
});

/**
 * A runner with one slot of one lane, as the claims see it: each turn, the due groups, the requests, the heads of the
 * requested groups locked, ordered, the first taken; the pointer moved.
 * @param {Map<FairGroup, number>} backlog The jobs of each group; mutated.
 * @param {() => number} random
 * @param {number} starts
 * @returns {FairGroup[]} The group of each start.
 */
function simulateOneSlot(backlog, random, starts) {
    /** @type {FairGroup | undefined} */
    let pointer;
    /** @type {FairGroup[]} */
    const started = [];

    for (let turn = 0; turn < starts; turn++) {
        const dueGroups = [...backlog].filter(([, count]) => count > 0).map(([group]) => group);
        const requests = requestGroups({ dueGroups, runningOf: noRunning, pointer, maxJobs: 1, random });

        if (!requests.length) {
            break;
        }

        const locked = requests.flatMap(({ group, maxJobs }) => Array.from(
            { length: Math.min(maxJobs, /** @type {number} */ (backlog.get(group))) },
            () => ({ fairGroup: group }),
        ));
        const [taken, ...rest] = orderGroupRows(locked, requests);

        pointer = movedPointer({
            requests,
            claimed: [taken],
            left: [...new Set(rest.map(row => row.fairGroup))],
            pointer,
        });
        backlog.set(taken.fairGroup, /** @type {number} */ (backlog.get(taken.fairGroup)) - 1);
        started.push(taken.fairGroup);
    }

    return started;
}

/**
 * The starts that break Behavior 5: between two starts of a group, every other group with a job left at the first one
 * starts exactly once (no group joins later, so each has a job left when its turn comes).
 * @param {FairGroup[]} started
 * @param {Map<FairGroup, number>} totals The jobs of each group at the start.
 * @returns {object[]}
 */
function brokenRotations(started, totals) {
    const broken = [];
    const startedBefore = (/** @type {FairGroup} */ group, /** @type {number} */ until) => started
        .slice(0, until).filter(each => each === group).length;

    for (const [at, group] of started.entries()) {
        const next = started.indexOf(group, at + 1);
        if (next === -1) {
            continue;
        }

        const between = started.slice(at + 1, next);
        const due = [...totals.keys()].filter(other => other !== group
            && startedBefore(other, at + 1) < /** @type {number} */ (totals.get(other)));

        for (const other of due) {
            const count = between.filter(each => each === other).length;

            if (count !== 1) {
                broken.push({ at, group, other, count });
            }
        }
    }

    return broken;
}

/**
 * @param {() => number} random
 * @returns {Map<FairGroup, number>} 2–21 groups: one with 200 jobs, the others 1–6; sometimes the null group.
 */
function randomBacklog(random) {
    const groupCount = 2 + Math.floor(random() * 20);
    /** @type {Map<FairGroup, number>} */
    const backlog = new Map();

    for (let at = 0; at < groupCount; at++) {
        backlog.set(at === 0 && random() < 0.3 ? null : `g${at}`, at === 1 ? 200 : 1 + Math.floor(random() * 6));
    }

    return backlog;
}

test.each(Array.from({ length: 50 }, (_, seed) => seed))('Behavior 5, seed %i: one slot, between two starts of a '
    + 'group, every other group due at the first starts exactly once; every job starts', (seed) => {
    const random = seeded(seed);
    const backlog = randomBacklog(random);
    const totals = new Map(backlog);
    let jobs = 0;

    for (const count of totals.values()) {
        jobs += count;
    }

    const started = simulateOneSlot(backlog, random, 400);

    expect(brokenRotations(started, totals)).toStrictEqual([]);
    expect(started).toHaveLength(Math.min(400, jobs));
});
