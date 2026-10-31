import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.js', 'test/**/*.test.js'],
        passWithNoTests: true,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.js'],
            exclude: ['src/**/*.test.js'],
        },
    },
});
