// The adapter for TypeORM 0.3 and 1.x (`@sqlane/core/adapter-typeorm`), MySQL, MariaDB or PostgreSQL: `enqueue`
// takes a DataSource, an EntityManager or a QueryRunner. The SQL of sqlane runs through `queryRunner.query()`, with the
// placeholders of the driver. No import of TypeORM: the adapter uses the objects that it gets, and checks them. After
// the commit of the outermost transaction (a subscriber of the DataSource: `afterTransactionCommit`), the workers wake
// at once.

import { ConfigError } from '../errors.js';

/** @typedef {{ records: any[], affected?: number }} StructuredResult The result of `query(…, true)` */

/** @typedef {{ queryRunner: QueryRunnerLike }} ManagerLike An EntityManager, as far as the adapter reads it */

/**
 * A TypeORM QueryRunner, as far as the adapter reads it.
 * @typedef {object} QueryRunnerLike
 * @property {(sql: string, params: unknown[], structured: true) => Promise<StructuredResult>} query
 * @property {boolean} isTransactionActive
 * @property {() => Promise<void>} startTransaction
 * @property {() => Promise<void>} release
 * @property {any} [dataSource] TypeORM 1.x.
 * @property {any} [connection] TypeORM 0.3.
 */

/**
 * The connections that `enqueue` takes: a DataSource or an EntityManager (a transaction of its own, unless the manager
 * is in a transaction), or a QueryRunner in a transaction.
 * @typedef {any} TypeOrmConnection
 */

/** The TypeORM data sources that have the subscriber of the adapter */
const subscribed = new WeakSet();
/** @type {WeakMap<object, (() => void)[]>} The wakes of the transactions, by QueryRunner, until their outer commit */
const onCommitByRunner = new WeakMap();

/** A subscriber of a DataSource: the commit and the rollback of its transactions. */
const SUBSCRIBER = {
    /** @param {{ queryRunner: QueryRunnerLike }} event */
    afterTransactionCommit: ({ queryRunner }) => {
        // Also after the release of a savepoint: only the outermost commit ends the transaction
        if (queryRunner.isTransactionActive) {
            return;
        }

        const callbacks = onCommitByRunner.get(queryRunner) ?? [];

        onCommitByRunner.delete(queryRunner);

        for (const callback of callbacks) {
            callback();
        }
    },
    /** @param {{ queryRunner: QueryRunnerLike }} event */
    afterTransactionRollback: ({ queryRunner }) => {
        if (!queryRunner.isTransactionActive) {
            onCommitByRunner.delete(queryRunner);
        }
    },
};

/**
 * @param {QueryRunnerLike} runner
 * @returns {import('../types.js').Executor}
 */
function executorOf(runner) {
    return {
        query: async (sql, params) => (await runner.query(sql, [...params], true)).records ?? [],
        run: async (sql, params) => (await runner.query(sql, [...params], true)).affected ?? 0,
    };
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isQueryRunner(value) {
    return typeof value?.startTransaction === 'function' && typeof value.query === 'function';
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isDataSource(value) {
    return typeof value?.createQueryRunner === 'function' && typeof value.initialize === 'function';
}

/**
 * The QueryRunner of the transaction that the connection is in, if any.
 * @param {TypeOrmConnection} connection
 * @returns {QueryRunnerLike | null}
 */
function transactionRunnerOf(connection) {
    const runner = isQueryRunner(connection) ? connection : connection?.queryRunner;

    return runner?.isTransactionActive ? runner : null;
}

/**
 * Runs func on a QueryRunner of the data source, outside a transaction.
 * @template T
 * @param {any} source
 * @param {(executor: import('../types.js').Executor) => Promise<T>} func
 * @returns {Promise<T>}
 */
async function onRunner(source, func) {
    const runner = source.createQueryRunner();

    try {
        return await func(executorOf(runner));
    } finally {
        await runner.release();
    }
}

/**
 * The adapter for TypeORM (MySQL or MariaDB with mysql2, or PostgreSQL). The type of the DataSource tells the database:
 * `"mariadb"` for MariaDB. `enqueue` then takes a DataSource (a transaction of its own), the EntityManager of a
 * transaction (`dataSource.transaction(manager => …)`), or a QueryRunner in a transaction.
 * @param {any} dataSource The queue's own DataSource, initialized: claims, leases, results.
 * @returns {import('../types.js').Adapter<TypeOrmConnection>}
 */
export function typeOrmAdapter(dataSource) {
    if (!isDataSource(dataSource) || typeof dataSource.transaction !== 'function') {
        throw new ConfigError('typeOrmAdapter: expects a TypeORM DataSource (TypeORM 0.3 or 1.x)');
    }

    const type = dataSource.options?.type;

    if (type !== 'mysql' && type !== 'mariadb' && type !== 'postgres') {
        throw new ConfigError(
            `typeOrmAdapter: the type must be "mysql", "mariadb" or "postgres", not ${JSON.stringify(type ?? null)}`,
        );
    }

    /**
     * @param {TypeOrmConnection} connection
     * @returns {any} The DataSource of a DataSource, an EntityManager or a QueryRunner.
     */
    function dataSourceOf(connection) {
        return isDataSource(connection)
            ? connection
            : connection?.dataSource ?? connection?.connection ?? connection?.manager?.connection;
    }

    return {
        dialect: type,
        wrap: (connection) => {
            const runner = transactionRunnerOf(connection);

            if (runner) {
                return executorOf(runner);
            }

            const source = dataSourceOf(connection);

            return {
                query: (sql, params) => onRunner(source, executor => executor.query(sql, params)),
                run: (sql, params) => onRunner(source, executor => executor.run(sql, params)),
            };
        },
        queue: {
            query: (sql, params) => onRunner(dataSource, executor => executor.query(sql, params)),
            run: (sql, params) => onRunner(dataSource, executor => executor.run(sql, params)),
        },
        withConnection: func => onRunner(dataSource, func),
        queueTransaction: func => dataSource.transaction(
            'READ COMMITTED',
            (/** @type {ManagerLike} */ manager) => func(executorOf(manager.queryRunner)),
        ),
        inTransaction: (connection, func) => {
            const runner = transactionRunnerOf(connection);

            return runner
                ? func(executorOf(runner))
                : dataSourceOf(connection).transaction(
                        (/** @type {ManagerLike} */ manager) => func(executorOf(manager.queryRunner)),
                    );
        },
        afterCommit: (connection, onCommit) => {
            const runner = transactionRunnerOf(connection);

            if (!runner) {
                // A transaction of its own: committed when the enqueue returned
                onCommit();

                return true;
            }

            const source = dataSourceOf(runner);

            if (!Array.isArray(source?.subscribers)) {
                return false;
            }

            if (!subscribed.has(source)) {
                subscribed.add(source);
                source.subscribers.push(SUBSCRIBER);
            }

            onCommitByRunner.set(runner, [...onCommitByRunner.get(runner) ?? [], onCommit]);

            return true;
        },
    };
}
