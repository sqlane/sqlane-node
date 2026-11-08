// The adapter for Sequelize 6 (`@sqlane/core/adapter-sequelize`), MySQL (mysql2) or PostgreSQL (pg): `enqueue` takes
// a Sequelize instance or a Sequelize transaction. The SQL of sqlane runs on the driver connection under Sequelize (the
// `connection` of a transaction, or one of its pool): Sequelize does not run it, nor log it. No import of Sequelize:
// the adapter uses the instance that it gets, and checks it. After the commit of the outermost transaction (its
// `afterCommit` hook), the workers wake at once.
import { ConfigError } from '../errors.js';
import { mysql2Executor, pgExecutor } from './executors.js';

/**
 * A Sequelize instance, as far as the adapter reads it.
 * @typedef {object} SequelizeLike
 * @property {() => string} getDialect
 * @property {(options: object, func: (t: SequelizeTransactionLike) => Promise<any>) => Promise<any>} transaction
 * @property {{ getConnection: () => Promise<any>, releaseConnection: (connection: any) => unknown }} connectionManager
 */

/**
 * A Sequelize transaction, as far as the adapter reads it.
 * @typedef {object} SequelizeTransactionLike
 * @property {any} connection The driver connection: mysql2 (callback API) or a pg client.
 * @property {SequelizeTransactionLike | undefined} [parent] Of a nested transaction (a savepoint).
 * @property {(func: () => unknown) => void} afterCommit
 */

/**
 * The connections that `enqueue` takes: a Sequelize instance (a transaction of its own) or a Sequelize transaction.
 * @typedef {SequelizeLike | SequelizeTransactionLike} SequelizeConnection
 */

/**
 * @param {SequelizeConnection} connection
 * @returns {connection is SequelizeTransactionLike}
 */
function isTransaction(connection) {
    return typeof (/** @type {{ getDialect?: unknown }} */ (connection).getDialect) !== 'function';
}

/**
 * @param {unknown} sequelize
 * @returns {string | null} Why it is not a Sequelize 6 instance; null: it is.
 */
function checkSequelize(sequelize) {
    const candidate = /** @type {any} */ (sequelize);

    if (typeof candidate?.getDialect !== 'function' || typeof candidate.transaction !== 'function'
        || typeof candidate.connectionManager?.getConnection !== 'function') {
        return 'expects a Sequelize instance (Sequelize 6)';
    }

    const version = String(candidate.constructor?.version ?? '');

    return version.startsWith('6.') ? null : `supports Sequelize 6, not ${JSON.stringify(version || null)}`;
}

/**
 * The adapter for Sequelize 6 (MySQL or PostgreSQL). `enqueue` then takes a Sequelize instance (a transaction of its
 * own) or a Sequelize transaction, also nested (the caller's: the job commits with it).
 * @param {SequelizeLike} sequelize The queue's own Sequelize instance: claims, leases, results. A small pool of its
 *     own is best.
 * @returns {import('../types.js').Adapter<SequelizeConnection>}
 */
export function sequelizeAdapter(sequelize) {
    const problem = checkSequelize(sequelize);

    if (problem) {
        throw new ConfigError(`sequelizeAdapter: ${problem}`);
    }

    const sequelizeDialect = sequelize.getDialect();

    if (sequelizeDialect !== 'mysql' && sequelizeDialect !== 'postgres') {
        throw new ConfigError(`sequelizeAdapter: the dialect must be "mysql" or "postgres", not "${sequelizeDialect}"`);
    }

    /** @type {(connection: any) => import('../types.js').Executor} The mysql2 connection of Sequelize: callback API */
    const toExecutor = sequelizeDialect === 'mysql'
        ? connection => mysql2Executor(connection.promise())
        : connection => pgExecutor(connection);

    /**
     * Runs func on a connection of the pool of the instance, outside a transaction.
     * @template T
     * @param {SequelizeLike} instance
     * @param {(executor: import('../types.js').Executor) => Promise<T>} func
     * @returns {Promise<T>}
     */
    async function onConnection(instance, func) {
        const connection = await instance.connectionManager.getConnection();

        try {
            return await func(toExecutor(connection));
        } finally {
            instance.connectionManager.releaseConnection(connection);
        }
    }

    /**
     * @param {SequelizeConnection} connection
     * @returns {import('../types.js').Executor}
     */
    function executorOf(connection) {
        if (isTransaction(connection)) {
            return toExecutor(connection.connection);
        }

        return {
            query: (sql, params) => onConnection(connection, executor => executor.query(sql, params)),
            run: (sql, params) => onConnection(connection, executor => executor.run(sql, params)),
        };
    }

    return {
        dialect: sequelizeDialect,
        wrap: executorOf,
        queue: executorOf(sequelize),
        withConnection: func => onConnection(sequelize, func),
        queueTransaction: func => sequelize.transaction(
            { isolationLevel: 'READ COMMITTED' },
            t => func(toExecutor(t.connection)),
        ),
        inTransaction: (connection, func) => (isTransaction(connection)
            ? func(toExecutor(connection.connection))
            : connection.transaction({}, t => func(toExecutor(t.connection)))),
        afterCommit: (connection, onCommit) => {
            if (!isTransaction(connection)) {
                // A transaction of its own: committed when the enqueue returned
                onCommit();

                return true;
            }

            // A nested transaction (a savepoint) completes before the outer COMMIT, which can still roll back.
            // Sequelize runs the hook also when the COMMIT fails: a wake without a job, one probe.
            let outermost = connection;

            while (outermost.parent) {
                outermost = outermost.parent;
            }

            outermost.afterCommit(() => onCommit());

            return true;
        },
    };
}
