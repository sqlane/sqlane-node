import { MySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * @typedef {object} TestDatabase
 * @property {string} name The name of the Vitest project: `integration:<name>`.
 * @property {'mysql' | 'postgres'} dialect
 * @property {() => Promise<import('testcontainers').StartedTestContainer & { getConnectionUri(): string }>} start
 *   Starts a container with the data in memory.
 */

/** @type {TestDatabase[]} The databases of the integration tests: the oldest and the newest supported versions */
export const TEST_DATABASES = [
    {
        name: 'mysql-8.4',
        dialect: 'mysql',
        start: () => new MySqlContainer('mysql:8.4').withTmpFs({ '/var/lib/mysql': 'rw' }).start(),
    },
    {
        name: 'postgres-15',
        dialect: 'postgres',
        start: () => new PostgreSqlContainer('postgres:15').withTmpFs({ '/var/lib/postgresql/data': 'rw' }).start(),
    },
    {
        name: 'postgres-18',
        dialect: 'postgres',
        start: () => new PostgreSqlContainer('postgres:18').withTmpFs({ '/var/lib/postgresql': 'rw' }).start(),
    },
];
