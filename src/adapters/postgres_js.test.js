import { expect, test } from 'vitest';
import { postgresJsAdapter } from './postgres_js.js';

function method() {}

const OPTIONS = /** @type {const} */ ({ dialect: 'postgres' });

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
    expect(() => postgresJsAdapter(/** @type {any} */ (sql), OPTIONS)).toThrow(message);
});

test.each([
    { label: 'no options', options: undefined, message: 'postgresJsAdapter: "dialect" is required: "postgres"' },
    { label: 'no dialect', options: { notify: true }, message: 'postgresJsAdapter: "dialect" is required: "postgres"' },
    {
        label: 'the alias postgresql',
        options: { dialect: 'postgresql' },
        message: 'postgresJsAdapter: "dialect" must be "postgres", not "postgresql"',
    },
    { label: 'MariaDB', options: { dialect: 'mariadb' }, message: '"dialect" must be "postgres", not "mariadb"' },
    {
        label: 'a non-boolean allowUnsupportedDbVersion',
        options: { dialect: 'postgres', allowUnsupportedDbVersion: 'no' },
        message: '"allowUnsupportedDbVersion" must be a boolean',
    },
    {
        label: 'a non-boolean allowUnsupportedDbConfiguration',
        options: { dialect: 'postgres', allowUnsupportedDbConfiguration: 'no' },
        message: '"allowUnsupportedDbConfiguration" must be a boolean',
    },
])('$label: a ConfigError', ({ options, message }) => {
    expect(() => postgresJsAdapter(fakeSql(), /** @type {any} */ (options))).toThrow(message);
});

test.each([
    { options: OPTIONS, expected: false },
    { options: { ...OPTIONS, allowUnsupportedDbVersion: true }, expected: true },
])('allowUnsupportedDbVersion: $expected', ({ options, expected }) => {
    expect(postgresJsAdapter(fakeSql(), options)).toMatchObject({ dialect: 'postgres', allowUnsupportedDbVersion: expected });
});

test.each([
    { options: OPTIONS, expected: false },
    { options: { ...OPTIONS, allowUnsupportedDbConfiguration: true }, expected: true },
])('allowUnsupportedDbConfiguration: $expected', ({ options, expected }) => {
    expect(postgresJsAdapter(fakeSql(), options).allowUnsupportedDbConfiguration).toBe(expected);
});

test('a transform of the values sent only: accepted', () => {
    const sql = fakeSql({ transform: { undefined: null, column: { from: undefined, to: method } } });

    expect(postgresJsAdapter(sql, OPTIONS).dialect).toBe('postgres');
});

test('afterCommit: the pool wakes at once; a transaction has no hook', () => {
    const adapter = postgresJsAdapter(fakeSql(), OPTIONS);
    let wakes = 0;

    expect(adapter.afterCommit?.(fakeSql(), () => wakes++)).toBe(true);
    const transaction = /** @type {any} */ ({ unsafe: method, savepoint: method });

    expect(adapter.afterCommit?.(transaction, () => wakes++)).toBe(false);
    expect(wakes).toBe(1);
});
