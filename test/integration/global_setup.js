import { TEST_DATABASES } from './databases.js';

/** @type {import('testcontainers').StartedTestContainer | null} */
let container = null;

/**
 * Vitest global setup of an integration project: starts the database container of the project once for all its test
 * files, and gives its connection URI to the tests (`inject('databaseUrl')`).
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
    project.provide('databaseUrl', startedContainer.getConnectionUri());
}

/**
 * @returns {Promise<void>}
 */
export async function teardown() {
    await container?.stop();
}
