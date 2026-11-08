// The adapter for Kysely 0.28+ (`@sqlane/core/adapter-kysely`): `enqueue` takes a Kysely instance or a Kysely
// transaction. The SQL of sqlane runs through Kysely, without its plugins (a CamelCasePlugin would rename the columns
// that sqlane reads), with the placeholders of the driver. No import of kysely: the adapter uses the instance that it
// gets, and checks what it uses. Kysely has no after-commit hook: after an enqueue in a transaction, sqlane re-probes.
import { ConfigError } from '../errors.js';

/** @typedef {import('kysely').Kysely<any>} Kysely */
/** @typedef {import('kysely').Transaction<any>} KyselyTransaction */
/** @typedef {import('../types.js').Executor} Executor */

/**
 * The connections that `enqueue` takes: a Kysely instance (a transaction of its own) or a Kysely transaction.
 * @typedef {Kysely | KyselyTransaction} KyselyConnection
 */

/**
 * @typedef {object} KyselyAdapterOptions
 * @property {'mysql' | 'postgres'} dialect The dialect of the Kysely instance: Kysely does not tell it.
 */

/**
 * A compiled query of raw SQL, as `CompiledQuery.raw()` of Kysely makes it.
 * @param {string} sql
 * @param {readonly unknown[]} parameters
 * @returns {import('kysely').CompiledQuery<Record<string, unknown>>}
 */
function rawQuery(sql, parameters) {
    return /** @type {any} */ ({
        sql,
        parameters: [...parameters],
        query: { kind: 'RawNode', sqlFragments: [sql], parameters: [] },
        queryId: { queryId: 'sqlane' },
    });
}

/**
 * @param {KyselyConnection} db
 * @returns {Executor}
 */
function executorOf(db) {
    const plain = db.withoutPlugins();

    return {
        query: async (sql, params) => (await plain.executeQuery(rawQuery(sql, params))).rows,
        run: async (sql, params) => Number((await plain.executeQuery(rawQuery(sql, params))).numAffectedRows ?? 0),
    };
}

/**
 * @param {unknown} db
 * @returns {boolean} It has what the adapter uses.
 */
function isKysely(db) {
    const candidate = /** @type {Record<string, unknown> | null | undefined} */ (db);

    return ['withoutPlugins', 'executeQuery', 'transaction', 'connection']
        .every(method => typeof candidate?.[method] === 'function');
}

/**
 * The adapter for Kysely (its MySQL or PostgreSQL dialect). `enqueue` then takes a Kysely instance (a transaction of
 * its own) or a Kysely transaction, also a controlled one (the caller's: the job commits with it).
 * @param {Kysely} db The queue's own Kysely: claims, leases, results. A small pool of its own is best.
 * @param {KyselyAdapterOptions} options
 * @returns {import('../types.js').Adapter<KyselyConnection>}
 */
export function kyselyAdapter(db, options) {
    if (!isKysely(db)) {
        throw new ConfigError('kyselyAdapter: expects a Kysely instance (kysely 0.28+)');
    }

    const dialect = options?.dialect;

    if (dialect !== 'mysql' && dialect !== 'postgres') {
        throw new ConfigError('kyselyAdapter: "dialect" must be "mysql" or "postgres"');
    }

    return {
        dialect,
        wrap: executorOf,
        queue: executorOf(db),
        withConnection: func => db.connection().execute(connection => func(executorOf(connection))),
        queueTransaction: func => db.transaction()
            .setIsolationLevel('read committed')
            .execute(trx => func(executorOf(trx))),
        inTransaction: (connection, func) => (connection.isTransaction
            ? func(executorOf(connection))
            : connection.transaction().execute(trx => func(executorOf(trx)))),
        // A Kysely instance: the enqueue ran in a transaction of its own, committed when it returned. A transaction:
        // Kysely has no hook.
        afterCommit: (connection, onCommit) => {
            if (connection.isTransaction) {
                return false;
            }

            onCommit();

            return true;
        },
    };
}
