export type FairGroup = string | null;
export type GroupRequest = {
    group: FairGroup;
    /**
     * Its jobs that run in this runner.
     */
    running: number;
    /**
     * Its place in the rotation, from the pointer: 0 first.
     */
    tie: number;
    /**
     * The rows of the group to lock: its share of the slots, + 1 for a group with fewer due rows
     * than its share.
     */
    maxJobs: number;
};
/**
 * The groups that a claim of the lane requests, and the rows of each to lock.
 * @param {object} params
 * @param {readonly FairGroup[]} params.dueGroups The groups of the lane with a due job. Distinct.
 * @param {(group: FairGroup) => number} params.runningOf The jobs of a group that run in this runner.
 * @param {FairGroup | undefined} params.pointer The pointer of the lane.
 * @param {number} params.maxJobs The jobs of the lane that the claim can start: its slots.
 * @param {() => number} params.random For the first pointer of the lane.
 * @returns {GroupRequest[]} The fewest running first, then the rotation: the first ones get the slots.
 */
export declare function requestGroups({ dueGroups, runningOf, pointer, maxJobs, random }: {
    dueGroups: readonly FairGroup[];
    runningOf: (group: FairGroup) => number;
    pointer: FairGroup | undefined;
    maxJobs: number;
    random: () => number;
}): GroupRequest[];
/**
 * The locked rows of a grouped lane in the order of its share: the k-th unit of fill() over its groups is its k-th row.
 * FIFO within a group.
 * @template {{ fairGroup: FairGroup }} T
 * @param {readonly T[]} rows Of the lane, in the order of run_at, id.
 * @param {readonly GroupRequest[]} requests Of the claim: their running counts and ties.
 * @returns {T[]}
 */
export declare function orderGroupRows<T extends {
    fairGroup: FairGroup;
}>(rows: readonly T[], requests: readonly GroupRequest[]): T[];
/**
 * The pointer of the lane after a claim: past the last group that won a tie, as fill() moves the pointer of the lanes.
 * Replays the choice over the claimed rows, plus one row of each group that had a locked row left: the claimed rows are
 * a prefix of the order of `orderGroupRows`, so the replay makes the same ties.
 * @param {object} params
 * @param {readonly GroupRequest[]} params.requests Of the claim.
 * @param {readonly { fairGroup: FairGroup }[]} params.claimed The claimed rows of the lane.
 * @param {readonly FairGroup[]} params.left The groups with a locked row that the claim did not take.
 * @param {FairGroup | undefined} params.pointer The pointer before the claim.
 * @returns {FairGroup | undefined} The pointer after it: the same without a tie.
 */
export declare function movedPointer({ requests, claimed, left, pointer }: {
    requests: readonly GroupRequest[];
    claimed: readonly {
        fairGroup: FairGroup;
    }[];
    left: readonly FairGroup[];
    pointer: FairGroup | undefined;
}): FairGroup | undefined;
/**
 * The locked rows of a claim of due jobs, with the rows of each grouped lane in the order of its share
 * (`orderGroupRows`) and cut at its `maxJobs` (it locks more: the extra groups and the slack), the other lanes as they
 * are: `chooseRows()` takes the rows of each lane in their order. MySQL and MariaDB, whose runner chooses among the
 * locked rows; PostgreSQL makes the same cut in SQL.
 * @template {{ lane: string, fairGroup: FairGroup }} T
 * @param {readonly T[]} rows In the order of run_at, id.
 * @param {readonly { name: string, maxJobs: number, groups?: readonly GroupRequest[] }[]} requests Of the claim.
 * @returns {T[]}
 */
export declare function orderDueRows<T extends {
    lane: string;
    fairGroup: FairGroup;
}>(rows: readonly T[], requests: readonly {
    name: string;
    maxJobs: number;
    groups?: readonly GroupRequest[];
}[]): T[];
