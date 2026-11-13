// How free slots are shared between job names: the lowest running / fairShareWeight first, under the caps of the
// name, its concurrency group and the instance; ties round-robin. See docs/api.md › How free slots are shared.

/**
 * A job name in a choice.
 * @typedef {object} ShareName
 * @property {string} name
 * @property {number} index Its position in the order of the handle() calls: the order of the ties.
 * @property {number} weight 1–1000.
 * @property {number} running Its jobs that run in this instance.
 * @property {number} room Its maxConcurrency minus running; Infinity without one. At least 0.
 * @property {{ room: number } | null} group Shared by the names of one group: its maxConcurrency minus its running.
 * @property {number} available The units that can start: locked rows, candidates, or Infinity in a plan.
 */

/**
 * What the order of the shares reads of a name: a ShareName, or a handler.
 * @typedef {{ index: number, weight: number, running: number }} Ranked
 */

/**
 * @param {Ranked} a
 * @param {Ranked} b
 * @returns {number} Below 0: a has the lower share. Exact: integers, no division.
 */
function compareShares(a, b) {
    return (a.running * b.weight) - (b.running * a.weight);
}

/**
 * @param {ShareName} name
 * @returns {boolean} It can take a slot now.
 */
function isEligible(name) {
    return name.room > 0 && name.available > 0 && (name.group === null || name.group.room > 0);
}

/**
 * A binary heap of names: the lowest share first, then the tie order.
 */
class NameHeap {
    /**
     * @param {(name: ShareName) => number} tieOrder
     */
    constructor(tieOrder) {
        /** @type {ShareName[]} */
        this.items = [];
        this.tieOrder = tieOrder;
    }

    /**
     * @param {ShareName} a
     * @param {ShareName} b
     * @returns {boolean} a comes before b.
     */
    before(a, b) {
        const byShare = compareShares(a, b);

        return byShare < 0 || (byShare === 0 && this.tieOrder(a) < this.tieOrder(b));
    }

    /** @param {ShareName} name */
    push(name) {
        const { items } = this;

        items.push(name);

        for (let index = items.length - 1; index > 0;) {
            const parent = (index - 1) >> 1;

            if (!this.before(items[index], items[parent])) {
                break;
            }

            [items[index], items[parent]] = [items[parent], items[index]];
            index = parent;
        }
    }

    /** @returns {ShareName | undefined} */
    peek() {
        return this.items[0];
    }

    /** @returns {ShareName | undefined} */
    pop() {
        const { items } = this;
        const top = items[0];
        const last = items.pop();

        if (items.length && last) {
            items[0] = last;

            for (let index = 0; ;) {
                const left = (2 * index) + 1;
                const right = left + 1;
                let smallest = index;

                if (left < items.length && this.before(items[left], items[smallest])) {
                    smallest = left;
                }

                if (right < items.length && this.before(items[right], items[smallest])) {
                    smallest = right;
                }

                if (smallest === index) {
                    break;
                }

                [items[index], items[smallest]] = [items[smallest], items[index]];
                index = smallest;
            }
        }

        return top;
    }

    /** @returns {number} */
    get size() {
        return this.items.length;
    }
}

/**
 * @param {number} base
 * @param {number} size
 * @returns {(name: Ranked) => number} The tie order: (index − base) mod size.
 */
function tieOrderOf(base, size) {
    const span = Math.max(size, 1);

    return name => (((name.index - base) % span) + span) % span;
}

/**
 * Gives the free slots, one at a time, to the eligible name with the lowest running / weight; ties in the order of
 * (index − base) mod size. The base is fixed for the call. Mutates running, room, available and the group rooms.
 * @template T
 * @param {object} params
 * @param {ShareName[]} params.names
 * @param {number} params.free The free slots of the instance.
 * @param {number} params.base The tie pointer.
 * @param {number} params.size The handled names: the span of the tie order.
 * @param {(name: ShareName) => T | null} params.take The next unit of the name; null: it has none.
 * @returns {{ chosen: T[], lastTieWinner: number | null }} `lastTieWinner`: the index of the last name that won a
 *     slot against an equal share.
 */
export function fill({ names, free, base, size, take }) {
    const heap = new NameHeap(tieOrderOf(base, size));
    /** @type {T[]} */
    const chosen = [];
    /** @type {number | null} */
    let lastTieWinner = null;
    let left = free;

    for (const name of names) {
        if (isEligible(name)) {
            heap.push(name);
        }
    }

    /** Drops the names at the top whose group filled up since they were pushed: they cannot take a slot again */
    const dropFull = () => {
        while (heap.size && !isEligible(/** @type {ShareName} */ (heap.peek()))) {
            heap.pop();
        }
    };

    dropFull();

    while (left > 0 && heap.size) {
        const best = /** @type {ShareName} */ (heap.pop());

        dropFull();

        const next = heap.peek();
        const tied = next !== undefined && compareShares(next, best) === 0;
        const unit = take(best);

        if (unit === null) {
            best.available = 0;
            continue;
        }

        chosen.push(unit);
        left--;
        best.running++;
        best.room--;
        best.available--;

        if (best.group) {
            best.group.room--;
        }

        if (tied) {
            lastTieWinner = best.index;
        }

        if (isEligible(best)) {
            heap.push(best);
        }

        dropFull();
    }

    return { chosen, lastTieWinner };
}

