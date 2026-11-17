import { expect, test } from 'vitest';
import { ConfigError } from '../errors.js';
import { mysql2Adapter } from './mysql2.js';

const pool = /** @type {any} */ ({ getConnection: () => {}, query: () => {}, execute: () => {} });

test.each([
    { label: 'MySQL', options: { dialect: 'mysql' }, expected: 'mysql' },
    { label: 'MariaDB', options: { dialect: 'mariadb' }, expected: 'mariadb' },
])('$label: dialect $expected', ({ options, expected }) => {
    expect(mysql2Adapter(pool, /** @type {any} */ (options)).dialect).toBe(expected);
});

test.each([
    { label: 'no options', options: undefined, message: 'mysql2Adapter: "dialect" is required: "mysql" or "mariadb"' },
    { label: 'no dialect', options: {}, message: 'mysql2Adapter: "dialect" is required: "mysql" or "mariadb"' },
    {
        label: 'another dialect',
        options: { dialect: 'postgres' },
        message: 'mysql2Adapter: "dialect" must be "mysql" or "mariadb", not "postgres"',
    },
    {
        label: 'a non-boolean allowUnsupportedDbVersion',
        options: { dialect: 'mysql', allowUnsupportedDbVersion: 'yes' },
        message: 'mysql2Adapter: "allowUnsupportedDbVersion" must be a boolean',
    },
    {
        label: 'a non-boolean allowUnsupportedDbConfiguration',
        options: { dialect: 'mysql', allowUnsupportedDbConfiguration: 'yes' },
        message: 'mysql2Adapter: "allowUnsupportedDbConfiguration" must be a boolean',
    },
])('$label: a ConfigError', ({ options, message }) => {
    expect(() => mysql2Adapter(pool, /** @type {any} */ (options))).toThrow(new ConfigError(message));
});

test.each([
    { options: { dialect: /** @type {const} */ ('mysql') }, expected: false },
    { options: { dialect: /** @type {const} */ ('mysql'), allowUnsupportedDbVersion: true }, expected: true },
])('allowUnsupportedDbVersion: $expected', ({ options, expected }) => {
    expect(mysql2Adapter(pool, options).allowUnsupportedDbVersion).toBe(expected);
});

test.each([
    { options: { dialect: /** @type {const} */ ('mysql') }, expected: false },
    { options: { dialect: /** @type {const} */ ('mysql'), allowUnsupportedDbConfiguration: null }, expected: false },
    { options: { dialect: /** @type {const} */ ('mariadb'), allowUnsupportedDbConfiguration: true }, expected: true },
])('allowUnsupportedDbConfiguration: $expected', ({ options, expected }) => {
    const adapter = mysql2Adapter(pool, /** @type {any} */ (options));

    expect(adapter).toMatchObject({ allowUnsupportedDbVersion: false, allowUnsupportedDbConfiguration: expected });
});
