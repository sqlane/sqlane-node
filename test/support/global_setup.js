import { Client } from 'pg';
import { TEST_DATABASES } from './databases.js';

/** A role whose sessions default to REPEATABLE READ: on it, a READ COMMITTED transaction is observable (PostgreSQL) */
const REPEATABLE_READ_ROLE = 'sqlane_repeatable_read';

/** @type {import('testcontainers').StartedTestContainer | null} */
let container = null;

/**
 * Vitest global setup of an integration project: starts the database container of the project once for all its test
 * files, and gives its connection URI to the tests (`inject('databaseUrl')`). On PostgreSQL, it also creates, once and
 * before any test file runs, a role whose sessions default to REPEATABLE READ (`inject('repeatableReadUrl')`).
 * @param {import('vitest/node').TestProject} project
 * @returns {Promise<void>}
 */
export async function setup(project) {
    const { databaseName } = project.getProvidedContext();
    const database = TEST_DATABASES.find(({ name }) => name === databaseName);

    if (!database) {
        throw new Error(`Unknown test database: ${databaseName}`);
    }

    const startedContainer = await database.start();

    container = startedContainer;
    // mariadb:// would make Sequelize pick its mariadb dialect: the tests reach MariaDB through mysql2, as MySQL
    const url = startedContainer.getConnectionUri().replace(/^mariadb:/, 'mysql:');

    project.provide('databaseUrl', url);

    if (database.dialect === 'postgres') {
        project.provide('repeatableReadUrl', await createRepeatableReadRole(url));
    }
}

/**
 * Creates the role of the REPEATABLE READ sessions. It needs no grants: the tests read settings only.
 * @param {string} url
 * @returns {Promise<string>} The URL of the database with this role.
 */
async function createRepeatableReadRole(url) {
    const client = new Client({ connectionString: url });

    await client.connect();

    try {
        await client.query(`CREATE ROLE ${REPEATABLE_READ_ROLE} LOGIN PASSWORD '${REPEATABLE_READ_ROLE}'`);
        await client.query(`ALTER ROLE ${REPEATABLE_READ_ROLE} SET default_transaction_isolation = 'repeatable read'`);
    } finally {
        await client.end();
    }

    const roleUrl = new URL(url);

    roleUrl.username = REPEATABLE_READ_ROLE;
    roleUrl.password = REPEATABLE_READ_ROLE;

    return roleUrl.href;
}

/**
 * @returns {Promise<void>}
 */
export async function teardown() {
    await container?.stop();
}
