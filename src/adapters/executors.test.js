import { expect, test } from 'vitest';
import { mariadbExecutor } from './executors.js';

/**
 * A connection of the mariadb driver that answers each query with result.
 * @param {'promise' | 'callback'} api
 * @param {unknown} result
 * @returns {{ connection: any, calls: unknown[][] }}
 */
function fakeMariadb(api, result) {
    /** @type {unknown[][]} */
    const calls = [];
    const connection = {
        query: (/** @type {unknown} */ options, /** @type {unknown[]} */ values, /** @type {any} */ callback) => {
            calls.push([options, values]);

            if (api === 'promise') {
                return Promise.resolve(result);
            }

            queueMicrotask(() => callback(null, result));

            return undefined;
        },
    };

    return { connection, calls };
}

test.each(['promise', 'callback'])('%s API: query returns the rows; BIGINT as a number', async (api) => {
    const rows = [{ id: 'a' }];
    const { connection, calls } = fakeMariadb(/** @type {any} */ (api), rows);

    await expect(mariadbExecutor(connection, /** @type {any} */ (api)).query('SELECT ?', [1])).resolves.toBe(rows);
    expect(calls).toStrictEqual([[{ sql: 'SELECT ?', bigIntAsNumber: true }, [1]]]);
});

test.each(['promise', 'callback'])('%s API: run returns the affected rows', async (api) => {
    const { connection } = fakeMariadb(/** @type {any} */ (api), { affectedRows: 3, insertId: 0, warningStatus: 0 });

    await expect(mariadbExecutor(connection, /** @type {any} */ (api)).run('UPDATE t SET a = 1', [])).resolves.toBe(3);
});

test('a write: query returns no rows', async () => {
    const { connection } = fakeMariadb('promise', { affectedRows: 1 });

    await expect(mariadbExecutor(connection, 'promise').query('DELETE FROM t', [])).resolves.toStrictEqual([]);
});

test('callback API: an error rejects', async () => {
    const connection = {
        query: (/** @type {unknown} */ _options, /** @type {unknown} */ _values, /** @type {any} */ callback) => {
            callback(new Error('boom'));
        },
    };

    await expect(mariadbExecutor(connection, 'callback').query('SELECT 1', [])).rejects.toThrow('boom');
});
