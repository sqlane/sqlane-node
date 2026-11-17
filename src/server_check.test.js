import { describe, expect, test, vi } from 'vitest';
import { ConfigError } from './errors.js';
import { checkServer, parseServerVersion, SERVER_VERSION_SQL } from './server_check.js';

describe('parseServerVersion', () => {
    test.each([
        { text: '8.4.13', expected: { dialect: 'mysql', version: '8.4.13', parts: [8, 4, 13] } },
        { text: '8.0.39-0ubuntu0.22.04.1', expected: { dialect: 'mysql', version: '8.0.39', parts: [8, 0, 39] } },
        { text: '9.5.0-commercial', expected: { dialect: 'mysql', version: '9.5.0', parts: [9, 5, 0] } },
        { text: '11.8.9-MariaDB-ubu2404', expected: { dialect: 'mariadb', version: '11.8.9', parts: [11, 8, 9] } },
        { text: '10.11.19-MariaDB-log', expected: { dialect: 'mariadb', version: '10.11.19', parts: [10, 11, 19] } },
        { text: '5.5.5-10.6.18-MariaDB', expected: { dialect: 'mariadb', version: '10.6.18', parts: [10, 6, 18] } },
        {
            text: 'PostgreSQL 15.19 (Debian 15.19-1.pgdg13+1) on aarch64-unknown-linux-gnu, compiled by gcc',
            expected: { dialect: 'postgres', version: '15.19', parts: [15, 19] },
        },
        { text: 'PostgreSQL 18beta1 on x86_64-pc-linux-gnu', expected: { dialect: 'postgres', version: '18beta1', parts: [18, 0] } },
        {
            text: 'PostgreSQL 15.2-YB-2.25.0.0-b0 on x86_64-pc-linux-gnu',
            expected: { dialect: 'postgres', version: '15.2-YB-2.25.0.0-b0', parts: [15, 2] },
        },
        { text: 'CockroachDB CCL v24.1.0', expected: { dialect: null, version: 'CockroachDB CCL v24.1.0', parts: [] } },
        { text: '', expected: { dialect: null, version: '', parts: [] } },
    ])('$text', ({ text, expected }) => {
        expect(parseServerVersion(text)).toStrictEqual(expected);
    });
});

/**
 * @param {import('./types.js').Dialect} dialect
 * @param {unknown} version What `VERSION()` returns.
 * @param {boolean} [allowUnsupportedVersion]
 * @returns {{ adapter: import('./types.js').Adapter<any>, sent: string[] }}
 */
function fakeAdapter(dialect, version, allowUnsupportedVersion = false) {
    /** @type {string[]} */
    const sent = [];

    return {
        sent,
        adapter: /** @type {any} */ ({
            dialect,
            allowUnsupportedVersion,
            queue: {
                query: async (/** @type {string} */ sql) => {
                    sent.push(sql);

                    return [{ version }];
                },
            },
        }),
    };
}

describe('checkServer', () => {
    test.each([
        { dialect: 'mysql', version: '8.4.0' },
        { dialect: 'mysql', version: '9.5.0' },
        { dialect: 'mariadb', version: '10.11.0-MariaDB' },
        { dialect: 'mariadb', version: '11.0.6-MariaDB' },
        { dialect: 'mariadb', version: '12.1.2-MariaDB' },
        { dialect: 'postgres', version: 'PostgreSQL 15.0 on x86_64' },
        { dialect: 'postgres', version: 'PostgreSQL 18beta1 on x86_64' },
        { dialect: 'postgres', version: 'PostgreSQL 15.2-YB-2.25.0.0-b0 on x86_64' },
    ])('$dialect, $version: supported, one statement', async ({ dialect, version }) => {
        const { adapter, sent } = fakeAdapter(/** @type {any} */ (dialect), version);
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        await expect(checkServer(adapter, 'start()', logger)).resolves.toBeUndefined();
        expect(sent).toStrictEqual([SERVER_VERSION_SQL]);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test.each([
        { dialect: 'mysql', version: '8.3.0', message: 'MySQL 8.3.0 is below the supported minimum 8.4' },
        { dialect: 'mysql', version: '5.7.44-log', message: 'MySQL 5.7.44 is below the supported minimum 8.4' },
        { dialect: 'mariadb', version: '10.10.7-MariaDB', message: 'MariaDB 10.10.7 is below the supported minimum 10.11' },
        { dialect: 'mariadb', version: '5.5.5-10.6.18-MariaDB', message: 'MariaDB 10.6.18 is below the supported minimum 10.11' },
        { dialect: 'postgres', version: 'PostgreSQL 14.19 on x86_64', message: 'PostgreSQL 14.19 is below the supported minimum 15' },
        { dialect: 'postgres', version: 'PostgreSQL 9.6.24 on x86_64', message: 'PostgreSQL 9.6.24 is below the supported minimum 15' },
    ])('$dialect, $version: below the minimum', async ({ dialect, version, message }) => {
        const blocked = fakeAdapter(/** @type {any} */ (dialect), version).adapter;
        const allowed = fakeAdapter(/** @type {any} */ (dialect), version, true).adapter;
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        await expect(checkServer(blocked, 'migrate()', logger)).rejects.toThrow(new ConfigError(
            `migrate(): ${message}: upgrade it, or pass allowUnsupportedVersion: true to the adapter`,
        ));
        expect(logger.warn).not.toHaveBeenCalled();
        await expect(checkServer(allowed, 'migrate()', logger)).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(
            { dialect, version: parseServerVersion(version).version, minimum: message.split(' ').at(-1) },
            `sqlane: ${message}`,
        );
        await expect(checkServer(allowed, 'migrate()')).resolves.toBeUndefined();
    });

    test.each([
        { dialect: 'mysql', version: '11.8.9-MariaDB', server: 'MariaDB 11.8.9: pass dialect: \'mariadb\' to the adapter' },
        { dialect: 'mariadb', version: '8.4.13', server: 'MySQL 8.4.13: pass dialect: \'mysql\' to the adapter' },
        { dialect: 'postgres', version: '11.8.9-MariaDB', server: 'MariaDB 11.8.9: pass dialect: \'mariadb\' to the adapter' },
        { dialect: 'mysql', version: 'PostgreSQL 18.6 on x86_64', server: 'PostgreSQL 18.6: pass dialect: \'postgres\' to the adapter' },
        { dialect: 'postgres', version: 'CockroachDB CCL v24.1.0', server: '"CockroachDB CCL v24.1.0"' },
        { dialect: 'mysql', version: null, server: '""' },
    ])('$dialect on $version: a ConfigError, also with allowUnsupportedVersion', async ({ dialect, version, server }) => {
        const message = `start(): "dialect" is "${dialect}", but the database is ${server}`;

        await expect(checkServer(fakeAdapter(/** @type {any} */ (dialect), version).adapter, 'start()'))
            .rejects.toThrow(new ConfigError(message));
        await expect(checkServer(fakeAdapter(/** @type {any} */ (dialect), version, true).adapter, 'start()'))
            .rejects.toThrow(new ConfigError(message));
    });

    test('an error of the query: as it is', async () => {
        const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        const adapter = /** @type {any} */ ({ dialect: 'mysql', queue: { query: () => Promise.reject(down) } });

        await expect(checkServer(adapter, 'start()')).rejects.toBe(down);
    });
});
