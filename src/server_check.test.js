import { describe, expect, test, vi } from 'vitest';
import { ConfigError } from './errors.js';
import { checkServer, checkSqlMode, parseServerVersion, SERVER_VERSION_SQL, SQL_MODE_SQL } from './server_check.js';

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

/** The default `sql_mode` of MySQL 8.4 */
const MYSQL_SQL_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,'
    + 'NO_ENGINE_SUBSTITUTION';
/** The default `sql_mode` of MariaDB 10.11 and 11.8 */
const MARIADB_SQL_MODE = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION';
/** @type {Record<string, string>} */
const DEFAULT_SQL_MODE = { mysql: MYSQL_SQL_MODE, mariadb: MARIADB_SQL_MODE, postgres: '' };
/** @type {Record<string, string[]>} The statements of the check */
const CHECK_SQL = {
    mysql: [SERVER_VERSION_SQL, SQL_MODE_SQL],
    mariadb: [SERVER_VERSION_SQL, SQL_MODE_SQL],
    postgres: [SERVER_VERSION_SQL],
};

/**
 * @param {import('./types.js').Dialect} dialect
 * @param {unknown} version What `VERSION()` returns.
 * @param {object} [options]
 * @param {boolean} [options.allowUnsupportedDbVersion]
 * @param {boolean} [options.allowUnsupportedDbConfiguration]
 * @param {unknown} [options.sqlMode] What `@@SESSION.sql_mode` returns. Default: the default of the database.
 * @returns {{ adapter: import('./types.js').Adapter<any>, sent: string[] }}
 */
function fakeAdapter(dialect, version, {
    allowUnsupportedDbVersion = false,
    allowUnsupportedDbConfiguration = false,
    sqlMode = DEFAULT_SQL_MODE[dialect],
} = {}) {
    /** @type {string[]} */
    const sent = [];

    return {
        sent,
        adapter: /** @type {any} */ ({
            dialect,
            allowUnsupportedDbVersion,
            allowUnsupportedDbConfiguration,
            queue: {
                query: async (/** @type {string} */ sql) => {
                    sent.push(sql);

                    return sql === SQL_MODE_SQL ? [{ sql_mode: sqlMode }] : [{ version }];
                },
            },
        }),
    };
}

/** @returns {import('./types.js').Logger & { warn: import('vitest').Mock }} */
function fakeLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
    ])('$dialect, $version: supported; PostgreSQL one statement, MySQL and MariaDB two', async ({ dialect, version }) => {
        const { adapter, sent } = fakeAdapter(/** @type {any} */ (dialect), version);
        const logger = fakeLogger();

        await expect(checkServer(adapter, 'start()', logger)).resolves.toBeUndefined();
        expect(sent).toStrictEqual(CHECK_SQL[dialect]);
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
        const allowed = fakeAdapter(/** @type {any} */ (dialect), version, { allowUnsupportedDbVersion: true }).adapter;
        const logger = fakeLogger();

        await expect(checkServer(blocked, 'migrate()', logger)).rejects.toThrow(new ConfigError(
            `migrate(): ${message}: upgrade it, or pass allowUnsupportedDbVersion: true to the adapter`,
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
    ])('$dialect on $version: a ConfigError, also with the hatches', async ({ dialect, version, server }) => {
        const message = `start(): "dialect" is "${dialect}", but the database is ${server}`;
        const allowed = fakeAdapter(/** @type {any} */ (dialect), version, {
            allowUnsupportedDbVersion: true,
            allowUnsupportedDbConfiguration: true,
        });

        await expect(checkServer(fakeAdapter(/** @type {any} */ (dialect), version).adapter, 'start()'))
            .rejects.toThrow(new ConfigError(message));
        await expect(checkServer(allowed.adapter, 'start()')).rejects.toThrow(new ConfigError(message));
    });

    test('an error of the query: as it is', async () => {
        const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        const adapter = /** @type {any} */ ({ dialect: 'mysql', queue: { query: () => Promise.reject(down) } });

        await expect(checkServer(adapter, 'start()')).rejects.toBe(down);
    });
});

