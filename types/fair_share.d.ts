export type ShareName = {
    name: string;
    /**
     * Its position in the order of the handle() calls: the order of the ties.
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
     * Its maxConcurrency minus running; Infinity without one. At least 0.
     */
    room: number;
    /**
     * Shared by the names of one group: its maxConcurrency minus its running.
     */
    group: {
        room: number;
    } | null;
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
export declare function fill<T>({ names, free, base, size, take }: {
    names: ShareName[];
    free: number;
    base: number;
    size: number;
    take: (name: ShareName) => T | null;
}): {
    chosen: T[];
    lastTieWinner: number | null;
};
/**
 * Sorts the names in place, in the order of their current share, then the tie order: a plan serves a prefix of this
 * order.
 * @template {Ranked} T
 * @param {T[]} names
 * @param {number} base
 * @param {number} size
 * @returns {T[]} The same array.
 */
export declare function rankNames<T extends Ranked>(names: T[], base: number, size: number): T[];
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
export declare function chooseRows<T extends {
    name: string;
}>({ rows, names, free, base, size }: {
    rows: T[];
    names: ShareName[];
    free: number;
    base: number;
    size: number;
}): {
    chosen: T[];
    lastTieWinner: number | null;
};
/**
 * The names of the requests of a claim, with the counts and the group rooms that the claim was given. Their own room
 * is not needed: their maxJobs held their locked rows under it.
 * @param {{ index: number }[]} entries Of the requests, in their order: their handlers.
 * @param {import('./store/store.js').DueRequest[]} requests
 * @param {number[]} groupRooms
 * @param {(request: import('./store/store.js').DueRequest) => boolean} [keep]
 * @returns {ShareName[]}
 */
export declare function shareNamesOfRequests(entries: {
    index: number;
}[], requests: import('./store/store.js').DueRequest[], groupRooms: number[], keep?: (request: import('./store/store.js').DueRequest) => boolean): ShareName[];
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
export declare function replayTie({ entries, requests, groupRooms, jobs, unpicked, base, size }: {
    entries: {
        index: number;
    }[];
    requests: import('./store/store.js').DueRequest[];
    groupRooms: number[];
    jobs: {
        name: string;
    }[];
    unpicked: string[];
    base: number;
    size: number;
}): number | null;
