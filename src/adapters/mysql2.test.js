import { expect, test } from 'vitest';
import { mysql2Adapter } from './mysql2.js';

const pool = /** @type {any} */ ({ getConnection: () => {}, query: () => {}, execute: () => {} });

test.each([
    { label: 'no options', options: undefined, expected: 'mysql' },
    { label: 'MySQL', options: { dialect: 'mysql' }, expected: 'mysql' },
    { label: 'MariaDB', options: { dialect: 'mariadb' }, expected: 'mariadb' },
])('$label: dialect $expected', ({ options, expected }) => {
    expect(mysql2Adapter(pool, /** @type {any} */ (options)).dialect).toBe(expected);
});

test('another dialect: a ConfigError', () => {
    expect(() => mysql2Adapter(pool, /** @type {any} */ ({ dialect: 'postgres' })))
        .toThrow('mysql2Adapter: "dialect" must be "mysql" or "mariadb"');
});
