import { expect, test } from 'vitest';
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

test.each([{ dialect: 'mysql' }, { dialect: 'postgres' }])('dialect $dialect', ({ dialect }) => {
    expect(sequelizeAdapter(fakeSequelize(dialect, '6.37.8')).dialect).toBe(dialect);
});

test.each([
    { label: 'no instance', sequelize: undefined, message: 'expects a Sequelize instance (Sequelize 6)' },
    { label: 'Sequelize 7', sequelize: fakeSequelize('postgres', '7.0.0-alpha.48'), message: 'not "7.0.0-alpha.48"' },
    { label: 'MariaDB', sequelize: fakeSequelize('mariadb', '6.37.8'), message: 'not "mariadb"' },
    { label: 'SQLite', sequelize: fakeSequelize('sqlite', '6.37.8'), message: 'not "sqlite"' },
])('$label: a ConfigError', ({ sequelize, message }) => {
    expect(() => sequelizeAdapter(sequelize)).toThrow(message);
});
