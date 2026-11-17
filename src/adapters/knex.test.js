import { expect, test } from 'vitest';
import { ConfigError } from '../errors.js';
import { knexAdapter } from './knex.js';

/**
 * @param {string} dialect
 * @param {string} driverName
 * @returns {import('knex').Knex} A knex instance, as far as the adapter reads it.
 */
function fakeKnex(dialect, driverName) {
    return /** @type {any} */ ({ transaction: () => {}, client: { dialect, driverName, acquireConnection: () => {} } });
}

test.each([
    { dialect: 'mysql', driverName: 'mysql2', given: 'mysql' },
    { dialect: 'mysql', driverName: 'mysql2', given: 'mariadb' },
    { dialect: 'mysql', driverName: 'mariadb', given: 'mariadb' },
    { dialect: 'postgresql', driverName: 'pg', given: 'postgres' },
])('a $driverName knex, dialect $given', ({ dialect, driverName, given }) => {
    expect(knexAdapter(fakeKnex(dialect, driverName), /** @type {any} */ ({ dialect: given })))
        .toMatchObject({ dialect: given, allowUnsupportedDbVersion: false, allowUnsupportedDbConfiguration: false });
});

test.each([
    {
        label: 'no options',
        knex: fakeKnex('mysql', 'mysql2'),
        options: undefined,
        message: 'knexAdapter: "dialect" is required: "mysql", "mariadb" or "postgres"',
    },
    {
        label: 'no dialect on a pg knex',
        knex: fakeKnex('postgresql', 'pg'),
        options: { prepare: true },
        message: 'knexAdapter: "dialect" is required: "mysql", "mariadb" or "postgres"',
    },
    {
        label: 'the client name of knex',
        knex: fakeKnex('postgresql', 'pg'),
        options: { dialect: 'postgresql' },
        message: 'knexAdapter: "dialect" must be "mysql", "mariadb" or "postgres", not "postgresql"',
    },
    {
        label: '"postgres" on a mysql2 knex',
        knex: fakeKnex('mysql', 'mysql2'),
        options: { dialect: 'postgres' },
        message: 'knexAdapter: "dialect" is "postgres", but the client of knex is "mysql2": "mysql" or "mariadb"',
    },
    {
        label: '"mysql" on a mariadb knex',
        knex: fakeKnex('mysql', 'mariadb'),
        options: { dialect: 'mysql' },
        message: 'knexAdapter: "dialect" is "mysql", but the client of knex is "mariadb": "mariadb"',
    },
    {
        label: '"mariadb" on a pg knex',
        knex: fakeKnex('postgresql', 'pg'),
        options: { dialect: 'mariadb' },
        message: 'knexAdapter: "dialect" is "mariadb", but the client of knex is "pg": "postgres"',
    },
    {
        label: 'a non-boolean allowUnsupportedDbVersion',
        knex: fakeKnex('mysql', 'mysql2'),
        options: { dialect: 'mysql', allowUnsupportedDbVersion: 'yes' },
        message: 'knexAdapter: "allowUnsupportedDbVersion" must be a boolean',
    },
    {
        label: 'a non-boolean allowUnsupportedDbConfiguration',
        knex: fakeKnex('mysql', 'mysql2'),
        options: { dialect: 'mysql', allowUnsupportedDbConfiguration: 'yes' },
        message: 'knexAdapter: "allowUnsupportedDbConfiguration" must be a boolean',
    },
])('$label: a ConfigError', ({ knex, options, message }) => {
    expect(() => knexAdapter(knex, /** @type {any} */ (options))).toThrow(new ConfigError(message));
});

test('allowUnsupportedDbVersion: true', () => {
    const adapter = knexAdapter(fakeKnex('postgresql', 'pg'), { dialect: 'postgres', allowUnsupportedDbVersion: true });

    expect(adapter.allowUnsupportedDbVersion).toBe(true);
});

test('allowUnsupportedDbConfiguration: true', () => {
    const adapter = knexAdapter(fakeKnex('mysql', 'mysql2'), { dialect: 'mysql', allowUnsupportedDbConfiguration: true });

    expect(adapter.allowUnsupportedDbConfiguration).toBe(true);
});

test.each([
    { dialect: 'mysql', driverName: 'mysql' },
    { dialect: 'sqlite3', driverName: 'sqlite3' },
    { dialect: 'postgresql', driverName: 'pgnative' },
])('a $driverName knex: a ConfigError', ({ dialect, driverName }) => {
    expect(() => knexAdapter(fakeKnex(dialect, driverName), { dialect: 'mysql' })).toThrow(ConfigError);
});

test.each([
    { label: 'no knex', knex: undefined },
    { label: 'a mysql2 pool', knex: { query: () => {} } },
])('$label: a ConfigError', ({ knex }) => {
    expect(() => knexAdapter(/** @type {any} */ (knex), { dialect: 'mysql' })).toThrow('expects a knex instance (knex 3)');
});

test('pg: { prepare: true } is accepted', () => {
    expect(knexAdapter(fakeKnex('postgresql', 'pg'), { dialect: 'postgres', prepare: true }).dialect).toBe('postgres');
});

test.each([
    { dialect: 'mysql', driverName: 'mysql2' },
    { dialect: 'mysql', driverName: 'mariadb' },
])('{ prepare: true } on a $driverName knex: a ConfigError', ({ dialect, driverName }) => {
    expect(() => knexAdapter(fakeKnex(dialect, driverName), { dialect: 'mariadb', prepare: true }))
        .toThrow('"prepare" is for PostgreSQL');
});

const NAMED = expect.objectContaining({ name: expect.stringMatching(/^sqlane_/), text: 'SELECT 1' });

test.each([
    { prepare: true, sent: NAMED },
    { prepare: false, sent: 'SELECT 1' },
    { prepare: undefined, sent: 'SELECT 1' },
])('pg, prepare: $prepare: the query that the pg client gets', async ({ prepare, sent: expected }) => {
    /** @type {unknown[]} */
    const sent = [];
    const connection = {
        query: async (/** @type {unknown} */ query) => {
            sent.push(query);

            return { rows: [], rowCount: 0 };
        },
    };
    const knex = /** @type {any} */ ({
        transaction: () => {},
        client: {
            dialect: 'postgresql',
            driverName: 'pg',
            acquireConnection: async () => connection,
            releaseConnection: async () => {},
        },
    });

    await knexAdapter(knex, { dialect: 'postgres', prepare }).queue.query('SELECT 1', []);

    expect(sent).toStrictEqual([expected]);
});
