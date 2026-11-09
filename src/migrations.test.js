import { expect, test } from 'vitest';
import { ConfigError } from './errors.js';
import { getMigrations } from './migrations.js';

test.each(['mysql', 'mariadb', 'postgres'])('%s: the migrations use the table prefix', (dialect) => {
    const migrations = getMigrations({ dialect: /** @type {import('./types.js').Dialect} */ (dialect), tablePrefix: 'q_' });

    expect(migrations.map(({ id }) => id)).toStrictEqual(['0001_initial']);
    expect(migrations[0].statements.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS q_jobs /);
    expect(migrations[0].statements.join('\n')).not.toMatch(/sqlane_/);
});

test.each([
    ['an unknown dialect', { dialect: 'sqlite' }],
    ['an uppercase prefix', { dialect: 'mysql', tablePrefix: 'Q_' }],
    ['a prefix with a quote', { dialect: 'mysql', tablePrefix: 'q`; DROP' }],
    ['a prefix of 33 characters', { dialect: 'postgres', tablePrefix: `q${'_'.repeat(32)}` }],
])('rejects %s', (_, options) => {
    expect(() => getMigrations(/** @type {any} */ (options))).toThrow(ConfigError);
});

test('mariadb: the collation of MariaDB 10.11 (it has no utf8mb4_0900_bin)', () => {
    const sql = getMigrations({ dialect: 'mariadb' })[0].statements.join('\n');

    expect(sql).toMatch(/COLLATE = utf8mb4_bin/);
    expect(sql).not.toMatch(/utf8mb4_0900_bin/);
});
