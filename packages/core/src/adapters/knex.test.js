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
])('the dialect of a $driverName knex: $expected', ({ dialect, driverName, expected }) => {
    expect(knexAdapter(fakeKnex(dialect, driverName)).dialect).toBe(expected);
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
