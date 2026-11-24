import { handle, testLane, runnerOf } from '../../support/runners.js';

/** PostgreSQL: the named prepared statements of sqlane (`sqlane_<hash>`) on the connection that runs it */
export const SQLANE_STATEMENTS_SQL = 'SELECT count(*)::int AS statements FROM pg_prepared_statements '
    + 'WHERE name LIKE \'sqlane\\_%\'';

/**
 * Migrates, enqueues a job on the queue's own instance and drains it, over a queue pool of one connection; then counts
 * the named prepared statements of sqlane on that connection.
 * @template C
 * @param {import('../../../src/types.js').Sqlane<C>} sqlane Over a queue pool of one connection.
 * @param {C} connection The queue's own instance: the enqueue runs on the same connection.
 * @param {(sql: string) => Promise<readonly Record<string, unknown>[]>} query Runs SQL on that connection.
 * @returns {Promise<number>}
 */
export async function preparedAfterAJob(sqlane, connection, query) {
    await sqlane.schema.migrate();
    runnerOf(sqlane).mount([handle('ping', () => {})]);
    await sqlane.enqueue(connection, testLane('ping'), {});

    const { completed } = await runnerOf(sqlane).drain();

    if (completed !== 1) {
        throw new Error(`preparedAfterAJob: ${completed} jobs completed, not 1`);
    }

    const [{ statements }] = await query(SQLANE_STATEMENTS_SQL);

    return Number(statements);
}
