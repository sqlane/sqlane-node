import { MySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

// Exact versions, with the digest of the multi-platform image: each run uses the same bytes
const MYSQL_8_4_IMAGE = 'mysql:8.4.13@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902';
const POSTGRES_15_IMAGE = 'postgres:15.19@sha256:40e8c839f86c404f9bd1c456bb83f11b205f2cd95d753b34c2d074e89ecee786';
const POSTGRES_18_IMAGE = 'postgres:18.6@sha256:3a4264520e121176619f54ff867d12774bc81e95e7b84db58d63bccdb6144b81';

/** @typedef {import('testcontainers').StartedTestContainer & { getConnectionUri(): string }} StartedDatabase */

/**
 * @typedef {object} TestDatabase
 * @property {string} name The name of the Vitest project: `integration:<name>`.
 * @property {'mysql' | 'postgres'} dialect
 * @property {(options?: { inMemory?: boolean }) => Promise<StartedDatabase>} start Starts a container.
 *   `inMemory` (default: true): the data on a tmpfs. The benchmarks keep it on disk.
 */

/**
 * The databases of the integration tests: the oldest and the newest supported versions.
 * @type {TestDatabase[]}
 */
export const TEST_DATABASES = [
    {
        name: 'mysql-8.4',
        dialect: 'mysql',
        start: ({ inMemory = true } = {}) => new MySqlContainer(MYSQL_8_4_IMAGE)
            .withTmpFs(inMemory ? { '/var/lib/mysql': 'rw' } : {})
            .start(),
    },
    {
        name: 'postgres-15',
        dialect: 'postgres',
        start: ({ inMemory = true } = {}) => new PostgreSqlContainer(POSTGRES_15_IMAGE)
            .withTmpFs(inMemory ? { '/var/lib/postgresql/data': 'rw' } : {})
            .start(),
    },
    {
        name: 'postgres-18',
        dialect: 'postgres',
        start: ({ inMemory = true } = {}) => new PostgreSqlContainer(POSTGRES_18_IMAGE)
            .withTmpFs(inMemory ? { '/var/lib/postgresql': 'rw' } : {})
            .start(),
    },
];
