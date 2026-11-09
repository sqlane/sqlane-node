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
    { dialect: 'mysql', driverName: 'mysql2', expected: 'mysql' },
    { dialect: 'postgresql', driverName: 'pg', expected: 'postgres' },
    { dialect: 'mysql', driverName: 'mariadb', expected: 'mariadb' },
])('the dialect of a $driverName knex: $expected', ({ dialect, driverName, expected }) => {
    expect(knexAdapter(fakeKnex(dialect, driverName)).dialect).toBe(expected);
});

test('MariaDB: a mysql2 knex, with { dialect: \'mariadb\' }', () => {
    expect(knexAdapter(fakeKnex('mysql', 'mysql2'), { dialect: 'mariadb' }).dialect).toBe('mariadb');
});

test.each([
    {
        label: '"dialect" on a pg knex',
        knex: fakeKnex('postgresql', 'pg'),
        dialect: 'mariadb',
        message: '"dialect" is for mysql2',
    },
    {
        label: '"dialect": "mysql" on a mariadb knex',
        knex: fakeKnex('mysql', 'mariadb'),
        dialect: 'mysql',
        message: '"dialect" must be "mariadb"',
    },
    {
        label: 'another "dialect"',
        knex: fakeKnex('mysql', 'mysql2'),
        dialect: 'sqlite',
        message: '"dialect" must be "mysql" or "mariadb"',
    },
])('$label: a ConfigError', ({ knex, dialect, message }) => {
    expect(() => knexAdapter(knex, /** @type {any} */ ({ dialect }))).toThrow(message);
});

test.each([
    { dialect: 'mysql', driverName: 'mysql' },
    { dialect: 'sqlite3', driverName: 'sqlite3' },
    { dialect: 'postgresql', driverName: 'pgnative' },
])('a $driverName knex: a ConfigError', ({ dialect, driverName }) => {
    expect(() => knexAdapter(fakeKnex(dialect, driverName))).toThrow(ConfigError);
});

test.each([
    { label: 'no knex', knex: undefined },
    { label: 'a mysql2 pool', knex: { query: () => {} } },
])('$label: a ConfigError', ({ knex }) => {
    expect(() => knexAdapter(/** @type {any} */ (knex))).toThrow('expects a knex instance (knex 3)');
});
