// The store: the SQL of one dialect, bound to an adapter and a table prefix.
import * as mysqlWorker from './mysql_worker.js';
import * as postgresWorker from './postgres_worker.js';

/**
 * @typedef {object} ProbeRow
 * @property {string} name A job name with pending jobs.
 * @property {number} delayMs Until its oldest pending job is due: 0 or less means due now.
 */

/**
 * @typedef {object} Candidate
 * @property {string} id
 * @property {string} name
 * @property {number} runAtMs
 */

/**
 * A job that a claim locked, and then claimed: it runs.
 * @typedef {object} ClaimedJob
 * @property {string} id
 * @property {string} name
 * @property {string[]} mutexKeys
 * @property {number} attempts The failed attempts so far.
 * @property {number} maxAttempts
 * @property {number} stalls
 * @property {number} maxStalls
 * @property {string | null} failureJob
 * @property {Date} enqueuedAt
 * @property {number} waitedMs Since it was due.
 * @property {string} lockToken
 */

/**
 * @typedef {object} ClaimParams
 * @property {string[]} candidateIds
 * @property {string} lockToken Of this claim.
 * @property {string} lockedBy The process.
 * @property {number} leaseMs
 * @property {(locked: ClaimedJob[], busyKeys: Set<string>) => ClaimedJob[]} pick The jobs to take among the locked
 *     ones (in the order of run_at): the free slots, the free keys. The keys of the picked jobs must be distinct.
 */

/**
 * @typedef {object} Store
 * @property {() => Promise<ProbeRow[]>} probe
 * @property {(limitsByName: Map<string, number>, keyedNames: string[]) => Promise<Candidate[]>} findCandidates
 * @property {(params: ClaimParams) => Promise<ClaimedJob[]>} claim In a queue transaction of its own.
 * @property {(ids: string[]) => Promise<Map<string, unknown>>} readPayloads
 */

/**
 * @param {import('../types.js').Adapter<any>} adapter
 * @param {string} tablePrefix Checked.
 * @returns {Store}
 */
export function createStore(adapter, tablePrefix) {
    const sql = adapter.dialect === 'mysql' ? mysqlWorker : postgresWorker;

    return {
        probe: () => sql.probe(adapter.queue, tablePrefix),
        findCandidates: (limitsByName, keyedNames) => sql.findCandidates(
            adapter.queue,
            tablePrefix,
            limitsByName,
            keyedNames,
        ),
        claim: params => adapter.queueTransaction(executor => sql.claim(executor, tablePrefix, params)),
        readPayloads: ids => sql.readPayloads(adapter.queue, tablePrefix, ids),
    };
}
