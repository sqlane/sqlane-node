import { describe, expect, test } from 'vitest';
import { chooseRows, fill, rankNames, replayTie, shareNamesOfRequests } from './fair_share.js';

/** @typedef {import('./fair_share.js').ShareName} ShareName */

/**
 * @typedef {object} Spec
 * @property {string} name
 * @property {number} [weight]
 * @property {number} [running]
 * @property {number} [room]
 * @property {string} [group]
 * @property {number} [available]
 */

/**
 * @param {Spec[]} specs
 * @param {Record<string, number>} [groupRooms]
 * @returns {ShareName[]} Their indexes in the given order; one room object per group.
 */
function shareNames(specs, groupRooms = {}) {
    const groups = new Map(Object.entries(groupRooms).map(([name, room]) => [name, { room }]));

    return specs.map((spec, index) => ({
        name: spec.name,
        index,
        weight: spec.weight ?? 1,
        running: spec.running ?? 0,
        room: spec.room ?? Infinity,
        group: spec.group === undefined ? null : /** @type {{ room: number }} */ (groups.get(spec.group)),
        available: spec.available ?? Infinity,
    }));
}

/**
 * A fill whose units are the names, and its pointer moved as the runner moves it.
 * @param {ShareName[]} names
 * @param {number} free
 * @param {{ pointer: number }} state
 * @returns {string[]}
 */
function fillNames(names, free, state) {
    const { chosen, lastTieWinner } = fill({
        names,
        free,
        base: state.pointer,
        size: names.length,
        take: name => name.name,
    });

    if (lastTieWinner !== null) {
        state.pointer = (lastTieWinner + 1) % names.length;
    }

    return chosen;
}

/**
 * The linear-scan reference of the design (scratchpad sim.mjs): the same rule, without a heap.
 * @param {ShareName[]} names
 * @param {number} free
 * @param {{ pointer: number }} state
 * @returns {string[]}
 */
function referenceChoose(names, free, state) {
    const chosen = [];
    const base = state.pointer;
    let lastTieWinner = -1;
    let left = free;

    while (left > 0) {
        let best = -1;
        let tie = false;

        for (let step = 0; step < names.length; step++) {
            const index = (base + step) % names.length;
            const candidate = names[index];
            const eligible = candidate.room > 0 && candidate.available > 0
                && (candidate.group === null || candidate.group.room > 0);

            if (!eligible) {
                continue;
            }

            if (best < 0) {
                best = index;
                continue;
            }

            const left2 = candidate.running * names[best].weight;
            const right = names[best].running * candidate.weight;

            if (left2 < right) {
                best = index;
                tie = false;
            } else if (left2 === right) {
                tie = true;
            }
        }

        if (best < 0) {
            break;
        }

        const winner = names[best];

        chosen.push(winner.name);
        winner.running++;
        winner.room--;
        winner.available--;
        left--;

        if (winner.group) {
            winner.group.room--;
        }

        if (tie) {
            lastTieWinner = best;
        }
    }

    if (lastTieWinner >= 0) {
        state.pointer = (lastTieWinner + 1) % names.length;
    }

    return chosen;
}

/**
 * A seeded random generator (LCG).
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
 * A random input of the chooser: 1–20 names, weights 1–1000, rooms, shared group rooms, units.
 * @param {() => number} random
 * @returns {{ specs: Spec[], groupRooms: Record<string, number>, free: number }}
 */
function randomInput(random) {
    const int = (/** @type {number} */ max) => Math.floor(random() * (max + 1));
    const count = 1 + int(19);
    const groupRooms = { g0: int(6), g1: int(12) };
    /** @type {Spec[]} */
    const specs = Array.from({ length: count }, (_, index) => {
        const group = [undefined, 'g0', 'g1'][int(2)];

        return {
            name: `n${index}`,
            weight: random() < 0.3 ? 1 + int(999) : 1 + int(4),
            running: int(8),
            room: random() < 0.3 ? Infinity : int(6),
            ...group === undefined ? {} : { group },
            available: random() < 0.3 ? Infinity : int(8),
        };
    });

    return { specs, groupRooms, free: int(50) };
}

