// The adapter for MikroORM 6 and 7 (`@sqlane/core/adapter-mikro-orm`), MySQL or PostgreSQL: `enqueue` takes an
// EntityManager. In a transaction (its own, or the one of the global EntityManager inside `em.transactional()`), the
// job commits with it; outside one, a transaction of its own. The SQL of sqlane runs on the client under MikroORM: knex
// (MikroORM 6, as the knex adapter) or Kysely (MikroORM 7, as the Kysely adapter). No import of MikroORM: the adapter
// uses the EntityManager that it gets, and checks it. After the commit of the outermost transaction, the workers wake
// at once: knex resolves its transaction (MikroORM 6), MikroORM 7 dispatches `afterTransactionCommit`.
import { ConfigError } from '../errors.js';
import { knexAdapter } from './knex.js';
import { kyselyAdapter } from './kysely.js';

/**
 * A MikroORM EntityManager, as far as the adapter reads it.
 * @typedef {object} EntityManagerLike
 * @property {() => any} getTransactionContext A knex transaction (MikroORM 6), a Kysely controlled transaction
 *     (MikroORM 7), or undefined.
 * @property {(type: 'write') => any} getConnection
 * @property {(validate: false) => EntityManagerLike} getContext The EntityManager of the current context: of
 *     `em.transactional()`, when called on the global one.
 * @property {() => { registerSubscriber: (subscriber: object) => void }} getEventManager
 */

/**
 * @typedef {object} MikroOrmAdapterOptions
 * @property {import('../types.js').Dialect} dialect The database: `'mysql'` or `'mariadb'` with `@mikro-orm/mysql`,
 *     `'postgres'` with `@mikro-orm/postgresql`.
 */

/** @type {WeakMap<object, (() => void)[]>} The wakes of MikroORM 7 transactions, by transaction, until their commit */
const onCommitByTransaction = new WeakMap();

/**
 * @param {any} transaction
 * @returns {boolean} A savepoint of MikroORM 7: its release, or its rollback, does not end the transaction.
 */
function isSavepoint(transaction) {
    return typeof transaction === 'object' && transaction !== null && 'savepointName' in transaction;
}

/** A subscriber of the EventManager of a MikroORM 7 transaction: its commit and its rollback. */
const SUBSCRIBER = {
    /** @param {{ transaction?: object }} event */
    afterTransactionCommit: ({ transaction }) => {
        if (!transaction || isSavepoint(transaction)) {
            return;
        }

        const callbacks = onCommitByTransaction.get(transaction) ?? [];

        onCommitByTransaction.delete(transaction);

        for (const callback of callbacks) {
            callback();
        }
    },
    /** @param {{ transaction?: object }} event */
    afterTransactionRollback: ({ transaction }) => {
        if (transaction && !isSavepoint(transaction)) {
            onCommitByTransaction.delete(transaction);
        }
    },
};

/**
 * @param {unknown} em
 * @returns {em is EntityManagerLike} It has what the adapter uses.
 */
function isEntityManager(em) {
    const candidate = /** @type {Record<string, unknown> | null | undefined} */ (em);

    return ['getTransactionContext', 'getConnection', 'getContext', 'getEventManager']
        .every(method => typeof candidate?.[method] === 'function');
}

/**
 * @param {EntityManagerLike} em
 * @returns {6 | 7 | null} The major release of MikroORM: its SQL connection has knex (6) or Kysely (7).
 */
function majorOf(em) {
    const connection = em.getConnection('write');

    if (typeof connection?.getKnex === 'function') {
        return 6;
    }

    return typeof connection?.getClient === 'function' ? 7 : null;
}

/**
 * The client under an EntityManager, connected: MikroORM 7 creates it at the first query (on MySQL, asynchronously).
 * @param {EntityManagerLike} em
 * @param {6 | 7} major
 * @returns {Promise<any>} A knex instance (MikroORM 6) or a Kysely instance (MikroORM 7).
 */
async function clientOf(em, major) {
    const connection = em.getConnection('write');

    await connection.ensureConnection();

    return major === 6 ? connection.getKnex() : connection.getClient();
}

/**
 * An executor that runs on the executor that it gets, once.
 * @param {() => Promise<import('../types.js').Executor>} getExecutor
 * @returns {import('../types.js').Executor}
 */
