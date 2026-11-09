// The adapter for postgres.js 3.4 and 4 (`@sqlane/core/adapter-postgres-js`): `enqueue` takes the `sql` of postgres.js
// (a transaction of its own) or the `sql` of a transaction (`sql.begin(sql => …)`, also a savepoint). The SQL of sqlane
// runs through `sql.unsafe(query, parameters)`, with `$1` placeholders. No import of postgres.js: the adapter uses the
// instance that it gets, and checks what it uses. postgres.js has no after-commit hook: after an enqueue in a
// transaction, sqlane re-probes; with `{ notify: true }`, NOTIFY wakes the workers at the commit.
import { ConfigError } from '../errors.js';

/**
 * The `sql` of postgres.js: a pool, a transaction or a reserved connection, as far as the adapter reads it.
 * @typedef {object} PostgresJsSql
 * @property {(query: string, parameters?: unknown[]) => Promise<any>} unsafe Resolves to the rows, with `count`.
 * @property {(options: string, func: (sql: any) => Promise<any>) => Promise<any>} [begin]
 * @property {() => Promise<PostgresJsSql & { release: () => void }>} [reserve] The pool.
 * @property {() => void} [release] A reserved connection.
 * @property {(channel: string, onNotify: (payload: string) => void) => Promise<{ unlisten: () => Promise<void> }>}
 *     [listen] The pool.
 * @property {{ transform?: any }} [options] The pool.
 */

/**
 * The connections that `enqueue` takes: the `sql` of postgres.js (a transaction of its own) or the `sql` of a
 * transaction. A reserved connection must be in a transaction (`BEGIN`), as a client of pg.
 * @typedef {PostgresJsSql} PostgresJsConnection
 */

/**
 * @typedef {object} PostgresJsAdapterOptions
 * @property {boolean} [notify] Hints by LISTEN/NOTIFY: `pg_notify` in the enqueue transaction, delivered on commit.
 *     Default: false.
 */

/**
 * @param {PostgresJsSql} sql
 * @returns {import('../types.js').Executor}
 */
function executorOf(sql) {
    return {
        // A RowList: an array with `count`
        query: async (query, params) => [...await sql.unsafe(query, [...params])],
        run: async (query, params) => Number((await sql.unsafe(query, [...params])).count ?? 0),
    };
}

/**
 * @param {PostgresJsSql} sql
 * @returns {boolean} The pool: the `sql` of `postgres(…)`.
 */
function isPool(sql) {
    return typeof sql.reserve === 'function' && typeof sql.release !== 'function';
}

/**
 * @param {unknown} transform The `transform` of the options of postgres.js.
 * @returns {boolean} It changes the column names, the values or the rows of results.
 */
function transformsResults(transform) {
    const parts = /** @type {Record<string, { from?: unknown } | undefined> | undefined} */ (transform);

    return ['column', 'value', 'row'].some(part => typeof parts?.[part]?.from === 'function');
}

/**
 * The adapter for postgres.js. `enqueue` then takes the `sql` of postgres.js (a transaction of its own) or the `sql` of
 * a transaction (the caller's: the job commits with it).
 * @param {PostgresJsSql} sql The queue's own `postgres(…)`: claims, leases, results. A small pool of its own is best,
 *     without a `transform` of results (sqlane reads its own columns).
 * @param {PostgresJsAdapterOptions} [options]
 * @returns {import('../types.js').Adapter<PostgresJsConnection>}
 */
export function postgresJsAdapter(sql, options = {}) {
    if (typeof sql?.unsafe !== 'function' || typeof sql.begin !== 'function' || !isPool(sql)) {
        throw new ConfigError('postgresJsAdapter: expects the sql of postgres(…) (postgres.js 3.4 or 4), not a transaction');
    }

    if (transformsResults(sql.options?.transform)) {
        throw new ConfigError('postgresJsAdapter: the queue\'s postgres.js must not transform results: give it its own');
    }

    const begin = /** @type {NonNullable<PostgresJsSql['begin']>} */ (sql.begin);

    return {
        dialect: 'postgres',
        wrap: executorOf,
        queue: executorOf(sql),
        withConnection: async (func) => {
            const reserved = await /** @type {NonNullable<PostgresJsSql['reserve']>} */ (sql.reserve)();

            try {
                return await func(executorOf(reserved));
            } finally {
                reserved.release();
            }
        },
        queueTransaction: func => begin.call(sql, 'isolation level read committed', tx => func(executorOf(tx))),
        // A transaction, or a reserved connection in one: as it is
        inTransaction: (connection, func) => (isPool(connection)
            ? /** @type {NonNullable<PostgresJsSql['begin']>} */ (connection.begin)('', tx => func(executorOf(tx)))
            : func(executorOf(connection))),
        // The pool: the enqueue ran in a transaction of its own, committed when it returned
        afterCommit: (connection, onCommit) => {
            if (!isPool(connection)) {
                return false;
            }

            onCommit();

            return true;
        },
        notify: options.notify ?? false,
        listen: async (channel, onMessage) => {
            // postgres.js listens on a connection of its own, and again after a reconnect
            const { unlisten } = await /** @type {NonNullable<PostgresJsSql['listen']>} */ (sql.listen)(
                channel,
                payload => onMessage(payload ?? ''),
            );

            return unlisten;
        },
    };
}
