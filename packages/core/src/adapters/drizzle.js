// The adapter for Drizzle 0.45 and 1.0 (`@sqlane/core/adapter-drizzle`), with mysql2 or node-postgres: `enqueue` takes
// a Drizzle database or a Drizzle transaction. The SQL of sqlane runs on the driver connection under Drizzle (its
// `session.client`), through the mysql2 and pg adapters. No import of drizzle-orm: the adapter reads the kind that
// Drizzle gives its classes (a global symbol), and checks what it uses. Drizzle has no after-commit hook: after an
// enqueue in a transaction, sqlane re-probes.
import { ConfigError } from '../errors.js';
import { mysql2Adapter } from './mysql2.js';
import { pgAdapter } from './pg.js';

/** The kind of a Drizzle class: `MySql2Session`, `NodePgTransaction`, … */
const ENTITY_KIND = Symbol.for('drizzle:entityKind');

/**
 * A Drizzle database or transaction, as far as the adapter reads it.
 * @typedef {object} DrizzleDatabase
 * @property {{ client: any }} session
 * @property {(func: (tx: any) => Promise<any>) => Promise<any>} transaction
 */

/**
 * The connections that `enqueue` takes: a Drizzle database (a transaction of its own) or a Drizzle transaction, of
 * mysql2 or node-postgres.
 * @typedef {DrizzleDatabase} DrizzleConnection
 */

/**
 * @typedef {object} DrizzleAdapterOptions
 * @property {boolean} [notify] PostgreSQL: hints by LISTEN/NOTIFY, as `pgAdapter(pool, { notify: true })`.
 */

/**
 * @param {unknown} value
 * @returns {string | undefined} The kind of its Drizzle class.
 */
function kindOf(value) {
    const constructor = /** @type {Record<symbol, unknown> | undefined} */ (
        /** @type {{ constructor?: unknown } | null | undefined} */ (value)?.constructor
    );
    const kind = constructor?.[ENTITY_KIND];

    return typeof kind === 'string' ? kind : undefined;
}

/**
 * @param {DrizzleConnection} connection
 * @returns {boolean} A Drizzle transaction (also nested): its client is the connection of the transaction.
 */
function isTransaction(connection) {
    return kindOf(connection)?.endsWith('Transaction') === true;
}

/**
 * @param {DrizzleConnection} connection
 * @returns {any} The driver client under Drizzle: a pool, a connection, a client.
 */
function clientOf(connection) {
    const client = connection?.session?.client;

    if (!client) {
        throw new ConfigError('drizzleAdapter: expects a Drizzle database or transaction (drizzle-orm 0.45 or 1.0)');
    }

    return client;
}

/**
 * The adapter for Drizzle (mysql2 or node-postgres). `enqueue` then takes a Drizzle database (a transaction of its
 * own) or a Drizzle transaction, also nested (the caller's: the job commits with it).
 * @param {DrizzleDatabase} db The queue's own Drizzle database, over a pool: claims, leases, results. A small pool of
 *     its own is best.
 * @param {DrizzleAdapterOptions} [options]
 * @returns {import('../types.js').Adapter<DrizzleConnection>}
 */
export function drizzleAdapter(db, options = {}) {
    const sessionKind = kindOf(db?.session);
    const pool = clientOf(db);

    if (typeof db.transaction !== 'function' || isTransaction(db)) {
        throw new ConfigError('drizzleAdapter: expects a Drizzle database, not a transaction');
    }

    if (sessionKind !== 'MySql2Session' && sessionKind !== 'NodePgSession') {
        throw new ConfigError(
            `drizzleAdapter: Drizzle must use mysql2 or node-postgres, not ${JSON.stringify(sessionKind ?? null)}`,
        );
    }

    const isMysql = sessionKind === 'MySql2Session';
    const isPool = isMysql ? typeof pool.getConnection === 'function' : typeof pool.totalCount === 'number';

    if (!isPool) {
        throw new ConfigError('drizzleAdapter: the queue\'s Drizzle database must be over a pool');
    }

    if (isMysql && options.notify) {
        throw new ConfigError('drizzleAdapter: "notify" is for PostgreSQL');
    }

    // The queue's pool: claims, leases, results
    const base = isMysql ? mysql2Adapter(pool) : pgAdapter(pool, { notify: options.notify ?? false });

    return {
        ...base,
        wrap: connection => base.wrap(clientOf(connection)),
        // A database: in a Drizzle transaction of its own, on whatever client it has (a pool, or one connection)
        inTransaction: (connection, func) => (isTransaction(connection)
            ? func(base.wrap(clientOf(connection)))
            : connection.transaction(tx => func(base.wrap(clientOf(tx))))),
        // A database: the enqueue ran in a transaction of its own, committed when it returned. A transaction: Drizzle
        // has no hook.
        afterCommit: (connection, onCommit) => {
            if (isTransaction(connection)) {
                return false;
            }

            onCommit();

            return true;
        },
    };
}
