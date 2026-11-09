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

test.each([{ dialect: 'mysql' }, { dialect: 'postgres' }])('dialect $dialect', ({ dialect }) => {
    expect(kyselyAdapter(fakeKysely(), /** @type {any} */ ({ dialect })).dialect).toBe(dialect);
});

test.each([
    { label: 'no options', options: undefined },
    { label: 'another dialect', options: { dialect: 'sqlite' } },
])('$label: a ConfigError', ({ options }) => {
    expect(() => kyselyAdapter(fakeKysely(), /** @type {any} */ (options)))
        .toThrow('"dialect" must be "mysql" or "postgres"');
});

test.each([
    { label: 'no Kysely', db: undefined },
    { label: 'a knex instance', db: { transaction: () => {}, client: {} } },
])('$label: a ConfigError', ({ db }) => {
    expect(() => kyselyAdapter(/** @type {any} */ (db), { dialect: 'mysql' })).toThrow(ConfigError);
});
