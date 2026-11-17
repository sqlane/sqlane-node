import { expect, test } from 'vitest';
import { ConfigError } from '../errors.js';
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
const postgresJsPool = { unsafe: () => {}, begin: () => {}, reserve: () => {} };

test.each([
    { sessionKind: 'MySql2Session', client: mysqlPool, dialect: 'mysql' },
    { sessionKind: 'MySql2Session', client: mysqlPool, dialect: 'mariadb' },
    { sessionKind: 'NodePgSession', client: pgPool, dialect: 'postgres' },
    { sessionKind: 'PostgresJsSession', client: postgresJsPool, dialect: 'postgres' },
])('$sessionKind: $dialect', ({ sessionKind, client, dialect }) => {
    expect(drizzleAdapter(fakeDb(sessionKind, client), /** @type {any} */ ({ dialect })))
        .toMatchObject({ dialect, allowUnsupportedVersion: false });
});

test.each([
    { sessionKind: 'MySql2Session', client: mysqlPool, dialect: 'mariadb' },
    { sessionKind: 'NodePgSession', client: pgPool, dialect: 'postgres' },
    { sessionKind: 'PostgresJsSession', client: postgresJsPool, dialect: 'postgres' },
])('$sessionKind: allowUnsupportedVersion reaches the adapter', ({ sessionKind, client, dialect }) => {
    const options = /** @type {any} */ ({ dialect, allowUnsupportedVersion: true });

    expect(drizzleAdapter(fakeDb(sessionKind, client), options).allowUnsupportedVersion).toBe(true);
});

test.each([
    {
        label: 'no options',
        db: fakeDb('MySql2Session', mysqlPool),
        options: undefined,
        message: 'drizzleAdapter: "dialect" is required: "mysql", "mariadb" or "postgres"',
    },
    {
        label: 'no dialect',
        db: fakeDb('NodePgSession', pgPool),
        options: { notify: true },
        message: 'drizzleAdapter: "dialect" is required: "mysql", "mariadb" or "postgres"',
    },
    {
        label: 'another dialect',
        db: fakeDb('NodePgSession', pgPool),
        options: { dialect: 'pg' },
        message: 'drizzleAdapter: "dialect" must be "mysql", "mariadb" or "postgres", not "pg"',
    },
    {
        label: '"mariadb" on node-postgres',
        db: fakeDb('NodePgSession', pgPool),
        options: { dialect: 'mariadb' },
        message: 'drizzleAdapter: "dialect" is "mariadb", but Drizzle uses node-postgres: "postgres"',
    },
    {
        label: '"mysql" on postgres.js',
        db: fakeDb('PostgresJsSession', postgresJsPool),
        options: { dialect: 'mysql' },
        message: 'drizzleAdapter: "dialect" is "mysql", but Drizzle uses postgres.js: "postgres"',
    },
    {
        label: '"postgres" on mysql2',
        db: fakeDb('MySql2Session', mysqlPool),
        options: { dialect: 'postgres' },
        message: 'drizzleAdapter: "dialect" is "postgres", but Drizzle uses mysql2: "mysql" or "mariadb"',
    },
    {
        label: 'a non-boolean allowUnsupportedVersion',
        db: fakeDb('MySql2Session', mysqlPool),
        options: { dialect: 'mysql', allowUnsupportedVersion: 'yes' },
        message: 'drizzleAdapter: "allowUnsupportedVersion" must be a boolean',
    },
])('$label: a ConfigError', ({ db, options, message }) => {
    expect(() => drizzleAdapter(db, /** @type {any} */ (options))).toThrow(new ConfigError(message));
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
    expect(() => drizzleAdapter(db, { dialect: 'postgres' })).toThrow(message);
});

test('notify on MySQL: a ConfigError', () => {
    expect(() => drizzleAdapter(fakeDb('MySql2Session', mysqlPool), { dialect: 'mysql', notify: true }))
        .toThrow('"notify" is for PostgreSQL');
});
