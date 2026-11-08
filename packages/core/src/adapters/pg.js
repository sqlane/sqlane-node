/** @typedef {import('pg').Pool | import('pg').PoolClient | import('pg').Client} PgConnection */

/**
 * @typedef {object} PgAdapterOptions
 * @property {boolean} [notify] Hints by LISTEN/NOTIFY: `pg_notify` in the enqueue transaction, delivered on commit.
 *     Default: false.
 */

/**
 * @param {PgConnection} connection
 * @returns {import('../types.js').Executor}
 */
function toExecutor(connection) {
    return {
        query: async (sql, params) => {
            const result = await connection.query(sql, [...params]);

            return result.rows;
        },
        run: async (sql, params) => {
            const result = await connection.query(sql, [...params]);

            return result.rowCount ?? 0;
        },
    };
}

/**
 * @param {PgConnection} connection
 * @returns {connection is import('pg').Pool}
 */
function isPool(connection) {
    return typeof (/** @type {{ totalCount?: unknown }} */ (connection).totalCount) === 'number';
}

/**
 * Runs func in a transaction of its own, on a client of the pool.
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(executor: import('../types.js').Executor) => Promise<T>} func
 * @param {boolean} [readCommitted] Default: false: the isolation level of the session.
 * @returns {Promise<T>}
 */
async function inOwnTransaction(pool, func, readCommitted = false) {
    const client = await pool.connect();

    try {
        await client.query(readCommitted ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN');

        try {
            const result = await func(toExecutor(client));

            await client.query('COMMIT');

            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    } finally {
        client.release();
    }
}

/**
 * LISTEN on a client of its own, taken from the pool; on an error of the client, listens again on a new one.
 * @param {import('pg').Pool} pool
 * @param {string} channel A safe identifier: `<tablePrefix>ready`.
 * @param {(message: string) => void} onMessage
 * @returns {Promise<() => Promise<void>>} Unlisten.
 */
async function listen(pool, channel, onMessage) {
    /** @type {import('pg').PoolClient | null} */
    let client = null;
    let stopped = false;

    /** @param {import('pg').Notification} notification */
    const onNotification = (notification) => {
        if (notification.channel === channel) {
            onMessage(notification.payload ?? '');
        }
    };

    /** @returns {Promise<void>} */
    const connect = async () => {
        const next = await pool.connect();

        next.on('notification', onNotification);
        next.once('error', (error) => {
            next.release(error);

            if (client === next) {
                client = null;
            }

            reconnectLater();
        });
        await next.query(`LISTEN "${channel}"`);
        client = next;
    };

    /** Listens again in 1 s, until it works or the listener stops. */
    function reconnectLater() {
        if (stopped) {
            return;
        }

        setTimeout(async () => {
            try {
                await connect();
            } catch {
                reconnectLater();
            }
        }, 1000).unref();
    }

    await connect();

    return async () => {
        stopped = true;

        const current = client;

        client = null;

        if (current) {
            try {
                await current.query(`UNLISTEN "${channel}"`);
            } finally {
                current.removeListener('notification', onNotification);
                current.release();
            }
        }
    };
}

/**
 * The adapter for pg. `enqueue` then takes a `Client`, a `PoolClient` (in a transaction) or a `Pool`.
 * @param {import('pg').Pool} pool The queue's own pool: claims, leases, results.
 * @param {PgAdapterOptions} [options]
 * @returns {import('../types.js').Adapter<PgConnection>}
 */
export function pgAdapter(pool, options = {}) {
    return {
        dialect: 'postgres',
        wrap: toExecutor,
        queue: toExecutor(pool),
        withConnection: async (func) => {
            const client = await pool.connect();

            try {
                return await func(toExecutor(client));
            } finally {
                client.release();
            }
        },
        queueTransaction: func => inOwnTransaction(pool, func, true),
        inTransaction: (connection, func) => (isPool(connection)
            ? inOwnTransaction(connection, func)
            : func(toExecutor(connection))),
        notify: options.notify ?? false,
        listen: (channel, onMessage) => listen(pool, channel, onMessage),
    };
}
