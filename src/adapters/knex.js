// The adapter for knex 3 (`@sqlane/core/adapter-knex`): `enqueue` takes a knex instance or a knex transaction. The SQL
// of sqlane runs on the raw driver connection under knex (mysql2, mariadb or pg): knex does not run it, nor log it. No
// import of knex: the adapter uses the instance it gets, and checks what it uses.
import { ConfigError } from '../errors.js';
import { checkAdapterDialect, matchLibraryDialect } from './dialect.js';
import { mariadbExecutor, pgExecutor } from './executors.js';

/** @typedef {import('knex').Knex} Knex */
/** @typedef {import('knex').Knex.Transaction} KnexTransaction */
/** @typedef {import('../types.js').Executor} Executor */

/**
 * The connections that `enqueue` takes: a knex instance (a transaction of its own) or a knex transaction.
 * @typedef {Knex | KnexTransaction} KnexConnection
 */

/**
 * @typedef {object} KnexAdapterOptions
 * @property {import('../types.js').Dialect} dialect The database: `'mysql'` or `'mariadb'` with the mysql2 client,
 *     `'mariadb'` with the mariadb client, `'postgres'` with the pg client.
 * @property {boolean} [allowUnsupportedVersion] Runs on a server below the supported minimum, with a warning. Default:
 *     false.
 * @property {boolean} [prepare] pg: named prepared statements, each SQL text parsed and planned once per connection.
 *     Opt-in: not behind a pooler in transaction mode without prepared statement support (PgBouncer before 1.21).
 *     Default: false.
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
 * The driver of a knex instance, and the dialects that it can run.
 * @param {Knex} knex
 * @param {string} where The adapter, for the error.
 * @returns {{ driverName: 'mysql2' | 'mariadb' | 'pg', dialects: import('../types.js').Dialect[] }}
 */
export function knexDriverOf(knex, where) {
    const client = /** @type {{ dialect?: unknown, driverName?: unknown, acquireConnection?: unknown } | undefined} */ (
        knex?.client
    );

    if (typeof knex?.transaction !== 'function' || typeof client?.acquireConnection !== 'function') {
        throw new ConfigError(`${where}: expects a knex instance (knex 3)`);
    }

    if (client.dialect === 'mysql' && client.driverName === 'mysql2') {
        return { driverName: 'mysql2', dialects: ['mysql', 'mariadb'] };
    }

    // The mariadb client of knex (and of MikroORM 6): MariaDB, on the callback API of the mariadb driver
    if (client.dialect === 'mysql' && client.driverName === 'mariadb') {
        return { driverName: 'mariadb', dialects: ['mariadb'] };
    }

    if (client.dialect === 'postgresql' && client.driverName === 'pg') {
        return { driverName: 'pg', dialects: ['postgres'] };
    }

    throw new ConfigError(
        `${where}: the client of knex must be "mysql2", "mariadb" or "pg", not ${JSON.stringify(client.driverName ?? null)}`,
    );
}

/**
 * @param {Knex} knex
 * @param {KnexAdapterOptions} options
 * @returns {{ dialect: import('../types.js').Dialect, allowUnsupportedVersion: boolean, toExecutor: ToExecutor }}
 */
function resolveDriver(knex, options) {
    const { driverName, dialects } = knexDriverOf(knex, 'knexAdapter');
    const checked = checkAdapterDialect(options, 'knexAdapter', ['mysql', 'mariadb', 'postgres']);
    const dialect = matchLibraryDialect(
        checked.dialect,
        dialects,
        'knexAdapter',
        `the client of knex is ${JSON.stringify(driverName)}`,
    );

    if (options.prepare && driverName !== 'pg') {
        throw new ConfigError('knexAdapter: "prepare" is for PostgreSQL (the pg client)');
    }

    /** @type {Record<typeof driverName, ToExecutor>} */
    const executorByDriver = {
        mysql2: mysql2Executor,
        mariadb: connection => mariadbExecutor(connection, 'callback'),
        // A pg Client: named statements through query({ name, text, values })
        pg: connection => pgExecutor(connection, { prepare: options.prepare ?? false }),
    };

    return {
        dialect,
        allowUnsupportedVersion: checked.allowUnsupportedVersion,
        toExecutor: executorByDriver[driverName],
    };
}

/**
 * The adapter for knex (mysql2, mariadb or pg). `enqueue` then takes a knex instance (a transaction of its own) or a
 * knex transaction (the caller's: the job commits with it). After the commit of the outermost transaction, the
 * processes wake at once.
 * @param {Knex} knex The queue's own knex: claims, leases, results. A small pool of its own is best.
 * @param {KnexAdapterOptions} options `{ dialect }`. pg: `{ prepare: true }`, named prepared statements.
 * @returns {import('../types.js').Adapter<KnexConnection>}
 */
export function knexAdapter(knex, options) {
    const { dialect, allowUnsupportedVersion, toExecutor } = resolveDriver(knex, options);

    return {
        dialect,
        allowUnsupportedVersion,
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
