import { inject } from 'vitest';

/** @typedef {import('../../../src/types.js').Executor} Executor */
/** @typedef {(func: (executor: Executor) => Promise<number[]>) => Promise<number[]>} Run */

/**
 * Reads a row twice in a transaction that `runTransaction` opens, with a commit of another connection in between. READ
 * COMMITTED gives [0, 1]: each statement sees what committed before it; REPEATABLE READ gives [0, 0]. The claims of
 * MySQL and MariaDB rely on it: they read again, in a new statement, the payloads that the claim statement did not see.
 * @param {import('../../../src/types.js').Adapter<any>} adapter
 * @param {import('../../support/test_database.js').TestDatabaseConnection} database
 * @param {Run} [runTransaction] Default: the queue transaction of the adapter.
 * @returns {Promise<number[]>} The value before and after the commit.
 */
export async function readsAcrossCommit(adapter, database, runTransaction) {
    const run = runTransaction ?? (func => adapter.queueTransaction(func));
    const table = `${database.tablePrefix}isolation`;

    await database.query(`DROP TABLE IF EXISTS ${table}`);
    await database.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, v INT NOT NULL)`);
    await database.query(`INSERT INTO ${table} (id, v) VALUES (1, 0)`);

    const seen = await run(async (executor) => {
        const [before] = await executor.query(`SELECT v FROM ${table} WHERE id = 1`, []);

        await database.query(`UPDATE ${table} SET v = 1 WHERE id = 1`);

        const [after] = await executor.query(`SELECT v FROM ${table} WHERE id = 1`, []);

        return [Number(before.v), Number(after.v)];
    });

    await database.query(`DROP TABLE ${table}`);

    return seen;
}

/**
 * The transaction that `adapter.poolTransaction` opens on a pool given as `connection`: READ COMMITTED. MySQL and
 * MariaDB default to REPEATABLE READ, so a read across a commit shows it. PostgreSQL defaults to READ COMMITTED, so
 * there the pool is one of `openPool`, on a role whose sessions default to REPEATABLE READ (checked), and the check
 * reads the level of the transaction.
 * @param {import('../../../src/types.js').Adapter<any>} adapter
 * @param {import('../../support/test_database.js').TestDatabaseConnection} database
 * @param {unknown} pool A connection that the adapter takes as a pool (MySQL and MariaDB).
 * @param {(url: string) => Promise<{ pool: unknown, close: () => Promise<unknown> }>} openPool PostgreSQL: the same
 *     kind of pool, on `url`.
 * @returns {Promise<unknown>} `[0, 1]` on MySQL and MariaDB, `'read committed'` on PostgreSQL.
 */
export async function poolTransactionIsolation(adapter, database, pool, openPool) {
    /**
     * @param {unknown} on
     * @returns {(func: (executor: any) => Promise<any>) => Promise<any>}
     */
    const inPoolTransaction = on => (func) => {
        const running = adapter.poolTransaction?.(on, func);

        if (!running) {
            throw new Error('poolTransaction: null for a pool');
        }

        return running;
    };

    if (database.family !== 'postgres') {
        return readsAcrossCommit(adapter, database, inPoolTransaction(pool));
    }

    // A role whose sessions default to REPEATABLE READ, created once by the global setup
    const opened = await openPool(inject('repeatableReadUrl'));

    try {
        return await inPoolTransaction(opened.pool)(async (executor) => {
            const [row] = await executor.query(`SELECT current_setting('transaction_isolation') AS level,
                current_setting('default_transaction_isolation') AS fallback`, []);

            // Else a pool on the default level would pass without poolTransaction setting it
            if (String(row.fallback) !== 'repeatable read') {
                throw new Error(`poolTransactionIsolation: the pool defaults to ${String(row.fallback)}`);
            }

            return String(row.level);
        });
    } finally {
        await opened.close();
    }
}

/**
 * The isolation that a test expects from `poolTransactionIsolation`.
 * @param {import('../../support/test_database.js').TestDatabaseConnection} database
 * @returns {unknown}
 */
export function readCommitted(database) {
    return database.family === 'postgres' ? 'read committed' : [0, 1];
}
