import { expect, test } from 'vitest';
import { ConfigError } from '../errors.js';
import { pgAdapter } from './pg.js';

const pool = /** @type {any} */ ({ totalCount: 0, connect: () => {}, query: () => {} });

test('dialect postgres', () => {
    expect(pgAdapter(pool, { dialect: 'postgres' })).toMatchObject({
        dialect: 'postgres',
        allowUnsupportedDbVersion: false,
        allowUnsupportedDbConfiguration: false,
    });
});

test.each([
    { label: 'no options', options: undefined, message: 'pgAdapter: "dialect" is required: "postgres"' },
    { label: 'no dialect', options: { notify: true }, message: 'pgAdapter: "dialect" is required: "postgres"' },
    {
        label: 'the alias postgresql',
        options: { dialect: 'postgresql' },
        message: 'pgAdapter: "dialect" must be "postgres", not "postgresql"',
    },
    { label: 'MySQL', options: { dialect: 'mysql' }, message: 'pgAdapter: "dialect" must be "postgres", not "mysql"' },
    {
        label: 'a non-boolean allowUnsupportedDbVersion',
        options: { dialect: 'postgres', allowUnsupportedDbVersion: 1 },
        message: 'pgAdapter: "allowUnsupportedDbVersion" must be a boolean',
    },
    {
        label: 'a non-boolean allowUnsupportedDbConfiguration',
        options: { dialect: 'postgres', allowUnsupportedDbConfiguration: 1 },
        message: 'pgAdapter: "allowUnsupportedDbConfiguration" must be a boolean',
    },
])('$label: a ConfigError', ({ options, message }) => {
    expect(() => pgAdapter(pool, /** @type {any} */ (options))).toThrow(ConfigError);
    expect(() => pgAdapter(pool, /** @type {any} */ (options))).toThrow(message);
});

test('allowUnsupportedDbVersion and allowUnsupportedDbConfiguration: true', () => {
    expect(pgAdapter(pool, { dialect: 'postgres', allowUnsupportedDbVersion: true }))
        .toMatchObject({ allowUnsupportedDbVersion: true, allowUnsupportedDbConfiguration: false });
    expect(pgAdapter(pool, { dialect: 'postgres', allowUnsupportedDbConfiguration: true }))
        .toMatchObject({ allowUnsupportedDbVersion: false, allowUnsupportedDbConfiguration: true });
});
