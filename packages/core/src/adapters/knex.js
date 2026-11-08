// The adapter for knex 3 (`@sqlane/core/knex`): `enqueue` takes a knex instance or a knex transaction. The SQL of
// sqlane runs on the raw driver connection under knex (mysql2 or pg): knex does not run it, nor log it. No import of
// knex: the adapter uses the instance it gets, and checks what it uses.
import { ConfigError } from '../errors.js';

/** @typedef {import('knex').Knex} Knex */
/** @typedef {import('knex').Knex.Transaction} KnexTransaction */
/** @typedef {import('../types.js').Executor} Executor */

/**
 * The connections that `enqueue` takes: a knex instance (a transaction of its own) or a knex transaction.
 * @typedef {Knex | KnexTransaction} KnexConnection
 */

/**
 * Runs sqlane's SQL on a raw driver connection of knex.
 * @typedef {(connection: any) => Executor} ToExecutor
 */

/** @type {ToExecutor} A mysql2 connection, of its callback API: knex uses that one. */
function mysql2Executor(connection) {
    /**
     * @param {string} sql
     * @param {readonly unknown[]} params
     * @returns {Promise<any>}
     */
    const send = (sql, params) => new Promise((resolve, reject) => {
        connection.query(sql, [...params], (/** @type {Error | null} */ error, /** @type {unknown} */ result) => {
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        });
    });

    return {
        query: async (sql, params) => {
            const rows = await send(sql, params);

            return Array.isArray(rows) ? rows : [];
        },
        run: async (sql, params) => (await send(sql, params)).affectedRows,
    };
}

/** @type {ToExecutor} A pg client. */
function pgExecutor(connection) {
    return {
        query: async (sql, params) => (await connection.query(sql, [...params])).rows,
        run: async (sql, params) => (await connection.query(sql, [...params])).rowCount ?? 0,
    };
}

/**
 * @param {KnexConnection} connection
 * @returns {connection is KnexTransaction}
 */
function isTransaction(connection) {
    return /** @type {{ isTransaction?: boolean }} */ (connection).isTransaction === true;
}

/**
 * An executor over a knex instance or transaction: each statement on a connection of its pool, or on the connection of
 * the transaction.
 * @param {KnexConnection} knex
 * @param {ToExecutor} toExecutor
 * @returns {Executor}
 */
function executorOf(knex, toExecutor) {
    /**
     * @template T
     * @param {(executor: Executor) => Promise<T>} func
     * @returns {Promise<T>}
     */
    const onConnection = async (func) => {
        // A transaction: always its own connection, and the release does nothing
        const connection = await knex.client.acquireConnection();

        try {
            return await func(toExecutor(connection));
        } finally {
            await knex.client.releaseConnection(connection);
        }
    };

    return {
        query: (sql, params) => onConnection(executor => executor.query(sql, params)),
        run: (sql, params) => onConnection(executor => executor.run(sql, params)),
    };
}

/**
 * @param {Knex} knex
 * @returns {{ dialect: 'mysql' | 'postgres', toExecutor: ToExecutor }}
 */
function resolveDriver(knex) {
    const client = /** @type {{ dialect?: unknown, driverName?: unknown, acquireConnection?: unknown } | undefined} */ (
        knex?.client
    );

    if (typeof knex?.transaction !== 'function' || typeof client?.acquireConnection !== 'function') {
        throw new ConfigError('knexAdapter: expects a knex instance (knex 3)');
    }

    if (client?.dialect === 'mysql' && client.driverName === 'mysql2') {
        return { dialect: 'mysql', toExecutor: mysql2Executor };
    }

    if (client?.dialect === 'postgresql' && client.driverName === 'pg') {
        return { dialect: 'postgres', toExecutor: pgExecutor };
    }

    throw new ConfigError(
        `knexAdapter: the client of knex must be "mysql2" or "pg", not ${JSON.stringify(client?.driverName ?? null)}`,
    );
}

/**
 * The adapter for knex (mysql2 or pg). `enqueue` then takes a knex instance (a transaction of its own) or a knex
 * transaction (the caller's: the job commits with it). After the commit of the outermost transaction, the processes
 * wake at once.
 * @param {Knex} knex The queue's own knex: claims, leases, results. A small pool of its own is best.
 * @returns {import('../types.js').Adapter<KnexConnection>}
 */
export function knexAdapter(knex) {
    const { dialect, toExecutor } = resolveDriver(knex);

    return {
        dialect,
        wrap: connection => executorOf(connection, toExecutor),
        queue: executorOf(knex, toExecutor),
        withConnection: async (func) => {
            const connection = await knex.client.acquireConnection();

            try {
                return await func(toExecutor(connection));
            } finally {
                await knex.client.releaseConnection(connection);
            }
        },
        queueTransaction: func => knex.transaction(trx => func(executorOf(trx, toExecutor)), {
            isolationLevel: 'read committed',
        }),
        inTransaction: (connection, func) => (isTransaction(connection)
            ? func(executorOf(connection, toExecutor))
            : connection.transaction(trx => func(executorOf(trx, toExecutor)))),
        afterCommit: (connection, onCommit) => {
            if (!isTransaction(connection)) {
                // A transaction of its own: committed when the enqueue returned
                onCommit();

                return true;
            }

            // A nested transaction (a savepoint) completes before the outer COMMIT, which can still roll back
            let outermost = connection;

            while (outermost.parentTransaction) {
                outermost = outermost.parentTransaction;
            }

            const { executionPromise } = outermost;

            if (!executionPromise) {
                return false;
            }

            // Resolves after the answer to COMMIT; rejects on a rollback. On PostgreSQL it also resolves when the
            // server turned the COMMIT into a ROLLBACK: a wake without a job, one probe.
            (async () => {
                try {
                    await executionPromise;
                } catch {
                    return;
                }

                onCommit();
            })();

            return true;
        },
    };
}
