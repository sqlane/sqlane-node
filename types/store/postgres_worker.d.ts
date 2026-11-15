export type Executor = import('../types.js').Executor;
export type ProbeRow = import('./store.js').ProbeRow;
export type Candidate = import('./store.js').Candidate;
export type ClaimParams = import('./store.js').ClaimParams;
export type ClaimedJob = import('./store.js').ClaimedJob;
/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./store.js').ProbeRow} ProbeRow */
/** @typedef {import('./store.js').Candidate} Candidate */
/** @typedef {import('./store.js').ClaimParams} ClaimParams */
/** @typedef {import('./store.js').ClaimedJob} ClaimedJob */
/** The due jobs of each name with global limits that a search of candidates reads */
export declare const LIMIT_WINDOW_SIZE = 500;
/**
 * The next due time of each given job name with pending jobs; null: of each job name. PostgreSQL has no loose index
 * scan: for all names, a recursive CTE skips from one pending name to the next on the partial index, two index probes
 * per pending name.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[] | null} names
 * @returns {Promise<ProbeRow[]>}
 */
export declare function probe(executor: Executor, p: string, names: string[] | null): Promise<ProbeRow[]>;
/**
 * The due jobs of names with global limits, oldest first: at most `limit` of each name whose keys have room, and those
 * with a full key, which the claim blocks. A key is full when its held slots reach the max of the job.
 * @param {Executor} executor
 * @param {string} p
 * @param {Map<string, number>} limitsByName
 * @returns {Promise<import('./store.js').FoundCandidates>}
 */
export declare function findCandidates(executor: Executor, p: string, limitsByName: Map<string, number>): Promise<import('./store.js').FoundCandidates>;
/**
 * Claims due jobs among the candidates, and blocks those with a full key. Call it in a queue transaction.
 * @param {Executor} executor
 * @param {string} p
 * @param {ClaimParams} params
 * @returns {Promise<import('./store.js').ClaimResult>}
 */
export declare function claim(executor: Executor, p: string, { candidateIds, fullIds, lockToken, lockedBy, leaseMs, pick }: ClaimParams): Promise<import('./store.js').ClaimResult>;
/**
 * Finds, chooses, claims and reads the due jobs of names without global limits, in one statement (a transaction of its
 * own). Each name locks its oldest due jobs that no other claim holds (SKIP LOCKED), up to its `maxJobs`. The locked
 * rows are taken in the order of their share, `(running + rank in the name − 1) / weight`, then the tie order, within
 * the free slots of the local limits and of the instance: the order of `fill()` (fair_share.js), row by row. Then the
 * next due time of each requested name, among its pending jobs that this claim did not take.
 * @param {Executor} executor Outside a transaction.
 * @param {string} p
 * @param {import('./store.js').ClaimDueParams} params
 * @returns {Promise<import('./store.js').ClaimDueResult>} The jobs in the order of run_at.
 */
export declare function claimDue(executor: Executor, p: string, { requests, limitRooms, free, lockToken, lockedBy, leaseMs }: import('./store.js').ClaimDueParams): Promise<import('./store.js').ClaimDueResult>;
/**
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} ids
 * @returns {Promise<Map<string, unknown>>} The payloads by job id, as JSON gives them back.
 */
export declare function readPayloads(executor: Executor, p: string, ids: string[]): Promise<Map<string, unknown>>;