/**
 * Sorts the names in place, in the order of their current share, then the tie order: a plan serves a prefix of this
 * order.
 * @template {Ranked} T
 * @param {T[]} names
 * @param {number} base
 * @param {number} size
 * @returns {T[]} The same array.
 */
export function rankNames(names, base, size) {
    const tieOrder = tieOrderOf(base, size);

    names.sort((a, b) => compareShares(a, b) || tieOrder(a) - tieOrder(b));

    return names;
}

/**
 * Chooses among locked rows: the rows of each name in FIFO order are its units.
 * @template {{ name: string }} T
 * @param {object} params
 * @param {T[]} params.rows In the order of run_at, id.
 * @param {ShareName[]} params.names Their `available` is set from the rows.
 * @param {number} params.free
 * @param {number} params.base
 * @param {number} params.size
 * @returns {{ chosen: T[], lastTieWinner: number | null }}
 */
export function chooseRows({ rows, names, free, base, size }) {
    /** @type {Map<string, T[]>} */
    const rowsByName = new Map(names.map(name => [name.name, []]));

    for (const row of rows) {
        rowsByName.get(row.name)?.push(row);
    }

    for (const name of names) {
        name.available = /** @type {T[]} */ (rowsByName.get(name.name)).length;
    }

    return fill({
        names,
        free,
        base,
        size,
        take: name => /** @type {T[]} */ (rowsByName.get(name.name)).shift() ?? null,
    });
}

/**
 * The names of the requests of a claim, with the counts and the group rooms that the claim was given. Their own room
 * is not needed: their maxJobs held their locked rows under it.
 * @param {{ index: number }[]} entries Of the requests, in their order: their handlers.
 * @param {import('./store/store.js').DueRequest[]} requests
 * @param {number[]} groupRooms
 * @param {(request: import('./store/store.js').DueRequest) => boolean} [keep]
 * @returns {ShareName[]}
 */
export function shareNamesOfRequests(entries, requests, groupRooms, keep) {
    /** @type {({ room: number } | undefined)[]} */
    const groups = [];
    /** @type {ShareName[]} */
    const names = [];

    for (const [at, request] of requests.entries()) {
        if (keep && !keep(request)) {
            continue;
        }

        /** @type {{ room: number } | null} */
        let group = null;

        if (request.group !== null) {
            group = groups[request.group] ?? { room: groupRooms[request.group] };
            groups[request.group] = group;
        }

        names.push({
            name: request.name,
            index: entries[at].index,
            weight: request.weight,
            running: request.running,
            room: Infinity,
            group,
            available: Infinity,
        });
    }

    return names;
}

/**
 * The last tie of a choice made in SQL: `fill()` over the claimed rows, with one more row of each name that the claim
 * left a locked row of, under the counts and rooms that the claim was given, makes the same choice and the same ties.
 * Each name has a row left in the replay exactly when it has one in the claim. A name with no claimed row and a share
 * above every claimed share is left out: it never took a slot, nor tied with the name that did.
 * @param {object} params
 * @param {{ index: number }[]} params.entries Of the requests, in their order: their handlers.
 * @param {import('./store/store.js').DueRequest[]} params.requests
 * @param {number[]} params.groupRooms
 * @param {{ name: string }[]} params.jobs The claimed jobs.
 * @param {string[]} params.unpicked The names with a locked row that the claim did not take.
 * @param {number} params.base
 * @param {number} params.size
 * @returns {number | null}
 */
export function replayTie({ entries, requests, groupRooms, jobs, unpicked, base, size }) {
    /** @type {Map<string, number>} Of each name: 2 × its claimed rows, + 1 with rows left */
    const rowsOf = new Map();

    for (const job of jobs) {
        rowsOf.set(job.name, (rowsOf.get(job.name) ?? 0) + 2);
    }

    for (const name of unpicked) {
        rowsOf.set(name, (rowsOf.get(name) ?? 0) | 1);
    }

    // The highest share at which a row was claimed: topRunning / topWeight
    let topRunning = 0;
    let topWeight = 1;

    for (const request of requests) {
        const count = (rowsOf.get(request.name) ?? 0) >> 1;

        if (count && (request.running + count - 1) * topWeight > topRunning * request.weight) {
            topRunning = request.running + count - 1;
            topWeight = request.weight;
        }
    }

    // A name with only rows left, above the top share: it never took a slot nor tied
    const names = shareNamesOfRequests(entries, requests, groupRooms, (request) => {
        const rows = rowsOf.get(request.name) ?? 0;

        return rows > 1 || (rows === 1 && request.running * topWeight <= topRunning * request.weight);
    });

    for (const name of names) {
        const rows = /** @type {number} */ (rowsOf.get(name.name));

        // One more unit for its rows left
        name.available = (rows >> 1) + (rows & 1);
    }

    if (names.length < 2) {
        return null;
    }

    return fill({ names, free: jobs.length, base, size, take: () => true }).lastTieWinner;
}
