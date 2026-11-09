import { expect, test } from 'vitest';
import { drizzleAdapter } from './drizzle.js';

/**
 * A class with a Drizzle kind, as Drizzle marks its classes.
 * @param {string} kind
 * @param {object} fields
 * @returns {any}
 */
function drizzleObject(kind, fields) {
    // `value.constructor[entityKind]`, through the prototype
    const prototype = { constructor: { [Symbol.for('drizzle:entityKind')]: kind } };

    return Object.assign(Object.create(prototype), fields);
}

/**
 * @param {string} sessionKind
 * @param {object} client
 * @returns {any} A Drizzle database, as far as the adapter reads it.
 */
function fakeDb(sessionKind, client) {
    return drizzleObject('Database', { session: drizzleObject(sessionKind, { client }), transaction: () => {} });
}

const mysqlPool = { getConnection: () => {} };
const pgPool = { totalCount: 0, connect: () => {} };

test.each([
    { sessionKind: 'MySql2Session', client: mysqlPool, dialect: 'mysql' },
    { sessionKind: 'NodePgSession', client: pgPool, dialect: 'postgres' },
])('$sessionKind: $dialect', ({ sessionKind, client, dialect }) => {
    expect(drizzleAdapter(fakeDb(sessionKind, client)).dialect).toBe(dialect);
});

test.each([
    { label: 'no database', db: undefined, message: 'expects a Drizzle database or transaction' },
    { label: 'Neon over HTTP', db: fakeDb('NeonHttpSession', pgPool), message: 'not "NeonHttpSession"' },
    {
        label: 'postgres.js, a reserved connection',
        db: fakeDb('PostgresJsSession', { unsafe: () => {}, reserve: () => {}, release: () => {} }),
        message: 'over a pool',
    },
    { label: 'a pg client, not a pool', db: fakeDb('NodePgSession', { connect: () => {} }), message: 'over a pool' },
    {
        label: 'a transaction',
        db: drizzleObject('NodePgTransaction', { session: { client: pgPool }, transaction: () => {} }),
        message: 'not a transaction',
    },
])('$label: a ConfigError', ({ db, message }) => {
    expect(() => drizzleAdapter(db)).toThrow(message);
});

test('MariaDB: a mysql2 Drizzle, with { dialect: \'mariadb\' }', () => {
    expect(drizzleAdapter(fakeDb('MySql2Session', mysqlPool), { dialect: 'mariadb' }).dialect).toBe('mariadb');
});

test('"dialect" on PostgreSQL: a ConfigError', () => {
    expect(() => drizzleAdapter(fakeDb('NodePgSession', pgPool), { dialect: 'mariadb' })).toThrow('"dialect" is for mysql2');
});

test('notify on MySQL: a ConfigError', () => {
    expect(() => drizzleAdapter(fakeDb('MySql2Session', mysqlPool), { notify: true })).toThrow('"notify" is for PostgreSQL');
});
