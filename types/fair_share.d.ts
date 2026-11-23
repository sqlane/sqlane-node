export type ShareLane = {
    name: string;
    /**
     * Its position in the order of the lanes.add() calls: the order of the ties.
     */
    index: number;
    /**
     * 1–1000.
     */
    weight: number;
    /**
     * Its jobs that run in this instance.
     */
    running: number;
    /**
     * Its local limits, each shared by its lanes: its max minus its running.
     */
    limits: {
        room: number;
    }[];
    /**
     * The units that can start: locked rows, candidates, or Infinity in a plan.
     */
    available: number;
};
export type Ranked = {
    index: number;
    weight: number;
    running: number;
};
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
export declare function fill<T>({ lanes, free, base, size, take }: {
    lanes: ShareLane[];
    free: number;
    base: number;
    size: number;
    take: (lane: ShareLane) => T | null;
}): {
    chosen: T[];
    lastTieWinner: number | null;
};
/**
 * Sorts the lanes in place, in the order of their current share, then the tie order: a plan serves a prefix of this
 * order.
 * @template {Ranked} T
 * @param {T[]} lanes
 * @param {number} base
 * @param {number} size
 * @returns {T[]} The same array.
 */
export declare function rankLanes<T extends Ranked>(lanes: T[], base: number, size: number): T[];
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
export declare function chooseRows<T extends {
    lane: string;
}>({ rows, lanes, free, base, size }: {
    rows: T[];
    lanes: ShareLane[];
    free: number;
    base: number;
    size: number;
}): {
    chosen: T[];
    lastTieWinner: number | null;
};
/**
 * The lanes of the requests of a claim, with the counts and the limit rooms that the claim was given.
 * @param {{ index: number }[]} entries Of the requests, in their order: their handlers.
 * @param {import('./store/store.js').DueRequest[]} requests
 * @param {number[]} limitRooms
 * @param {(request: import('./store/store.js').DueRequest) => boolean} [keep]
 * @returns {ShareLane[]}
 */
export declare function shareLanesOfRequests(entries: {
    index: number;
}[], requests: import('./store/store.js').DueRequest[], limitRooms: number[], keep?: (request: import('./store/store.js').DueRequest) => boolean): ShareLane[];
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
export declare function replayTie({ entries, requests, limitRooms, jobs, unpicked, base, size }: {
    entries: {
        index: number;
    }[];
    requests: import('./store/store.js').DueRequest[];
    limitRooms: number[];
    jobs: {
        lane: string;
    }[];
    unpicked: string[];
    base: number;
    size: number;
}): number | null;
