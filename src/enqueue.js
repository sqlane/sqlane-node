import { createMonotonicUlid } from './ulid.js';
import { InvalidOptionsError, UnknownJobError } from './errors.js';
import { buildNewJob } from './new_job.js';
import { insertJobsMariadb } from './store/mariadb_enqueue.js';
import { insertJobsMysql } from './store/mysql_enqueue.js';
import { insertJobsPostgres } from './store/postgres_enqueue.js';
import { isPlainObject } from './validate.js';

const enqueueToken = createMonotonicUlid();

/**
 * @template C
 * @typedef {object} EnqueuerOptions
 * @property {import('./types.js').Adapter<C>} adapter
 * @property {string} tablePrefix Checked.
 * @property {(name: string) => import('./types.js').JobDefinition | null} findDefinition The known definition of
 *     a name.
 * @property {'allow' | 'reject'} unknownJobs
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {number} maxPayloadBytes
 * @property {string | null} notifyChannel PostgreSQL NOTIFY: `pg_notify` in the enqueue transaction, delivered on
 *     commit. Null: no NOTIFY.
 */

/**
 * @template C
 * @typedef {object} Enqueuer
 * @property {import('./types.js').Sqlane<C, never>['enqueue']} enqueue
 * @property {import('./types.js').Sqlane<C, never>['enqueueMany']} enqueueMany
 */

/**
 * The enqueue side of an instance.
 * @template C
 * @param {EnqueuerOptions<C>} options
 * @returns {Enqueuer<C>}
 */
export function createEnqueuer({
    adapter,
    tablePrefix,
    findDefinition,
    unknownJobs,
    defaults,
    maxPayloadBytes,
    notifyChannel,
}) {
    // MySQL, MariaDB: several statements, in a transaction. PostgreSQL: one statement (insertJobsPostgres).
    /** @type {Record<string, typeof insertJobsMysql | undefined>} */
    const insertJobsByDialect = { mysql: insertJobsMysql, mariadb: insertJobsMariadb };
    const insertJobs = insertJobsByDialect[adapter.dialect];

    /**
     * @param {import('./types.js').JobDefinition | string} job
     * @returns {{ name: string, definition: import('./types.js').JobDefinition | null }}
     */
    function resolveJob(job) {
        if (isPlainObject(job) && typeof job.name === 'string') {
            return { name: job.name, definition: job };
        }

        if (typeof job !== 'string') {
            throw new InvalidOptionsError('enqueue: the job must be a job definition or a job name');
        }

        const definition = findDefinition(job);

        if (!definition && unknownJobs === 'reject') {
            throw new UnknownJobError(`enqueue("${job}"): the job is not in "jobs" and not handled`);
        }

        return { name: job, definition };
    }

    /**
     * @param {C} connection
     * @param {import('./types.js').JobDefinition | string} job
     * @param {readonly { payload: unknown, options?: import('./types.js').EnqueueOptions }[]} items
     * @returns {Promise<import('./types.js').EnqueueResult[]>}
     */
    async function insert(connection, job, items) {
        const { name, definition } = resolveJob(job);
        // Checks all the items before the INSERT: a bad item adds no job.
        const newJobs = items.map(item => buildNewJob({
            name,
            definition,
            defaults,
            payload: item.payload,
            options: item.options,
            maxPayloadBytes,
        }));
        // A jobId repeated in the call: its first item is the job, the next ones are duplicates.
        const firstById = new Map();

        for (const newJob of newJobs) {
            if (!firstById.has(newJob.id)) {
                firstById.set(newJob.id, newJob);
            }
        }

        if (!firstById.size) {
            return [];
        }

        const token = enqueueToken();
        const jobs = [...firstById.values()];
        /** @type {Set<string>} */
        let created;

        if (insertJobs) {
            created = await adapter.inTransaction(
                connection,
                executor => insertJobs(executor, tablePrefix, jobs, token),
            );
        } else {
            // PostgreSQL: one statement, with its NOTIFY; atomic outside a transaction
            const options = { enqueueToken: token, notifyChannel };

            created = await (adapter.inStatement ?? adapter.inTransaction)(
                connection,
                executor => insertJobsPostgres(executor, tablePrefix, jobs, options),
            );
        }

        return newJobs.map(newJob => ({
            id: newJob.id,
            created: created.has(newJob.id) && firstById.get(newJob.id) === newJob,
        }));
    }

    return {
        enqueue: async (connection, job, payload, options) => {
            const [result] = await insert(connection, job, [{ payload, options }]);

            return result;
        },
        enqueueMany: (connection, job, items) => {
            if (!Array.isArray(items)) {
                return Promise.reject(new InvalidOptionsError('enqueueMany: "items" must be an array'));
            }

            return insert(connection, job, items);
        },
    };
}
