// How free slots are shared between lanes: the lowest running / fairShareWeight first, under the local
// concurrency limits of the lane and the runner's cap; ties round-robin. See docs/api.md › How free slots are shared.

/**
 * A lane in a choice.
 * @typedef {object} ShareLane
 * @property {string} name
 * @property {number} index Its position in the order of the mounts: the order of the ties.
 * @property {number} weight 1–1000.
 * @property {number} running Its jobs that run in this instance.
 * @property {{ room: number }[]} limits Its local limits, each shared by its lanes: its max minus its running.
 * @property {number} available The units that can start: locked rows, candidates, or Infinity in a plan.
 */

/**
 * What the order of the shares reads of a lane: a ShareLane, or a handler.
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
 * @param {ShareLane} lane
 * @returns {boolean} It can take a slot now.
 */
function isEligible(lane) {
    return lane.available > 0 && lane.limits.every(limit => limit.room > 0);
}

/**
 * A binary heap of lanes: the lowest share first, then the tie order.
 */
class LaneHeap {
    /**
     * @param {(lane: ShareLane) => number} tieOrder
     */
    constructor(tieOrder) {
        /** @type {ShareLane[]} */
        this.items = [];
        this.tieOrder = tieOrder;
    }

    /**
     * @param {ShareLane} a
     * @param {ShareLane} b
     * @returns {boolean} a comes before b.
     */
    before(a, b) {
        const byShare = compareShares(a, b);

        return byShare < 0 || (byShare === 0 && this.tieOrder(a) < this.tieOrder(b));
    }

    /** @param {ShareLane} lane */
    push(lane) {
        const { items } = this;

        items.push(lane);

        for (let index = items.length - 1; index > 0;) {
            const parent = (index - 1) >> 1;

            if (!this.before(items[index], items[parent])) {
                break;
            }

            [items[index], items[parent]] = [items[parent], items[index]];
            index = parent;
        }
    }

    /** @returns {ShareLane | undefined} */
    peek() {
        return this.items[0];
    }