function lazyExecutor(getExecutor) {
    return {
        query: async (sql, params) => (await getExecutor()).query(sql, params),
        run: async (sql, params) => (await getExecutor()).run(sql, params),
    };
}

/**
 * The adapter for MikroORM 6 or 7 (MySQL or PostgreSQL). `enqueue` then takes an EntityManager: of a transaction (the
 * caller's: the job commits with it), the global one inside `em.transactional()` (its transaction), or one outside a
 * transaction (a transaction of its own).
 * @param {EntityManagerLike} em The EntityManager of the queue's own MikroORM: claims, leases, results
 *     (`MikroORM.init()`). A small pool of its own is best.
 * @param {MikroOrmAdapterOptions} options
 * @returns {import('../types.js').Adapter<EntityManagerLike>}
 */
export function mikroOrmAdapter(em, options) {
    const found = isEntityManager(em) ? majorOf(em) : null;

    if (!found) {
        throw new ConfigError('mikroOrmAdapter: expects an EntityManager of MikroORM 6 or 7, with a SQL driver');
    }

    const major = found;
    const dialect = options?.dialect;

    if (dialect !== 'mysql' && dialect !== 'mariadb' && dialect !== 'postgres') {
        throw new ConfigError('mikroOrmAdapter: "dialect" must be "mysql", "mariadb" or "postgres"');
    }

    /** @type {import('../types.js').Adapter<any> | undefined} The knex or Kysely adapter, over the queue's client */
    let inner;
    /** @type {Promise<import('../types.js').Adapter<any>> | undefined} */
    let innerReady;

    /** @returns {Promise<import('../types.js').Adapter<any>>} */
    const getInner = () => {
        innerReady ??= (async () => {
            const client = await clientOf(em, major);
            const created = major === 6
                ? knexAdapter(client, dialect === 'postgres' ? undefined : { dialect })
                : kyselyAdapter(client, { dialect });

            if (created.dialect !== dialect) {
                throw new ConfigError(
                    `mikroOrmAdapter: "dialect" is "${dialect}", but the driver of MikroORM is "${created.dialect}"`,
                );
            }

            inner = created;

            return created;
        })();

        return innerReady;
    };

    /**
     * @param {EntityManagerLike} connection
     * @returns {any} The transaction of the EntityManager (of its context), if any.
     */
    function transactionOf(connection) {
        if (!isEntityManager(connection)) {
            throw new ConfigError('mikroOrmAdapter: enqueue expects a MikroORM EntityManager');
        }

        return connection.getTransactionContext();
    }

    /**
     * @param {EntityManagerLike} connection
     * @param {any} transaction Its transaction, read in the async context of the caller (the global EntityManager in
     *     `em.transactional()`).
     * @returns {Promise<any>} The transaction, or the client of the EntityManager: a transaction of its own.
     */
    async function targetOf(connection, transaction) {
        return transaction ?? clientOf(connection, major);
    }

    return {
        dialect,
        wrap: (connection) => {
            const transaction = transactionOf(connection);

            return lazyExecutor(async () => (await getInner()).wrap(await targetOf(connection, transaction)));
        },
        queue: lazyExecutor(async () => (await getInner()).queue),
        withConnection: async func => (await getInner()).withConnection(func),
        queueTransaction: async func => (await getInner()).queueTransaction(func),
        inTransaction: async (connection, func) => {
            const transaction = transactionOf(connection);

            return (await getInner()).inTransaction(await targetOf(connection, transaction), func);
        },
        afterCommit: (connection, onCommit) => {
            const transaction = transactionOf(connection);

            // Outside a transaction: committed when the enqueue returned
            if (!transaction) {
                onCommit();

                return true;
            }

            // MikroORM 6: a knex transaction, as the knex adapter
            if (major === 6) {
                return inner?.afterCommit?.(transaction, onCommit) ?? false;
            }

            // A savepoint of MikroORM 7 knows no parent: the outer commit is not visible here, sqlane re-probes
            if (isSavepoint(transaction)) {
                return false;
            }

            // MikroORM 7 runs each `em.transactional()` on a fork with an EventManager of its own (a clone): the one
            // that dispatches the commit.
            connection.getContext(false).getEventManager().registerSubscriber(SUBSCRIBER);
            onCommitByTransaction.set(transaction, [...onCommitByTransaction.get(transaction) ?? [], onCommit]);

            return true;
        },
    };
}
