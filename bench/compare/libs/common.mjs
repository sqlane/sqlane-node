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
 * @param {number} count
 * @returns {string[]} The keys of `count` schedules: `s0000`, `s0001`, …
 */
export const scheduleKeys = count => Array.from({ length: count }, (_, index) => `s${String(index).padStart(4, '0')}`);

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
 * @property {(name: string, payload: any, signal?: AbortSignal, slotMs?: number) => Promise<void>} handler slotMs: the
 *     time of the schedule's slot that added the job, when the library gives it to the handler.
 * @property {number} [concurrency] Default 4.
 * @property {boolean} [stall] The shortest recovery of the jobs of a dead worker that the library allows.
 * @property {number} [pollIntervalMs] How often an idle worker polls. Default 500 ms; the library's wakes still run.
 * @property {'mysql' | 'mariadb'} [dialect] sqlane only: the server of a mysql:// URL. Default: mysql.
 * @property {'setup' | 'worker' | 'producer'} [role] For the performance runs: setup creates what the names need; a
 *     producer only enqueues, and runs no background work if the library allows. Default: all of them.
 * @property {ScheduleSpec} [schedules] For the performance runs of the schedules: cron schedules of the first job name.
 */

/**
 * @typedef {object} ScheduleSpec `count` schedules of one job name, told apart by a key `s0000`, `s0001`, …; each job's
 *     payload is `{ s: <key> }`. In UTC, with each library's defaults (no jitter, no catch-up beyond its default).
 * @property {number} count
 * @property {string} cron A 5-field cron.
 * @property {number} [index] The worker's index among the workers of the run, from 0.
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
 * @property {(work: (client: any, query: (sql: string, values: any[]) => Promise<unknown>) => Promise<void>) =>
 *     Promise<void>} [transaction] A business transaction of the library's own client (Knex), for a library whose
 *     enqueue takes that client, not a pg Client or a mysql2 connection. `query` takes `?` placeholders.
 */

/**
 * @typedef {object} ScheduledJobs What a library stored for the schedules, read after its workers stopped.
 * @property {[key: string, slot: string | null][]} jobs The key and the slot (ISO) of each scheduled job in its tables;
 *     null when the job does not carry its slot (pg-boss).
 * @property {boolean} [deletesCompleted] Its completed jobs are gone (Graphile Worker, Boring Node Queue): only the
 *     handlers saw them.
 * @property {Record<string, string[]>} [filed] pg-boss: the slots that its cron pass filed, by key, oldest first.
 * @property {Record<string, string[]>} [forwarded] pg-boss: those whose forwarding job ran (it sends one job each).
 * @property {number[]} [forwardedAt] pg-boss: when each forwarding job completed (ms).
 */

/**
 * @typedef {object} Adapter
 * @property {string} version
 * @property {boolean} transactional Its enqueue runs in the caller's open transaction (`client`). Without it, the
 *     performance runs enqueue after the COMMIT, on the library's own connection: not atomic.
 * @property {('postgres' | 'mysql' | 'mariadb' | 'redis')[]} databases The servers of its performance runs: a lane
 *     each. Redis: with a PostgreSQL for the business table.
 * @property {(options: OpenOptions) => Promise<Queue>} open Migrates its tables. Throws UnsupportedError for an
 *     option it cannot honor.
 * @property {(url: string) => Promise<ScheduledJobs>} [scheduledJobs] For the performance runs of the schedules.
 */

/**
 * @param {string} url PostgreSQL or MySQL
 * @param {string} sql
 * @returns {Promise<Record<string, any>[]>} The rows of one query, on a connection of its own.
 */
export async function queryRows(url, sql) {
    if (url.startsWith('mysql:')) {
        const { createConnection } = await import('mysql2/promise');
        const connection = await createConnection({ uri: url });

        try {
            const [rows] = await connection.query(sql);

            return /** @type {Record<string, any>[]} */ (rows);
        } finally {
            await connection.end();
        }
    }

    const { Client } = await import('pg');
    const client = new Client({ connectionString: url });

    await client.connect();

    try {
        return (await client.query(sql)).rows;
    } finally {
        await client.end();
    }
}
