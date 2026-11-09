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
/** The due jobs of each keyed name that the FIFO of the mutex keys reads */
export declare const MUTEX_WINDOW_SIZE = 500;
/**
 * The SQL of the probe. `GROUP BY status, job_name`: the whole index prefix, else MariaDB does not use a loose index
 * scan.
 * @param {string} p
 * @returns {string}
 */
export declare function probeSql(p: string): string;
/**
 * The next due time of each job name with pending jobs: one index dive per pending name (loose index scan).
 * @param {Executor} executor
 * @param {string} p
 * @returns {Promise<ProbeRow[]>}
 */
export declare function probe(executor: Executor, p: string): Promise<ProbeRow[]>;
/**
 * The due jobs that can start now, oldest first: at most `limit` of each name. A job of a keyed name waits if one of
 * its keys is held, or an older due job of a keyed name has it (FIFO per key over the window of the keyed names).
 * @param {Executor} executor
 * @param {string} p
 * @param {Map<string, number>} limitsByName
 * @param {string[]} keyedNames The handled names whose definition has mutex keys.
 * @returns {Promise<Candidate[]>}
 */
export declare function findCandidates(executor: Executor, p: string, limitsByName: Map<string, number>, keyedNames: string[]): Promise<Candidate[]>;
/**
 * Claims due jobs among the candidates. Call it in a queue transaction.
 * @param {Executor} executor
 * @param {string} p
 * @param {ClaimParams} params
 * @returns {Promise<ClaimedJob[]>} In the order of run_at.
 */
export declare function claim(executor: Executor, p: string, { candidateIds, lockToken, lockedBy, leaseMs, pick }: ClaimParams): Promise<ClaimedJob[]>;
/**
 * Finds, claims and reads the due jobs of names without mutex keys. Call it in a queue transaction. One statement
 * locks the oldest due jobs of each name that no other claim holds (SKIP LOCKED), with their payloads; the ones that
 * fit the free slots (`fitSlots`) are claimed.
 * @param {Executor} executor
 * @param {string} p
 * @param {import('./store.js').ClaimDueParams} params
 * @returns {Promise<import('./store.js').StartableJob[]>} In the order of run_at.
 */
export declare function claimDue(executor: Executor, p: string, { requests, laneFree, processMax, lockToken, lockedBy, leaseMs }: import('./store.js').ClaimDueParams): Promise<import('./store.js').StartableJob[]>;
/**
 * @param {Executor} executor
 * @param {string} p
 * @param {string[]} ids
 * @returns {Promise<Map<string, unknown>>} The payloads by job id, as JSON gives them back.
 */
export declare function readPayloads(executor: Executor, p: string, ids: string[]): Promise<Map<string, unknown>>;
