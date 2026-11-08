import { defineConfig } from 'vitest/config';
import { TEST_DATABASES } from './test/databases.js';

export default defineConfig({
    test: {
        passWithNoTests: true,
        coverage: {
            provider: 'v8',
            include: ['packages/*/src/**/*.js'],
            exclude: ['packages/*/src/**/*.test.js'],
        },
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['packages/*/src/**/*.test.js'],
                },
            },
            // One project per database: the same integration tests run against each one, in its own container
            ...TEST_DATABASES.map(({ name, dialect }) => ({
                extends: true,
                test: {
                    name: `integration:${name}`,
                    include: ['packages/*/test/integration/**/*.test.js'],
                    globalSetup: ['test/global_setup.js'],
                    provide: { databaseName: name, databaseDialect: dialect },
                    hookTimeout: 30_000,
                },
            })),
        ],
    },
});