/**
 * Checks the caps, the work conservation and the envy-freeness up to one slot of one fill.
 * @param {{ specs: Spec[], groupRooms: Record<string, number>, free: number }} input
 * @returns {string[]} The broken properties.
 */
function checkProperties({ specs, groupRooms, free }) {
    const names = shareNames(specs, groupRooms);
    const before = structuredClone(names.map(({ running, room, available }) => ({ running, room, available })));
    const chosen = fillNames(names, free, { pointer: 0 });
    const broken = [];
    const got = new Map(names.map(name => [name.name, chosen.filter(chosenName => chosenName === name.name).length]));

    for (const [index, name] of names.entries()) {
        const taken = /** @type {number} */ (got.get(name.name));

        if (taken > before[index].room || taken > before[index].available) {
            broken.push(`name cap ${name.name}`);
        }
    }

    for (const [group, room] of Object.entries(groupRooms)) {
        let taken = 0;

        for (const spec of specs.filter(member => member.group === group)) {
            taken += /** @type {number} */ (got.get(spec.name));
        }

        if (taken > Math.max(room, 0)) {
            broken.push(`group cap ${group}`);
        }
    }

    if (chosen.length > free) {
        broken.push('instance cap');
    }

    const canTake = names.filter(name => name.room > 0 && name.available > 0
        && (name.group === null || name.group.room > 0));

    if (chosen.length < free && canTake.length) {
        broken.push('work conserving');
    }

    // Envy-free up to one slot: a name that got a slot was at most one slot above any name that could still take one
    for (const winner of names.filter(name => /** @type {number} */ (got.get(name.name)) > 0)) {
        for (const other of canTake) {
            if ((winner.running - 1) * other.weight > other.running * winner.weight) {
                broken.push(`envy ${winner.name} ${other.name}`);
            }
        }
    }

    return broken;
}

/**
 * @param {() => number} random
 * @returns {object[]} The input if the heap and the reference differ.
 */
function compareWithReference(random) {
    const input = randomInput(random);
    const pointer = Math.floor(random() * input.specs.length);
    const heapState = { pointer };
    const referenceState = { pointer };
    const byHeap = fillNames(shareNames(input.specs, input.groupRooms), input.free, heapState);
    const byReference = referenceChoose(shareNames(input.specs, input.groupRooms), input.free, referenceState);

    return JSON.stringify([byHeap, heapState]) === JSON.stringify([byReference, referenceState])
        ? []
        : [{ input, byHeap, byReference }];
}

/**
 * Without groups and name caps, as a plan over the names of a claim: the served names are a prefix of the ranking.
 * @param {() => number} random
 * @returns {object[]} The case if not.
 */
function checkPrefix(random) {
    const { specs, free } = randomInput(random);
    const plain = specs.map(spec => ({ name: spec.name, weight: spec.weight, running: spec.running }));
    const ranked = rankNames(shareNames(plain), 0, plain.length).map(name => name.name);
    const served = new Set(fillNames(shareNames(plain), free, { pointer: 0 }));

    return ranked.slice(0, served.size).every(name => served.has(name)) ? [] : [{ ranked, served: [...served] }];
}