const STRICT = 'STRICT_TRANS_TABLES or STRICT_ALL_TABLES';
const RDS = ' (the default group of RDS MySQL lacks them)';

describe('checkSqlMode', () => {
    test.each([
        { dialect: 'mysql', sqlMode: MYSQL_SQL_MODE },
        { dialect: 'mariadb', sqlMode: MARIADB_SQL_MODE },
        // STRICT_ALL_TABLES instead of STRICT_TRANS_TABLES; the flags in any order and case
        { dialect: 'mysql', sqlMode: 'error_for_division_by_zero,NO_ZERO_DATE,NO_ZERO_IN_DATE,STRICT_ALL_TABLES' },
        { dialect: 'mariadb', sqlMode: 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO' },
        // TRADITIONAL, as the server shows it
        {
            dialect: 'mysql',
            sqlMode: 'STRICT_TRANS_TABLES,STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,'
                + 'TRADITIONAL,NO_ENGINE_SUBSTITUTION',
        },
        // Allowed whatever their value
        { dialect: 'mysql', sqlMode: `${MYSQL_SQL_MODE},ANSI_QUOTES,PIPES_AS_CONCAT,REAL_AS_FLOAT,IGNORE_SPACE` },
        { dialect: 'mariadb', sqlMode: `${MARIADB_SQL_MODE},ANSI_QUOTES,PIPES_AS_CONCAT,ONLY_FULL_GROUP_BY` },
    ])('$dialect, $sqlMode: supported', ({ dialect, sqlMode }) => {
        expect(checkSqlMode(/** @type {any} */ (dialect), sqlMode)).toStrictEqual({ missing: [], forbidden: [] });
    });

    test.each([
        { dialect: 'mysql', flag: 'STRICT_TRANS_TABLES', missing: STRICT },
        { dialect: 'mysql', flag: 'NO_ZERO_DATE', missing: 'NO_ZERO_DATE' },
        { dialect: 'mysql', flag: 'NO_ZERO_IN_DATE', missing: 'NO_ZERO_IN_DATE' },
        { dialect: 'mysql', flag: 'ERROR_FOR_DIVISION_BY_ZERO', missing: 'ERROR_FOR_DIVISION_BY_ZERO' },
        { dialect: 'mariadb', flag: 'STRICT_TRANS_TABLES', missing: STRICT },
        { dialect: 'mariadb', flag: 'ERROR_FOR_DIVISION_BY_ZERO', missing: 'ERROR_FOR_DIVISION_BY_ZERO' },
    ])('$dialect without $flag: lacks $missing', ({ dialect, flag, missing }) => {
        const sqlMode = DEFAULT_SQL_MODE[dialect]
            .split(',')
            .filter(given => given !== flag)
            .join(',');

        expect(checkSqlMode(/** @type {any} */ (dialect), sqlMode))
            .toStrictEqual({ missing: [missing], forbidden: [] });
    });

    test.each([
        { dialect: 'mysql', flag: 'ALLOW_INVALID_DATES' },
        { dialect: 'mysql', flag: 'NO_BACKSLASH_ESCAPES' },
        { dialect: 'mariadb', flag: 'ALLOW_INVALID_DATES' },
        { dialect: 'mariadb', flag: 'NO_BACKSLASH_ESCAPES' },
    ])('$dialect with $flag: forbidden', ({ dialect, flag }) => {
        const sqlMode = `${DEFAULT_SQL_MODE[dialect]},${flag}`;

        expect(checkSqlMode(/** @type {any} */ (dialect), sqlMode)).toStrictEqual({ missing: [], forbidden: [flag] });
    });

    test.each([
        {
            dialect: 'mysql',
            missing: [STRICT, 'NO_ZERO_DATE', 'NO_ZERO_IN_DATE', 'ERROR_FOR_DIVISION_BY_ZERO'],
        },
        { dialect: 'mariadb', missing: [STRICT, 'ERROR_FOR_DIVISION_BY_ZERO'] },
    ])('$dialect, the default of RDS MySQL (NO_ENGINE_SUBSTITUTION), or an empty mode: lacks all', ({ dialect, missing }) => {
        expect(checkSqlMode(/** @type {any} */ (dialect), 'NO_ENGINE_SUBSTITUTION')).toStrictEqual({ missing, forbidden: [] });
        expect(checkSqlMode(/** @type {any} */ (dialect), '')).toStrictEqual({ missing, forbidden: [] });
    });
});

describe('checkServer: the sql_mode', () => {
    const lacking = 'start(): the sql_mode of MySQL lacks STRICT_TRANS_TABLES or STRICT_ALL_TABLES, NO_ZERO_DATE, '
        + 'NO_ZERO_IN_DATE and ERROR_FOR_DIVISION_BY_ZERO: set sql_mode in the server config, or on RDS and Aurora in '
        + 'the DB parameter group (the default group of RDS MySQL lacks them); or pass '
        + 'allowUnsupportedDbConfiguration: true to the adapter';

    test('PostgreSQL: no statement on the sql_mode', async () => {
        const { adapter, sent } = fakeAdapter('postgres', 'PostgreSQL 18.6 on x86_64', { sqlMode: '' });

        await checkServer(adapter, 'start()');
        expect(sent).toStrictEqual([SERVER_VERSION_SQL]);
    });

    test('lacking a flag: a ConfigError that names each problem and the fix', async () => {
        const { adapter, sent } = fakeAdapter('mysql', '8.4.13', { sqlMode: 'NO_ENGINE_SUBSTITUTION' });

        await expect(checkServer(adapter, 'start()')).rejects.toThrow(new ConfigError(lacking));
        expect(sent).toStrictEqual([SERVER_VERSION_SQL, SQL_MODE_SQL]);
    });

    test.each([
        {
            dialect: 'mariadb',
            version: '11.8.9-MariaDB',
            sqlMode: 'STRICT_TRANS_TABLES,ALLOW_INVALID_DATES',
            problems: 'MariaDB lacks ERROR_FOR_DIVISION_BY_ZERO and has ALLOW_INVALID_DATES',
            rds: RDS,
        },
        {
            dialect: 'mysql',
            version: '8.4.13',
            sqlMode: `${MYSQL_SQL_MODE},ALLOW_INVALID_DATES`,
            problems: 'MySQL has ALLOW_INVALID_DATES',
            rds: '',
        },
    ])('$dialect, $sqlMode: a ConfigError', async ({ dialect, version, sqlMode, problems, rds }) => {
        const { adapter } = fakeAdapter(/** @type {any} */ (dialect), version, { sqlMode });

        await expect(checkServer(adapter, 'migrate()')).rejects.toThrow(new ConfigError(`migrate(): the sql_mode of `
            + `${problems}: set sql_mode in the server config, or on RDS and Aurora in the DB parameter group${rds}; or `
            + 'pass allowUnsupportedDbConfiguration: true to the adapter'));
    });

    test('allowUnsupportedDbConfiguration: a warning; silent without a logger', async () => {
        const sqlMode = 'NO_ENGINE_SUBSTITUTION,ALLOW_INVALID_DATES';
        const { adapter } = fakeAdapter('mysql', '8.4.13', { allowUnsupportedDbConfiguration: true, sqlMode });
        const logger = fakeLogger();

        await expect(checkServer(adapter, 'start()', logger)).resolves.toBeUndefined();
        expect(logger.warn.mock.calls).toStrictEqual([[
            {
                dialect: 'mysql',
                sqlMode,
                missing: [STRICT, 'NO_ZERO_DATE', 'NO_ZERO_IN_DATE', 'ERROR_FOR_DIVISION_BY_ZERO'],
                forbidden: ['ALLOW_INVALID_DATES'],
            },
            `sqlane: the sql_mode of MySQL lacks ${STRICT}, NO_ZERO_DATE, NO_ZERO_IN_DATE and ERROR_FOR_DIVISION_BY_ZERO and `
            + 'has ALLOW_INVALID_DATES',
        ]]);
        await expect(checkServer(adapter, 'start()')).resolves.toBeUndefined();
    });

    test.each([
        {
            dialect: 'mysql',
            version: '8.4.13',
            sqlMode: `${MYSQL_SQL_MODE},NO_BACKSLASH_ESCAPES`,
            problems: 'MySQL has',
            rds: '',
        },
        {
            dialect: 'mariadb',
            version: '11.8.9-MariaDB',
            sqlMode: 'NO_BACKSLASH_ESCAPES',
            problems: `MariaDB lacks ${STRICT} and ERROR_FOR_DIVISION_BY_ZERO and has`,
            rds: RDS,
        },
    ])('$dialect, NO_BACKSLASH_ESCAPES: a ConfigError, also with allowUnsupportedDbConfiguration', async ({
        dialect,
        version,
        sqlMode,
        problems,
        rds,
    }) => {
        const message = `start(): the sql_mode of ${problems} NO_BACKSLASH_ESCAPES: set sql_mode in the server config, or `
            + `on RDS and Aurora in the DB parameter group${rds}. NO_BACKSLASH_ESCAPES breaks the escaping of the `
            + 'driver: a quote in a value is a SQL error, and a crafted value can inject SQL. '
            + 'allowUnsupportedDbConfiguration does not allow it';
        const logger = fakeLogger();

        for (const allowUnsupportedDbConfiguration of [false, true]) {
            const options = { allowUnsupportedDbConfiguration, sqlMode };
            const { adapter } = fakeAdapter(/** @type {any} */ (dialect), version, options);

            // oxlint-disable-next-line no-await-in-loop -- one case after the other
            await expect(checkServer(adapter, 'start()', logger)).rejects.toThrow(new ConfigError(message));
        }

        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('the two hatches are independent', async () => {
        const sqlMode = 'NO_ENGINE_SUBSTITUTION';
        const versionOnly = fakeAdapter('mysql', '8.0.39', { allowUnsupportedDbVersion: true, sqlMode }).adapter;
        const configurationOnly = fakeAdapter('mysql', '8.0.39', { allowUnsupportedDbConfiguration: true }).adapter;
        const logger = fakeLogger();
        const below = 'start(): MySQL 8.0.39 is below the supported minimum 8.4: upgrade it, or pass '
            + 'allowUnsupportedDbVersion: true to the adapter';

        await expect(checkServer(versionOnly, 'start()', logger)).rejects.toThrow(new ConfigError(lacking));
        await expect(checkServer(configurationOnly, 'start()', logger)).rejects.toThrow(new ConfigError(below));
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('both hatches: two warnings, once the whole check passes', async () => {
        const { adapter } = fakeAdapter('mariadb', '10.6.18-MariaDB', {
            allowUnsupportedDbVersion: true,
            allowUnsupportedDbConfiguration: true,
            sqlMode: 'STRICT_ALL_TABLES',
        });
        const logger = fakeLogger();

        await checkServer(adapter, 'start()', logger);
        expect(logger.warn.mock.calls).toStrictEqual([
            [
                { dialect: 'mariadb', version: '10.6.18', minimum: '10.11' },
                'sqlane: MariaDB 10.6.18 is below the supported minimum 10.11',
            ],
            [
                { dialect: 'mariadb', sqlMode: 'STRICT_ALL_TABLES', missing: ['ERROR_FOR_DIVISION_BY_ZERO'], forbidden: [] },
                'sqlane: the sql_mode of MariaDB lacks ERROR_FOR_DIVISION_BY_ZERO',
            ],
        ]);
    });

    test('below the minimum with the hatch, then the sql_mode fails: no warning', async () => {
        const { adapter } = fakeAdapter('mysql', '8.0.39', { allowUnsupportedDbVersion: true, sqlMode: '' });
        const logger = fakeLogger();

        await expect(checkServer(adapter, 'start()', logger)).rejects.toThrow(ConfigError);
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
