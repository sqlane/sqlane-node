import { createMonotonicUlid } from './ulid.js';
import { InvalidOptionsError, UnknownLaneError } from './errors.js';
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
 * @property {(lane: string) => import('./types.js').LaneDefinition | null} findDefinition The known definition of
 *     a lane.
 * @property {'allow' | 'reject'} unknownLanes
 * @property {import('./defaults.js').ResolvedDefaults} defaults
 * @property {number} maxPayloadBytes
 * @property {string | null} notifyChannel PostgreSQL NOTIFY: `pg_notify` in the enqueue transaction, delivered on
 *     commit. Null: no NOTIFY.
 */

/**
 * @template C
 * @typedef {object} Enqueuer
 * @property {import('./types.js').Sqlane<C>['enqueue']} enqueue
 * @property {import('./types.js').Sqlane<C>['enqueueMany']} enqueueMany
 * @property {(connection: C | undefined, newJob: import('./new_job.js').NewJob)
 *     => Promise<import('./types.js').EnqueueResult>} insertOne A built job. No connection: on the queue's pool, in
 *     a transaction of its own.
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
    unknownLanes,
    defaults,
    maxPayloadBytes,
    notifyChannel,
}) {
    // MySQL, MariaDB: several statements, in a transaction. PostgreSQL: one statement (insertJobsPostgres).
    /** @type {Record<string, typeof insertJobsMysql | undefined>} */
    const insertJobsByDialect = { mysql: insertJobsMysql, mariadb: insertJobsMariadb };
    const insertJobs = insertJobsByDialect[adapter.dialect];

    /**
     * @param {import('./types.js').LaneDefinition | string} given
     * @returns {{ lane: string, definition: import('./types.js').LaneDefinition | null }}
     */
    function resolveLane(given) {
        if (isPlainObject(given) && typeof given.name === 'string') {
            return { lane: given.name, definition: given };
        }

        if (typeof given !== 'string') {
            throw new InvalidOptionsError('enqueue: the lane must be a lane definition or a lane name');
        }

        const definition = findDefinition(given);

        if (!definition && unknownLanes === 'reject') {
            throw new UnknownLaneError(`enqueue("${given}"): the lane is not in "lanes" and not added`);
        }

        return { lane: given, definition };
    }

    /**
     * @param {C | undefined} connection Undefined: the queue's pool.
     * @param {import('./new_job.js').NewJob[]} jobs Distinct ids.
     * @returns {Promise<Set<string>>} The ids that it created.
     */
    function insertJobsOf(connection, jobs) {
        const token = enqueueToken();

        if (insertJobs) {
            const mysqlInsert = insertJobs;
            /**
             * @param {import('./types.js').Executor} executor
             * @returns {Promise<Set<string>>}
             */
            const write = executor => mysqlInsert(executor, tablePrefix, jobs, token);

            return connection === undefined
                ? adapter.queueTransaction(write)
                : adapter.inTransaction(connection, write);
        }

        // PostgreSQL: one statement, with its NOTIFY; atomic outside a transaction
        const options = { enqueueToken: token, notifyChannel };

        if (connection === undefined) {
            return insertJobsPostgres(adapter.queue, tablePrefix, jobs, options);
        }

        return (adapter.inStatement ?? adapter.inTransaction)(
            connection,
            executor => insertJobsPostgres(executor, tablePrefix, jobs, options),
        );
    }

    /**
     * @param {C} connection
     * @param {import('./types.js').LaneDefinition | string} given
     * @param {readonly { payload: unknown, options?: import('./types.js').EnqueueOptions }[]} items
     * @returns {Promise<import('./types.js').EnqueueResult[]>}
     */
    async function insert(connection, given, items) {
        const { lane, definition } = resolveLane(given);
        // Checks all the items before the INSERT: a bad item adds no job.
        const newJobs = items.map(item => buildNewJob({
            lane,
            definition,
            defaults,
            payload: item.payload,
            options: item.options,
            maxPayloadBytes,
        }));
        // A dedupeKey repeated in the call: its first item is the job, the next ones are duplicates.
        const firstById = new Map();

        for (const newJob of newJobs) {
            if (!firstById.has(newJob.id)) {
                firstById.set(newJob.id, newJob);
            }
        }

        if (!firstById.size) {
            return [];
        }

        const created = await insertJobsOf(connection, [...firstById.values()]);

        return newJobs.map(newJob => ({
            id: newJob.id,
            created: created.has(newJob.id) && firstById.get(newJob.id) === newJob,
        }));
    }

    return {
        enqueue: async (connection, lane, payload, options) => {
            const [result] = await insert(connection, lane, [{ payload, options }]);

            return result;
        },
        enqueueMany: (connection, lane, items) => {
            if (!Array.isArray(items)) {
                return Promise.reject(new InvalidOptionsError('enqueueMany: "items" must be an array'));
            }

            return insert(connection, lane, items);
        },
        insertOne: async (connection, newJob) => ({
            id: newJob.id,
            created: (await insertJobsOf(connection, [newJob])).has(newJob.id),
        }),
    };
}
