// The contract of a library adapter for checks.mjs and perf.mjs. Each adapter uses the settings that its library's
// documentation offers for throughput and for the precision of its schedules, and says which, why, and the default.

/** An option that the library has no API for: the check reports it, with the reason. */
export class UnsupportedError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'UnsupportedError';
    }
}

/**
 * @typedef {object} JobSpec The options of one job name.
 * @property {number} [maxAttempts]
 * @property {number} [backoffMs] A fixed wait before a retry.
 * @property {number} [timeoutMs]
 * @property {boolean} [exclusive] Its jobs carry `payload.resources`: two jobs that share one never run at once, across
 *     the job names.
 */

/**
 * @typedef {object} OpenOptions
 * @property {string} url
 * @property {Record<string, JobSpec>} names
 * @property {(name: string, payload: any, signal?: AbortSignal) => Promise<void>} handler
 * @property {number} [concurrency] Default 4.
 * @property {boolean} [stall] The shortest recovery of the jobs of a dead worker that the library allows.
 * @property {number} [pollIntervalMs] How often an idle worker polls. Default 500 ms; the library's wakes still run.
 * @property {'mysql' | 'mariadb'} [dialect] sqlane only: the server of a mysql:// URL. Default: mysql.
 * @property {'setup' | 'worker' | 'producer'} [role] For the performance runs: setup creates what the names need; a
 *     producer only enqueues, and runs no background work if the library allows. Default: all of them.
 */

/**
 * @typedef {object} Queue
 * @property {(name: string, payload: Record<string, any>, options?: { delayMs?: number, priority?: 'high' | 'low',
 *     client?: any }) => Promise<void>} enqueue client: a pg Client or a mysql2 connection, in the caller's open
 *     transaction.
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {string[]} notes How the adapter maps an option to the library: the check reports them.
 * @property {string[]} [limits] The workarounds or limits of that mapping: a check that passes with them is partial.
 */

/**
 * @typedef {object} Adapter
 * @property {string} version
 * @property {(options: OpenOptions) => Promise<Queue>} open Migrates its tables. Throws UnsupportedError for an
 *     option it cannot honor.
 */
