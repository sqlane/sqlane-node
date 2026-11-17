import { expect, test } from 'vitest';
import { ConfigError } from '../errors.js';
import { sequelizeAdapter } from './sequelize.js';

function method() {}

/**
 * @param {string} dialect
 * @param {string} version The static `version` of its class.
 * @returns {any} A Sequelize instance, as far as the adapter reads it.
 */
function fakeSequelize(dialect, version) {
    const prototype = { constructor: { version } };

    return Object.assign(Object.create(prototype), {
        getDialect: () => dialect,
        transaction: method,
        connectionManager: { getConnection: method, releaseConnection: method },
    });
}

test.each([
    { sequelizeDialect: 'mysql', dialect: 'mysql' },
    { sequelizeDialect: 'mysql', dialect: 'mariadb' },
    { sequelizeDialect: 'mariadb', dialect: 'mariadb' },
    { sequelizeDialect: 'postgres', dialect: 'postgres' },
])('the "$sequelizeDialect" dialect of Sequelize, dialect $dialect', ({ sequelizeDialect, dialect }) => {
    expect(sequelizeAdapter(fakeSequelize(sequelizeDialect, '6.37.8'), /** @type {any} */ ({ dialect })))
        .toMatchObject({ dialect, allowUnsupportedDbVersion: false, allowUnsupportedDbConfiguration: false });
});

test('allowUnsupportedDbVersion: true', () => {
    const options = /** @type {const} */ ({ dialect: 'mysql', allowUnsupportedDbVersion: true });

    expect(sequelizeAdapter(fakeSequelize('mysql', '6.37.8'), options).allowUnsupportedDbVersion).toBe(true);
});

test('allowUnsupportedDbConfiguration: true', () => {
    const options = /** @type {const} */ ({ dialect: 'mariadb', allowUnsupportedDbConfiguration: true });

    expect(sequelizeAdapter(fakeSequelize('mariadb', '6.37.8'), options).allowUnsupportedDbConfiguration).toBe(true);
});

test.each([
    {
        label: 'no options',
        sequelize: fakeSequelize('mysql', '6.37.8'),
        options: undefined,
        message: 'sequelizeAdapter: "dialect" is required: "mysql", "mariadb" or "postgres"',
    },
    {
        label: 'another dialect',
        sequelize: fakeSequelize('mysql', '6.37.8'),
        options: { dialect: 'sqlite' },
        message: 'sequelizeAdapter: "dialect" must be "mysql", "mariadb" or "postgres", not "sqlite"',
    },
    {
        label: '"mysql" on the "mariadb" dialect',
        sequelize: fakeSequelize('mariadb', '6.37.8'),
        options: { dialect: 'mysql' },
        message: 'sequelizeAdapter: "dialect" is "mysql", but the dialect of Sequelize is "mariadb": "mariadb"',
    },
    {
        label: '"mariadb" on the "postgres" dialect',
        sequelize: fakeSequelize('postgres', '6.37.8'),
        options: { dialect: 'mariadb' },
        message: 'sequelizeAdapter: "dialect" is "mariadb", but the dialect of Sequelize is "postgres": "postgres"',
    },
    {
        label: '"postgres" on the "mysql" dialect',
        sequelize: fakeSequelize('mysql', '6.37.8'),
        options: { dialect: 'postgres' },
        message: 'sequelizeAdapter: "dialect" is "postgres", but the dialect of Sequelize is "mysql": "mysql" or '
            + '"mariadb"',
    },
    {
        label: 'a non-boolean allowUnsupportedDbVersion',
        sequelize: fakeSequelize('postgres', '6.37.8'),
        options: { dialect: 'postgres', allowUnsupportedDbVersion: 'yes' },
        message: 'sequelizeAdapter: "allowUnsupportedDbVersion" must be a boolean',
    },
    {
        label: 'a non-boolean allowUnsupportedDbConfiguration',
        sequelize: fakeSequelize('mysql', '6.37.8'),
        options: { dialect: 'mysql', allowUnsupportedDbConfiguration: 'yes' },
        message: 'sequelizeAdapter: "allowUnsupportedDbConfiguration" must be a boolean',
    },
])('$label: a ConfigError', ({ sequelize, options, message }) => {
    expect(() => sequelizeAdapter(sequelize, /** @type {any} */ (options))).toThrow(new ConfigError(message));
});

test.each([
    { label: 'no instance', sequelize: undefined, message: 'expects a Sequelize instance (Sequelize 6)' },
    { label: 'Sequelize 7', sequelize: fakeSequelize('postgres', '7.0.0-alpha.48'), message: 'not "7.0.0-alpha.48"' },
    { label: 'SQLite', sequelize: fakeSequelize('sqlite', '6.37.8'), message: 'not "sqlite"' },
])('$label: a ConfigError', ({ sequelize, message }) => {
    expect(() => sequelizeAdapter(sequelize, { dialect: 'postgres' })).toThrow(message);
});

test('postgres: { prepare: true } is accepted', () => {
    expect(sequelizeAdapter(fakeSequelize('postgres', '6.37.8'), { dialect: 'postgres', prepare: true }).dialect)
        .toBe('postgres');
});

test.each(['mysql', 'mariadb'])('{ prepare: true } on the "%s" dialect: a ConfigError', (dialect) => {
    expect(() => sequelizeAdapter(fakeSequelize(dialect, '6.37.8'), { dialect: 'mariadb', prepare: true }))
        .toThrow('"prepare" is for the "postgres" dialect');
});
