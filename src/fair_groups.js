// How the slots of a lane are shared between its fair groups, in one runner: the due group with the fewest jobs running
// here first; ties in the rotation of the groups (byte order, the null group last), from a pointer after the last group
// that won a tie. The same water-filling as between lanes (fill(), fair_share.js), with weight 1 and no limits.
import { fill } from './fair_share.js';

/** The most groups that a claim requests per slot of the lane: the extra groups cover rows held by other claims */
const GROUPS_PER_SLOT = 4;
/** And at most this many more than the slots: a big lane does not lock 4 × its slots of groups */
const MAX_EXTRA_GROUPS = 8;
/** Sorts after every group (printable ASCII): the null group comes last in the rotation */
const NULL_GROUP_ORDER = '\u007F';

/**
 * A fair group: a string, or null for the jobs without one (one group together). The pointer of a lane is the group
 * after which the rotation starts; undefined: none yet (the first claim draws one).
 * @typedef {string | null} FairGroup
 */

/**
 * A group that a claim of the lane requests.
 * @typedef {object} GroupRequest
 * @property {FairGroup} group
 * @property {number} running Its jobs that run in this runner.
 * @property {number} tie Its place in the rotation, from the pointer: 0 first.
 * @property {number} maxJobs The rows of the group to lock: its share of the slots, + 1 for a group with fewer due rows
 *     than its share.
 */

/**
 * @param {FairGroup} group
 * @returns {string} Its key in the rotation: byte order, null last.
 */
function orderKey(group) {
    return group ?? NULL_GROUP_ORDER;
}

/**
 * @param {readonly FairGroup[]} groups Distinct.
 * @returns {FairGroup[]} In the order of the rotation, from the first group.
 */
function rotation(groups) {
    return groups.toSorted((a, b) => (orderKey(a) < orderKey(b) ? -1 : 1));
}

/**
 * @param {FairGroup[]} rotated
 * @param {FairGroup | undefined} pointer
 * @param {() => number} random
 * @returns {number} The position in the rotation where the ties start: the first group after the pointer; a random one
 *     without a pointer.
 */
function baseOf(rotated, pointer, random) {
    if (pointer === undefined) {
        return Math.floor(random() * rotated.length);
    }

    const after = rotated.findIndex(group => orderKey(group) > orderKey(pointer));

    return after === -1 ? 0 : after;
}

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
export function requestGroups({ dueGroups, runningOf, pointer, maxJobs, random }) {
    if (!dueGroups.length || maxJobs <= 0) {
        return [];
    }

    const rotated = rotation(dueGroups);
    const base = baseOf(rotated, pointer, random);
    const ranked = rotated
        .map((group, at) => ({ group, running: runningOf(group), tie: (at - base + rotated.length) % rotated.length }))
        .toSorted((a, b) => (a.running - b.running) || (a.tie - b.tie))
        .slice(0, Math.min(GROUPS_PER_SLOT * maxJobs, maxJobs + MAX_EXTRA_GROUPS));
    /** @type {Map<FairGroup, number>} */
    const shares = new Map();

    fill({
        lanes: ranked.map(request => shareGroup(request, Infinity)),
        free: maxJobs,
        base: 0,
        size: rotated.length,
        take: (lane) => {
            const group = groupOfName(lane.name);

            shares.set(group, (shares.get(group) ?? 0) + 1);

            return group;
        },
    });

    return ranked.map(({ group, running, tie }) => ({ group, running, tie, maxJobs: (shares.get(group) ?? 0) + 1 }));
}

/**
 * @param {{ group: FairGroup, running: number, tie: number }} request
 * @param {number} available
 * @returns {import('./fair_share.js').ShareLane} The group as a lane of fill(): weight 1, no limits, its tie as its
 *     index (base 0).
 */
function shareGroup({ group, running, tie }, available) {
    return { name: nameOf(group), index: tie, weight: 1, running, limits: [], available };
}

/**
 * @param {FairGroup} group
 * @returns {string} Its name as a lane of fill(): the null group is '', which no group can be.
 */
function nameOf(group) {
    return group ?? '';
}

/**
 * @param {string} name
 * @returns {FairGroup}
 */
function groupOfName(name) {
    return name === '' ? null : name;
}

/**
 * The locked rows of a grouped lane in the order of its share: the k-th unit of fill() over its groups is its k-th row.
 * FIFO within a group.
 * @template {{ fairGroup: FairGroup }} T
 * @param {readonly T[]} rows Of the lane, in the order of run_at, id.
 * @param {readonly GroupRequest[]} requests Of the claim: their running counts and ties.
 * @returns {T[]}
 */
export function orderGroupRows(rows, requests) {
    return fillGroups(rows, requests, rows.length).chosen;
}

/**
 * @template {{ fairGroup: FairGroup }} T
 * @param {readonly T[]} rows
 * @param {readonly GroupRequest[]} requests
 * @param {number} free
 * @returns {{ chosen: T[], lastTieWinner: number | null }}
 */
function fillGroups(rows, requests, free) {
    /** @type {Map<FairGroup, T[]>} */
    const rowsByGroup = new Map(requests.map(request => [request.group, []]));

    for (const row of rows) {
        rowsByGroup.get(row.fairGroup)?.push(row);
    }

    return fill({
        lanes: requests.map(request => shareGroup(request, rowsByGroup.get(request.group)?.length ?? 0)),
        free,
        base: 0,
        size: Math.max(...requests.map(request => request.tie)) + 1,
        take: lane => rowsByGroup.get(groupOfName(lane.name))?.shift() ?? null,
    });
}

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
export function movedPointer({ requests, claimed, left, pointer }) {
    if (!claimed.length) {
        return pointer;
    }

    const leftRows = left.map(group => ({ fairGroup: group }));
    const { lastTieWinner } = fillGroups([...claimed, ...leftRows], requests, claimed.length);

    if (lastTieWinner === null) {
        return pointer;
    }

    return /** @type {GroupRequest} */ (requests.find(request => request.tie === lastTieWinner)).group;
}

/**
 * The locked rows of a claim of due jobs, with the rows of each grouped lane in the order of its share
 * (`orderGroupRows`), the other lanes as they are: `chooseRows()` takes the rows of each lane in their order. MySQL and
 * MariaDB, whose runner chooses among the locked rows.
 * @template {{ lane: string, fairGroup: FairGroup }} T
 * @param {readonly T[]} rows In the order of run_at, id.
 * @param {readonly { name: string, groups?: readonly GroupRequest[] }[]} requests Of the claim.
 * @returns {T[]}
 */
export function orderDueRows(rows, requests) {
    const grouped = requests.filter(request => request.groups);

    if (!grouped.length) {
        return [...rows];
    }

    const groupedNames = new Set(grouped.map(request => request.name));
    const ordered = rows.filter(row => !groupedNames.has(row.lane));

    for (const request of grouped) {
        ordered.push(...orderGroupRows(rows.filter(row => row.lane === request.name),
            /** @type {GroupRequest[]} */ (request.groups)));
    }

    return ordered;
}