    /** @returns {ShareLane | undefined} */
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
 * @returns {(lane: Ranked) => number} The tie order: (index − base) mod size.
 */
function tieOrderOf(base, size) {
    const span = Math.max(size, 1);

    return lane => (((lane.index - base) % span) + span) % span;
}

/**
 * Gives the free slots, one at a time, to the eligible lane with the lowest running / weight; ties in the order of
 * (index − base) mod size. The base is fixed for the call. Mutates running, available and the limit rooms.
 * @template T
 * @param {object} params
 * @param {ShareLane[]} params.lanes
 * @param {number} params.free The free slots of the instance.
 * @param {number} params.base The tie pointer.
 * @param {number} params.size The added lanes: the span of the tie order.
 * @param {(lane: ShareLane) => T | null} params.take The next unit of the lane; null: it has none.
 * @returns {{ chosen: T[], lastTieWinner: number | null }} `lastTieWinner`: the index of the last lane that won a
 *     slot against an equal share.
 */
export function fill({ lanes, free, base, size, take }) {
    const heap = new LaneHeap(tieOrderOf(base, size));
    /** @type {T[]} */
    const chosen = [];
    /** @type {number | null} */
    let lastTieWinner = null;
    let left = free;

    for (const lane of lanes) {
        if (isEligible(lane)) {
            heap.push(lane);
        }
    }

    /** Drops the lanes at the top whose limit filled up since they were pushed: they cannot take a slot again */
    const dropFull = () => {
        while (heap.size && !isEligible(/** @type {ShareLane} */ (heap.peek()))) {
            heap.pop();
        }
    };

    dropFull();

    while (left > 0 && heap.size) {
        const best = /** @type {ShareLane} */ (heap.pop());

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
        best.available--;

        for (const limit of best.limits) {
            limit.room--;
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
 * Sorts the lanes in place, in the order of their current share, then the tie order: a plan serves a prefix of this
 * order.
 * @template {Ranked} T
 * @param {T[]} lanes
 * @param {number} base
 * @param {number} size
 * @returns {T[]} The same array.
 */
export function rankLanes(lanes, base, size) {
    const tieOrder = tieOrderOf(base, size);

    lanes.sort((a, b) => compareShares(a, b) || tieOrder(a) - tieOrder(b));

    return lanes;
}

/**
 * Chooses among locked rows: the rows of each lane in FIFO order are its units.
 * @template {{ lane: string }} T
 * @param {object} params
 * @param {T[]} params.rows In the order of run_at, id.
 * @param {ShareLane[]} params.lanes Their `available` is set from the rows.
 * @param {number} params.free
 * @param {number} params.base
 * @param {number} params.size
 * @returns {{ chosen: T[], lastTieWinner: number | null }}
 */
export function chooseRows({ rows, lanes, free, base, size }) {
    /** @type {Map<string, T[]>} */
    const rowsByLane = new Map(lanes.map(lane => [lane.name, []]));

    for (const row of rows) {
        rowsByLane.get(row.lane)?.push(row);
    }

    for (const lane of lanes) {
        lane.available = /** @type {T[]} */ (rowsByLane.get(lane.name)).length;
    }

    return fill({
        lanes,
        free,
        base,
        size,
        take: lane => /** @type {T[]} */ (rowsByLane.get(lane.name)).shift() ?? null,
    });
}

/**
 * The lanes of the requests of a claim, with the counts and the limit rooms that the claim was given.
 * @param {{ index: number }[]} entries Of the requests, in their order: their handlers.
 * @param {import('./store/store.js').DueRequest[]} requests
 * @param {number[]} limitRooms
 * @param {(request: import('./store/store.js').DueRequest) => boolean} [keep]
 * @returns {ShareLane[]}
 */
export function shareLanesOfRequests(entries, requests, limitRooms, keep) {
    /** @type {{ room: number }[]} */
    const limits = limitRooms.map(room => ({ room }));
    /** @type {ShareLane[]} */
    const lanes = [];

    for (const [at, request] of requests.entries()) {
        if (keep && !keep(request)) {
            continue;
        }

        lanes.push({
            name: request.name,
            index: entries[at].index,
            weight: request.weight,
            running: request.running,
            limits: request.limits.map(limit => limits[limit]),
            available: Infinity,
        });
    }

    return lanes;
}

/**
 * The last tie of a choice made in SQL: `fill()` over the claimed rows, with one more row of each lane that the claim
 * left a locked row of, under the counts and rooms that the claim was given, makes the same choice and the same ties.
 * Each lane has a row left in the replay exactly when it has one in the claim. A lane with no claimed row and a share
 * above every claimed share is left out: it never took a slot, nor tied with the lane that did.
 * @param {object} params
 * @param {{ index: number }[]} params.entries Of the requests, in their order: their handlers.
 * @param {import('./store/store.js').DueRequest[]} params.requests
 * @param {number[]} params.limitRooms
 * @param {{ lane: string }[]} params.jobs The claimed jobs.
 * @param {string[]} params.unpicked The lanes with a locked row that the claim did not take.
 * @param {number} params.base
 * @param {number} params.size
 * @returns {number | null}
 */
export function replayTie({ entries, requests, limitRooms, jobs, unpicked, base, size }) {
    /** @type {Map<string, number>} Of each lane: 2 × its claimed rows, + 1 with rows left */
    const rowsOf = new Map();

    for (const job of jobs) {
        rowsOf.set(job.lane, (rowsOf.get(job.lane) ?? 0) + 2);
    }

    for (const lane of unpicked) {
        rowsOf.set(lane, (rowsOf.get(lane) ?? 0) | 1);
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

    // A lane with only rows left, above the top share: it never took a slot nor tied
    const lanes = shareLanesOfRequests(entries, requests, limitRooms, (request) => {
        const rows = rowsOf.get(request.name) ?? 0;

        return rows > 1 || (rows === 1 && request.running * topWeight <= topRunning * request.weight);
    });

    for (const lane of lanes) {
        const rows = /** @type {number} */ (rowsOf.get(lane.name));

        // One more unit for its rows left
        lane.available = (rows >> 1) + (rows & 1);
    }

    if (lanes.length < 2) {
        return null;
    }

    return fill({ lanes, free: jobs.length, base, size, take: () => true }).lastTieWinner;
}
