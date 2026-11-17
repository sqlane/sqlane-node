import { expect, test } from 'vitest';
import { ConfigError } from '../errors.js';
import { kyselyAdapter } from './kysely.js';

function method() {}

/** @returns {import('kysely').Kysely<any>} A Kysely instance, as far as the adapter reads it. */
function fakeKysely() {
    return /** @type {any} */ ({
        withoutPlugins: () => ({}),
        executeQuery: method,
        transaction: method,
        connection: method,
    });
}

test.each([{ dialect: 'mysql' }, { dialect: 'mariadb' }, { dialect: 'postgres' }])('dialect $dialect', ({ dialect }) => {
    expect(kyselyAdapter(fakeKysely(), /** @type {any} */ ({ dialect })).dialect).toBe(dialect);
});

test.each([
    { label: 'no options', options: undefined, message: '"dialect" is required: "mysql", "mariadb" or "postgres"' },
    { label: 'no dialect', options: {}, message: '"dialect" is required: "mysql", "mariadb" or "postgres"' },
    { label: 'another dialect', options: { dialect: 'sqlite' }, message: '"dialect" must be "mysql", "mariadb" or "postgres"' },
    {
        label: 'a non-boolean allowUnsupportedDbVersion',
        options: { dialect: 'mysql', allowUnsupportedDbVersion: 'yes' },
        message: '"allowUnsupportedDbVersion" must be a boolean',
    },
    {
        label: 'a non-boolean allowUnsupportedDbConfiguration',
        options: { dialect: 'mysql', allowUnsupportedDbConfiguration: 'yes' },
        message: '"allowUnsupportedDbConfiguration" must be a boolean',
    },
])('$label: a ConfigError', ({ options, message }) => {
    expect(() => kyselyAdapter(fakeKysely(), /** @type {any} */ (options))).toThrow(`kyselyAdapter: ${message}`);
});

test.each([
    { options: { dialect: /** @type {const} */ ('postgres') }, expected: false },
    { options: { dialect: /** @type {const} */ ('postgres'), allowUnsupportedDbVersion: true }, expected: true },
])('allowUnsupportedDbVersion: $expected', ({ options, expected }) => {
    expect(kyselyAdapter(fakeKysely(), options).allowUnsupportedDbVersion).toBe(expected);
});

test.each([
    { options: { dialect: /** @type {const} */ ('mysql') }, expected: false },
    { options: { dialect: /** @type {const} */ ('mysql'), allowUnsupportedDbConfiguration: true }, expected: true },
])('allowUnsupportedDbConfiguration: $expected', ({ options, expected }) => {
    expect(kyselyAdapter(fakeKysely(), options).allowUnsupportedDbConfiguration).toBe(expected);
});

test.each([
    { label: 'no Kysely', db: undefined },
    { label: 'a knex instance', db: { transaction: () => {}, client: {} } },
])('$label: a ConfigError', ({ db }) => {
    expect(() => kyselyAdapter(/** @type {any} */ (db), { dialect: 'mysql' })).toThrow(ConfigError);
});
