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
/** The due jobs of each name with mutex keys that the FIFO of the mutex keys reads */
export declare const MUTEX_WINDOW_SIZE = 500;
/** The first due jobs of a key among which the FIFO finds the oldest of a name with mutex keys */
export declare const KEY_WINDOW_SIZE = 100;
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
 * The names whose jobs may start after a release of the keys: of the oldest due job of each key.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} keys
 * @param {string[]} namesWithKeys The handled names whose definition has mutex keys.
 * @returns {Promise<string[]>}
 */
export declare function namesWaitingFor(executor: Executor, p: string, keys: string[], namesWithKeys: string[]): Promise<string[]>;
/**
 * The due jobs that can start now, oldest first: at most `limit` of each name. A job of a name with mutex keys waits
 * if one of its keys is held, or an older due job of such a name has it (FIFO per key, from the job_keys).
 * @param {Executor} executor
 * @param {string} p
 * @param {Map<string, number>} limitsByName
 * @param {string[]} namesWithKeys The handled names whose definition has mutex keys.
 * @returns {Promise<Candidate[]>}
 */
export declare function findCandidates(executor: Executor, p: string, limitsByName: Map<string, number>, namesWithKeys: string[]): Promise<Candidate[]>;
/**
 * Claims due jobs among the candidates. Call it in a queue transaction.
 * @param {Executor} executor
 * @param {string} p
 * @param {ClaimParams} params
 * @returns {Promise<ClaimedJob[]>} In the order of run_at.
 */
export declare function claim(executor: Executor, p: string, { candidateIds, lockToken, lockedBy, leaseMs, pick }: ClaimParams): Promise<ClaimedJob[]>;
/**
 * Finds, chooses, claims and reads the due jobs of names without mutex keys, in one statement (a transaction of its
 * own). Each name locks its oldest due jobs that no other claim holds (SKIP LOCKED), up to its `maxJobs`. The locked
 * rows are taken in the order of their share, `(running + rank in the name − 1) / weight`, then the tie order, within
 * the free slots of the groups and of the instance: the order of `fill()` (fair_share.js), row by row. Then the next
 * due time of each requested name, among its pending jobs that this claim did not take.
 * @param {Executor} executor Outside a transaction.
 * @param {string} p
 * @param {import('./store.js').ClaimDueParams} params
 * @returns {Promise<import('./store.js').ClaimDueResult>} The jobs in the order of run_at.
 */
export declare function claimDue(executor: Executor, p: string, { requests, groupRooms, free, lockToken, lockedBy, leaseMs }: import('./store.js').ClaimDueParams): Promise<import('./store.js').ClaimDueResult>;
/**
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} ids
 * @returns {Promise<Map<string, unknown>>} The payloads by job id, as JSON gives them back.
 */
export declare function readPayloads(executor: Executor, p: string, ids: string[]): Promise<Map<string, unknown>>;
