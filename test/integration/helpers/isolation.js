/**
 * Reads a row twice in the queue transaction of the adapter, with a commit of another connection in between. READ
 * COMMITTED gives [0, 1]: each statement sees what committed before it; REPEATABLE READ gives [0, 0]. The claims of
 * MySQL and MariaDB rely on it: they read again, in a new statement, the payloads that the claim statement did not see.
 * @param {import('../../../src/types.js').Adapter<any>} adapter
 * @param {import('../../support/test_database.js').TestDatabaseConnection} database
 * @returns {Promise<number[]>} The value before and after the commit.
 */
export async function readsAcrossCommit(adapter, database) {
    const table = `${database.tablePrefix}isolation`;

    await database.query(`DROP TABLE IF EXISTS ${table}`);
    await database.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, v INT NOT NULL)`);
    await database.query(`INSERT INTO ${table} (id, v) VALUES (1, 0)`);

    const seen = await adapter.queueTransaction(async (executor) => {
        const [before] = await executor.query(`SELECT v FROM ${table} WHERE id = 1`, []);

        await database.query(`UPDATE ${table} SET v = 1 WHERE id = 1`);

        const [after] = await executor.query(`SELECT v FROM ${table} WHERE id = 1`, []);

        return [Number(before.v), Number(after.v)];
    });

    await database.query(`DROP TABLE ${table}`);

    return seen;
}