describe('fill: the examples of the design', () => {
    test('6.2: weights 3:1 on 8 slots', () => {
        const names = shareNames([{ name: 'A', weight: 3 }, { name: 'B', weight: 1 }]);

        expect(fillNames(names, 8, { pointer: 0 })).toStrictEqual(['A', 'B', 'A', 'A', 'A', 'B', 'A', 'A']);
    });

    test('6.3: A has 4 running, then A and B share the slots that free together', () => {
        const state = { pointer: 0 };
        const counts = { A: 0, B: 0 };
        const claim = (/** @type {number} */ free, /** @type {{ A: number, B: number }} */ available) => fillNames(
            shareNames([{ name: 'A', available: available.A, running: counts.A }, { name: 'B', available: available.B, running: counts.B }]),
            free,
            state,
        );

        expect(claim(4, { A: 10, B: 0 })).toStrictEqual(['A', 'A', 'A', 'A']);
        // A1–A4 end together; B's 3 jobs are due
        expect(claim(4, { A: 6, B: 3 })).toStrictEqual(['A', 'B', 'A', 'B']);
        expect(claim(4, { A: 4, B: 1 })).toStrictEqual(['B', 'A', 'A', 'A']);
    });

    test('6.5: the first claims with the group heavy at 2 and at 4', () => {
        const specs = /** @type {Spec[]} */ ([
            { name: 'T', weight: 2, room: 1, group: 'heavy' },
            { name: 'R', weight: 1, group: 'heavy' },
            { name: 'E', weight: 3 },
        ]);

        expect(fillNames(shareNames(specs, { heavy: 2 }), 10, { pointer: 0 }))
            .toStrictEqual(['T', 'R', 'E', 'E', 'E', 'E', 'E', 'E', 'E', 'E']);
        expect(fillNames(shareNames(specs, { heavy: 4 }), 10, { pointer: 0 }))
            .toStrictEqual(['T', 'R', 'E', 'E', 'E', 'R', 'E', 'E', 'E', 'R']);
    });
});

