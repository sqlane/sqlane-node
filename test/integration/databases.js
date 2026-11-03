import { MySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

// Exact versions, with the digest of the multi-platform image: each run uses the same bytes
const MYSQL_8_4_IMAGE = 'mysql:8.4.13@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902';
const POSTGRES_15_IMAGE = 'postgres:15.19@sha256:40e8c839f86c404f9bd1c456bb83f11b205f2cd95d753b34c2d074e89ecee786';
const POSTGRES_18_IMAGE = 'postgres:18.6@sha256:3a4264520e121176619f54ff867d12774bc81e95e7b84db58d63bccdb6144b81';

/**
 * @typedef {object} TestDatabase
 * @property {string} name The name of the Vitest project: `integration:<name>`.
 * @property {'mysql' | 'postgres'} dialect
 * @property {() => Promise<import('testcontainers').StartedTestContainer & { getConnectionUri(): string }>} start
 *   Starts a container with the data in memory.
 */

/**
 * The databases of the integration tests: the oldest and the newest supported versions.
 * @type {TestDatabase[]}
 */
export const TEST_DATABASES = [
    {
        name: 'mysql-8.4',
        dialect: 'mysql',
        start: () => new MySqlContainer(MYSQL_8_4_IMAGE).withTmpFs({ '/var/lib/mysql': 'rw' }).start(),
    },
    {
        name: 'postgres-15',
        dialect: 'postgres',
        start: () => new PostgreSqlContainer(POSTGRES_15_IMAGE).withTmpFs({ '/var/lib/postgresql/data': 'rw' }).start(),
    },
    {
        name: 'postgres-18',
        dialect: 'postgres',
        start: () => new PostgreSqlContainer(POSTGRES_18_IMAGE).withTmpFs({ '/var/lib/postgresql': 'rw' }).start(),
    },
];
