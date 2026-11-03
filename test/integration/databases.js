import { MySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * @typedef {object} TestDatabase
 * @property {string} name The name of the Vitest project: `integration:<name>`.
 * @property {'mysql' | 'postgres'} dialect
 * @property {() => Promise<import('testcontainers').StartedTestContainer & { getConnectionUri(): string }>} start
 *   Starts a container with the data in memory.
 */

/**
 * The databases of the integration tests: the oldest and the newest supported versions, with exact image tags.
 * @type {TestDatabase[]}
 */
export const TEST_DATABASES = [
    {
        name: 'mysql-8.4',
        dialect: 'mysql',
        start: () => new MySqlContainer('mysql:8.4.13').withTmpFs({ '/var/lib/mysql': 'rw' }).start(),
    },
    {
        name: 'postgres-15',
        dialect: 'postgres',
        start: () => new PostgreSqlContainer('postgres:15.19').withTmpFs({ '/var/lib/postgresql/data': 'rw' }).start(),
    },
    {
        name: 'postgres-18',
        dialect: 'postgres',
        start: () => new PostgreSqlContainer('postgres:18.6').withTmpFs({ '/var/lib/postgresql': 'rw' }).start(),
    },
];