describe('fill: properties', () => {
    test('caps, work conservation and envy-freeness up to one slot, on 10,000 random inputs', () => {
        const random = seeded(7);
        const broken = Array.from({ length: 10_000 }, () => checkProperties(randomInput(random))).flat();

        expect(broken).toStrictEqual([]);
    });

    test('the heap equals the linear-scan reference on 10,000 random inputs, the pointer too', () => {
        const random = seeded(11);

        expect(Array.from({ length: 10_000 }, () => compareWithReference(random)).flat()).toStrictEqual([]);
    });

    test('the served names are a prefix of rankNames(), among the names with units', () => {
        const random = seeded(13);

        expect(Array.from({ length: 5000 }, () => checkPrefix(random)).flat()).toStrictEqual([]);
    });

    test('exact comparisons: weights 999 and 1000, large counts', () => {
        // 999 / 999 = 1000 / 1000: a tie; 1000 / 999 > 999 / 1000
        expect(fillNames(shareNames([
            { name: 'a', weight: 999, running: 999 },
            { name: 'b', weight: 1000, running: 1000 },
        ]), 1, { pointer: 1 })).toStrictEqual(['b']);
        expect(fillNames(shareNames([
            // 1,000,000 against 1,000,000.001
            { name: 'a', weight: 999, running: 999_000_000 },
            { name: 'b', weight: 1000, running: 1_000_000_001 },
        ]), 1, { pointer: 0 })).toStrictEqual(['a']);
    });

    test('round robin: 3 equal names, 1 slot, 30 calls: 10 wins each; the base is fixed within a call', () => {
        const state = { pointer: 0 };
        const wins = { a: 0, b: 0, c: 0 };

        for (let call = 0; call < 30; call++) {
            const [winner] = fillNames(shareNames([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), 1, state);

            wins[/** @type {'a' | 'b' | 'c'} */ (winner)]++;
        }

        expect(wins).toStrictEqual({ a: 10, b: 10, c: 10 });
        // Within a call: the order of the base, 3 slots
        expect(fillNames(shareNames([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), 3, { pointer: 1 }))
            .toStrictEqual(['b', 'c', 'a']);
    });
});

/**
 * An event simulation of one instance with the chooser, as in the design: the slot time of each name.
 * @param {object} params
 * @param {number} params.free The slots of the instance.
 * @param {{ name: string, weight: number, duration: number, room?: number, group?: string }[]} params.specs Each
 *     with a backlog larger than the run.
 * @param {Record<string, number>} [params.groupCaps]
 * @param {number} params.until
 * @returns {Record<string, number>} The time-averaged running count of each name.
 */
function simulate({ free, specs, groupCaps = {}, until }) {
    const state = { pointer: 0 };
    /** @type {{ name: string, end: number }[]} */
    let running = [];
    const slotTime = Object.fromEntries(specs.map(spec => [spec.name, 0]));
    const specOf = new Map(specs.map(spec => [spec.name, spec]));
    let now = 0;

    while (now < until) {
        const counts = new Map(specs.map(spec => [spec.name, 0]));
        const groupRooms = { ...groupCaps };

        for (const job of running) {
            const { group } = /** @type {{ group?: string }} */ (specOf.get(job.name));

            counts.set(job.name, /** @type {number} */ (counts.get(job.name)) + 1);
            groupRooms[group ?? ''] = (groupRooms[group ?? ''] ?? 0) - 1;
        }

        const names = shareNames(specs.map(spec => ({
            name: spec.name,
            weight: spec.weight,
            running: counts.get(spec.name),
            room: (spec.room ?? Infinity) - /** @type {number} */ (counts.get(spec.name)),
            ...spec.group === undefined ? {} : { group: spec.group },
        })), groupRooms);
        const startedAt = now;

        for (const name of fillNames(names, free - running.length, state)) {
            running.push({ name, end: startedAt + /** @type {{ duration: number }} */ (specOf.get(name)).duration });
        }

        const next = Math.min(until, ...running.map(job => job.end));

        for (const job of running) {
            slotTime[job.name] += next - now;
        }

        running = running.filter(job => job.end > next);
        now = next;
    }

    return Object.fromEntries(Object.entries(slotTime).map(([name, time]) => [name, time / until]));
}

describe('fill: convergence of the slot time', () => {
    test('weights 3:1 on 8 slots: 6 and 2 slots, also with jobs of different lengths', () => {
        expect(simulate({ free: 8, specs: [{ name: 'A', weight: 3, duration: 1 }, { name: 'B', weight: 1, duration: 1 }], until: 500 }))
            .toStrictEqual({ A: 6, B: 2 });

        const unequal = simulate({
            free: 8,
            specs: [{ name: 'A', weight: 3, duration: 1.7 }, { name: 'B', weight: 1, duration: 0.3 }],
            until: 500,
        });

        expect(Math.abs(unequal.A - 6)).toBeLessThan(6 * 0.02);
        expect(Math.abs(unequal.B - 2)).toBeLessThan(2 * 0.02);
    });

    test.each([
        [4, 2, 2],
        [8, 4, 4],
    ])('long and short jobs, equal weights, %i slots: %i and %i', (free, long, short) => {
        const shares = simulate({ free, specs: [{ name: 'long', weight: 1, duration: 10 }, { name: 'short', weight: 1, duration: 1 }], until: 5000 });

        expect(Math.abs(shares.long - long)).toBeLessThan(long * 0.02);
        expect(Math.abs(shares.short - short)).toBeLessThan(short * 0.02);
    });

    test('long and short jobs at 3 slots: within one slot of 1.5 each (the odd remainder goes to the long jobs)', () => {
        const shares = simulate({ free: 3, specs: [{ name: 'long', weight: 1, duration: 10 }, { name: 'short', weight: 1, duration: 1 }], until: 5000 });

        expect(Math.abs(shares.long - 1.5)).toBeLessThan(1);
        expect(shares.long).toBeCloseTo(1.9, 1);
    });

    test('6.5: groups, within one slot of the water-filling target', () => {
        const specs = [
            { name: 'T', weight: 2, duration: 1, room: 1, group: 'heavy' },
            { name: 'R', weight: 1, duration: 1, group: 'heavy' },
            { name: 'E', weight: 3, duration: 1 },
        ];

        expect(simulate({ free: 10, specs, groupCaps: { heavy: 2 }, until: 2000 })).toStrictEqual({ T: 1, R: 1, E: 8 });

        const wider = simulate({ free: 10, specs, groupCaps: { heavy: 4 }, until: 2000 });

        expect(Math.abs(wider.T - 1)).toBeLessThan(1);
        expect(Math.abs(wider.R - 2.25)).toBeLessThan(1);
        expect(Math.abs(wider.E - 6.75)).toBeLessThan(1);
    });
});

describe('chooseRows', () => {
    test('the rows of each name in FIFO order, by share', () => {
        const rows = [
            { id: 'a1', name: 'a' }, { id: 'b1', name: 'b' }, { id: 'a2', name: 'a' }, { id: 'a3', name: 'a' },
            { id: 'b2', name: 'b' }, { id: 'c1', name: 'c' },
        ];
        const names = shareNames([{ name: 'a', running: 2 }, { name: 'b' }, { name: 'c', room: 0 }]);
        const { chosen, lastTieWinner } = chooseRows({ rows, names, free: 4, base: 0, size: 3 });

        expect(chosen.map(row => row.id)).toStrictEqual(['b1', 'b2', 'a1', 'a2']);
        // b has no row left when a takes its rows: no tie
        expect(lastTieWinner).toBeNull();
    });
});

/**
 * A random claim: 2–9 requested names of up to 10 handled ones, 0–2 groups, weights 1–1000, running counts, and locked
 * rows up to each maxJobs. The claim takes what `chooseRows()` takes over all the locked rows; `replayTie()`, from the
 * claimed rows and the names with rows left only, must give its last tie.
 * @param {() => number} random
 * @returns {{ broken: object[], tied: boolean }}
 */
function checkReplay(random) {
    const int = (/** @type {number} */ max) => Math.floor(random() * (max + 1));
    const size = 2 + int(8);
    const indexes = Array.from({ length: size }, (_, index) => index);

    // A random subset of the handled names, in a random order
    for (let at = size - 1; at > 0; at--) {
        const other = int(at);

        [indexes[at], indexes[other]] = [indexes[other], indexes[at]];
    }

    const entries = indexes.slice(0, 2 + int(size - 2)).map(index => ({ index }));
    const groupRooms = Array.from({ length: int(2) }, () => 1 + int(3));
    const free = 1 + int(7);
    const base = int(size - 1);
    const requests = entries.map((entry, at) => ({
        name: `n${at}`,
        maxJobs: 1 + int(free - 1),
        running: int(3),
        weight: random() < 0.3 ? 1 + int(999) : [1, 1, 2, 3, 5, 1000][int(5)],
        group: groupRooms.length && random() < 0.6 ? int(groupRooms.length - 1) : null,
        tie: (((entry.index - base) % size) + size) % size,
    }));
    const rows = requests.flatMap(request => Array.from({ length: int(request.maxJobs) }, (_, k) => ({
        id: `${request.name}.${k}`,
        name: request.name,
    })));
    const full = chooseRows({
        rows,
        names: shareNamesOfRequests(entries, requests, [...groupRooms]),
        free,
        base,
        size,
    });

    if (!full.chosen.length) {
        return { broken: [], tied: false };
    }

    const chosenIds = new Set(full.chosen.map(row => row.id));
    const unpicked = [...new Set(rows.filter(row => !chosenIds.has(row.id)).map(row => row.name))];
    const replayed = replayTie({ entries, requests, groupRooms, jobs: full.chosen, unpicked, base, size });

    return {
        broken: replayed === full.lastTieWinner
            ? []
            : [{ entries, requests, groupRooms, free, base, size, rows, expected: full.lastTieWinner, replayed }],
        tied: full.lastTieWinner !== null,
    };
}

describe('replayTie', () => {
    test('the last tie of the full choice, from the claimed rows and the names with rows left, on 5000 random claims', () => {
        const random = seeded(17);
        const results = Array.from({ length: 5000 }, () => checkReplay(random));

        expect(results.flatMap(result => result.broken)).toStrictEqual([]);
        // The cases test ties
        expect(results.filter(result => result.tied).length).toBeGreaterThan(500);
    });
});
