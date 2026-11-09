import { expect, test } from 'vitest';
import { postgresJsAdapter } from './postgres_js.js';

function method() {}

/**
 * @param {object} [options] The options of postgres.js.
 * @returns {any} The sql of postgres(…), as far as the adapter reads it.
 */
function fakeSql(options = {}) {
    return { unsafe: method, begin: method, reserve: method, listen: method, options };
}

test.each([
    { label: 'no sql', sql: undefined, message: 'expects the sql of postgres(…)' },
    { label: 'a transaction', sql: { unsafe: method, begin: method, savepoint: method }, message: 'not a transaction' },
    { label: 'a reserved connection', sql: { ...fakeSql(), release: method }, message: 'not a transaction' },
    {
        label: 'a transform of column names',
        sql: fakeSql({ transform: { column: { from: method } } }),
        message: 'must not transform results',
    },
    { label: 'a transform of rows', sql: fakeSql({ transform: { row: { from: method } } }), message: 'must not transform' },
])('$label: a ConfigError', ({ sql, message }) => {
    expect(() => postgresJsAdapter(/** @type {any} */ (sql))).toThrow(message);
});

test('a transform of the values sent only: accepted', () => {
    const sql = fakeSql({ transform: { undefined: null, column: { from: undefined, to: method } } });

    expect(postgresJsAdapter(sql).dialect).toBe('postgres');
});

test('afterCommit: the pool wakes at once; a transaction has no hook', () => {
    const adapter = postgresJsAdapter(fakeSql());
    let wakes = 0;

    expect(adapter.afterCommit?.(fakeSql(), () => wakes++)).toBe(true);
    const transaction = /** @type {any} */ ({ unsafe: method, savepoint: method });

    expect(adapter.afterCommit?.(transaction, () => wakes++)).toBe(false);
    expect(wakes).toBe(1);
});
