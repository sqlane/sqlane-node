import { describe, expect, test, vi } from 'vitest';
import { ClosedError, ConfigError } from './errors.js';
import { createSqlane } from './create_sqlane.js';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
import { defineJob } from './define_job.js';

test('createSqlane needs an adapter', () => {
    expect(() => createSqlane(/** @type {any} */ ({}))).toThrow(ConfigError);
});

/**
 * An adapter over no database: every statement gives no row, the statements on the schedules are recorded. The
 * server is PostgreSQL 18 by default.
 * @param {object} [options]
 * @param {boolean} [options.missingTable]
 * @param {import('./types.js').Dialect} [options.dialect] Default: `'postgres'`.
 * @param {string} [options.version] What `VERSION()` returns.
 * @param {boolean} [options.allowUnsupportedDbVersion]
 * @param {boolean} [options.allowUnsupportedDbConfiguration]
 * @param {string} [options.sqlMode] What `@@SESSION.sql_mode` returns. Default: the default of MySQL 8.4.
 * @returns {{ adapter: import('./types.js').Adapter<any>, statements: string[], versionQueries: () => number }}
 */
function fakeAdapter({
    missingTable = false,
    dialect = 'postgres',
    version = 'PostgreSQL 18.6 (Debian 18.6-1.pgdg13+1) on aarch64-unknown-linux-gnu',
    allowUnsupportedDbVersion = false,
    allowUnsupportedDbConfiguration = false,
    sqlMode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,'
        + 'NO_ENGINE_SUBSTITUTION',
} = {}) {
    /** @type {string[]} */
    const statements = [];
    let versionQueries = 0;
    /** @type {import('./types.js').Executor} */
    const executor = {
        query: async (sql) => {
            if (sql === 'SELECT VERSION() AS version') {
                versionQueries++;

                return [{ version }];
            }

            if (sql === 'SELECT @@SESSION.sql_mode AS sql_mode') {
                return [{ sql_mode: sqlMode }];
            }

            if (!sql.includes('schedules')) {
                return [];
            }

            statements.push(sql);

            if (missingTable) {
                throw Object.assign(new Error('relation "sqlane_schedules" does not exist'), { code: '42P01' });
            }

            return sql.includes('LEFT JOIN') ? [{ id: null, db_now_ms: Date.now() }] : [];
        },
        run: async () => 0,
    };

    return {
        statements,
        versionQueries: () => versionQueries,
        adapter: /** @type {import('./types.js').Adapter<any>} */ (/** @type {unknown} */ ({
            dialect,
            allowUnsupportedDbVersion,
            allowUnsupportedDbConfiguration,
            queue: executor,
            queueTransaction: (/** @type {(executor: unknown) => Promise<unknown>} */ func) => func(executor),
            withConnection: (/** @type {(executor: unknown) => Promise<unknown>} */ func) => func(executor),
        })),
    };
}

describe('schedule() and start()', () => {
    test('schedule() after start() throws a ConfigError, after close() a ClosedError', async () => {
        const { adapter } = fakeAdapter();
        const sqlane = createSqlane({ adapter });

        await sqlane.start();
        expect(() => sqlane.schedule('tick', { every: '1m' })).toThrow(ConfigError);
        await sqlane.close({ deadline: 0 });
        expect(() => sqlane.schedule('tick', { every: '1m' })).toThrow(ClosedError);
    });

    test('a second schedule with the same id throws a ConfigError', () => {
        const sqlane = createSqlane({ adapter: fakeAdapter().adapter });

        sqlane.schedule('tick', { every: '1m' });
        expect(() => sqlane.schedule('tick', { cron: '* * * * *' })).toThrow(ConfigError);
    });

    test.each([
        ['a payload that is not JSON', { jobs: [] }, () => ({ every: '1m', payload: { at: 1n } })],
        ['a payload above maxPayloadBytes', { maxPayloadBytes: 10 }, () => ({ every: '1m', payload: { text: 'x'.repeat(20) } })],
        ['an unknown name with unknownJobs reject', { unknownJobs: /** @type {const} */ ('reject') }, () => ({ every: '1m' })],
    ])('start() throws a ConfigError for %s, before any statement', async (_, options, scheduleOptions) => {
        const { adapter, statements } = fakeAdapter();
        const sqlane = createSqlane({ adapter, ...options });

        sqlane.schedule('tick', /** @type {any} */ (scheduleOptions()));

        await expect(sqlane.start()).rejects.toThrow(ConfigError);
        expect(statements).toStrictEqual([]);
        await sqlane.close({ deadline: 0 });
    });

    test('start() checks the global limits of the definition', async () => {
        const bad = defineConcurrencyLimit({ name: 'bad', max: 1 });
        const job = defineJob({ name: 'keyed', timeout: '1m', globalConcurrencyLimits: () => [bad.key(' bad')] });
        const sqlane = createSqlane({ adapter: fakeAdapter().adapter });

        sqlane.schedule(job, { every: '1m' });

        await expect(sqlane.start()).rejects.toThrow(/schedule\("keyed"\)/);
    });

    test('a missing table: start() throws a ConfigError that says to run migrate(), and can be called again', async () => {
        const { adapter, statements } = fakeAdapter({ missingTable: true });
        const sqlane = createSqlane({ adapter });

        sqlane.schedule('tick', { every: '1m' });

        await expect(sqlane.start()).rejects.toThrow('start(): the table sqlane_schedules is missing: run migrate()');
        await expect(sqlane.start()).rejects.toThrow(ConfigError);
        expect(statements).toHaveLength(2);
        await sqlane.close({ deadline: 0 });
    });

    test('start() on a closed instance throws a ClosedError first', async () => {
        const sqlane = createSqlane({ adapter: fakeAdapter().adapter, unknownJobs: 'reject' });

        sqlane.schedule('tick', { every: '1m' });
        await sqlane.close({ deadline: 0 });

        await expect(sqlane.start()).rejects.toThrow(ClosedError);
    });

    test('concurrent start() calls register once; a second start() does nothing', async () => {
        const { adapter, statements } = fakeAdapter();
        const sqlane = createSqlane({ adapter });

        sqlane.schedule('tick', { every: '1m' });
        await Promise.all([sqlane.start(), sqlane.start()]);
        await sqlane.start();

        // The insert and the read of the registration
        expect(statements).toHaveLength(2);
        await sqlane.close({ deadline: 0 });
    });

    test('without schedules: no statement on the schedules', async () => {
        const { adapter, statements } = fakeAdapter();
        const sqlane = createSqlane({ adapter });

        await sqlane.start();
        await sqlane.close({ deadline: 0 });

        expect(statements).toStrictEqual([]);
    });

    test('close() during start(): no schedule runs', async () => {
        const { adapter, statements } = fakeAdapter();
        const sqlane = createSqlane({ adapter });

        sqlane.schedule('tick', { every: '1s' });

        const starting = sqlane.start();

        await sqlane.close({ deadline: 0 });
        await starting;
        await new Promise((resolve) => {
            setTimeout(resolve, 1500);
        });

        expect(statements.filter(sql => sql.includes('FOR UPDATE'))).toStrictEqual([]);
    });

    test('getSchedules() before start(): the registered schedules, a missing table is an empty one', async () => {
        const sqlane = createSqlane({ adapter: fakeAdapter({ missingTable: true }).adapter });

        await expect(sqlane.getSchedules()).resolves.toStrictEqual([]);
        sqlane.schedule('tick', { every: '1m', key: 'a' });
        await expect(sqlane.getSchedules()).resolves.toMatchObject([
            { id: 'tick:a', name: 'tick', spec: 'every 60000', registered: true, lastSlotAt: null, lastJobId: null },
        ]);
    });
});

/**
 * Holds the insert of the registration until `release()`.
 * @param {import('./types.js').Adapter<any>} adapter
 * @returns {{ release: () => void }}
 */
function holdRegistration(adapter) {
    const held = Promise.withResolvers();
    const { query } = adapter.queue;

    adapter.queue.query = async (sql, params) => {
        await (sql.includes('INSERT INTO sqlane_schedules') ? held.promise : null);

        return query(sql, params);
    };

    return { release: () => held.resolve(undefined) };
}

describe('close()', () => {
    test('closes at once: handle(), schedule() and start() throw a ClosedError right after it', async () => {
        const sqlane = createSqlane({ adapter: fakeAdapter().adapter });
        const closing = sqlane.close({ deadline: 0 });

        expect(() => sqlane.handle('tick', () => {})).toThrow(ClosedError);
        expect(() => sqlane.schedule('tick', { every: '1m' })).toThrow(ClosedError);
        await expect(sqlane.start()).rejects.toThrow(ClosedError);
        await closing;
    });

    test('a second call returns the same promise', async () => {
        const sqlane = createSqlane({ adapter: fakeAdapter().adapter });

        expect(sqlane.close()).toBe(sqlane.close());
        await sqlane.close();
    });

    test('waits for the registration of a pending start(), and runs nothing after it', async () => {
        const { adapter, statements } = fakeAdapter();
        const { release } = holdRegistration(adapter);

        const sqlane = createSqlane({ adapter });

        sqlane.schedule('tick', { every: '1s' });

        const starting = sqlane.start();
        let closed = false;
        const closing = (async () => {
            await sqlane.close({ deadline: 0 });
            closed = true;
        })();

        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        expect(closed).toBe(false);
        release();
        await Promise.all([starting, closing]);
        await new Promise((resolve) => {
            setTimeout(resolve, 1500);
        });

        expect(statements.filter(sql => sql.includes('FOR UPDATE'))).toStrictEqual([]);
    });
});

/**
 * A worker whose database is down at start(), then up.
 * @param {Parameters<typeof fakeAdapter>[0]} [options]
 * @returns {{ sqlane: ReturnType<typeof createSqlane>, down: Error, state: { up: boolean }, statements: string[],
 *     events: import('./types.js').SqlaneEvent[] }}
 */
function workerStartedWhileDown(options) {
    const { adapter } = fakeAdapter(options);
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const query = adapter.queue.query;
    const state = { up: false };
    /** @type {string[]} The statements once the database is up */
    const statements = [];

    vi.spyOn(adapter.queue, 'query').mockImplementation(async (sql, params) => {
        if (!state.up) {
            throw down;
        }

        statements.push(sql);

        return query(sql, params);
    });

    /** @type {import('./types.js').SqlaneEvent[]} */
    const events = [];
    const job = defineJob({ name: 'a' });
    const sqlane = createSqlane({ adapter, jobs: [job], onEvent: event => events.push(event) });

    sqlane.handle(job, async () => {});

    return { sqlane, down, state, statements, events };
}

describe('the check of the server', () => {
    test('migrate() then start(): one statement; a process that only enqueues runs none', async () => {
        const { adapter, versionQueries } = fakeAdapter();
        const sqlane = createSqlane({ adapter });

        expect(versionQueries()).toBe(0);
        await sqlane.migrate();
        await sqlane.start();
        await sqlane.migrate();
        await sqlane.close({ deadline: 0 });

        expect(versionQueries()).toBe(1);
    });

    test('concurrent start() and migrate(): one statement', async () => {
        const { adapter, versionQueries } = fakeAdapter();
        const sqlane = createSqlane({ adapter });

        await Promise.all([sqlane.start(), sqlane.migrate(), sqlane.start()]);
        await sqlane.close({ deadline: 0 });

        expect(versionQueries()).toBe(1);
    });

    test.each([
        { dialect: 'mysql', version: '11.8.9-MariaDB-ubu2404', server: 'MariaDB 11.8.9', fix: 'mariadb' },
        { dialect: 'mariadb', version: '8.4.13', server: 'MySQL 8.4.13', fix: 'mysql' },
        { dialect: 'postgres', version: '8.4.13', server: 'MySQL 8.4.13', fix: 'mysql' },
        { dialect: 'mysql', version: 'PostgreSQL 15.19 on x86_64-pc-linux-gnu', server: 'PostgreSQL 15.19', fix: 'postgres' },
    ])('"$dialect" on $server: start() and migrate() throw a ConfigError', async ({ dialect, version, server, fix }) => {
        const { adapter, versionQueries } = fakeAdapter({ dialect: /** @type {any} */ (dialect), version });
        const sqlane = createSqlane({ adapter });
        const message = `"dialect" is "${dialect}", but the database is ${server}: pass dialect: '${fix}' to the adapter`;

        await expect(sqlane.start()).rejects.toThrow(new ConfigError(`start(): ${message}`));
        await expect(sqlane.migrate()).rejects.toThrow(new ConfigError(`migrate(): ${message}`));
        // A failed check runs again
        expect(versionQueries()).toBe(2);
        await sqlane.close({ deadline: 0 });
    });

    test('"postgres" on another database: a ConfigError with its version', async () => {
        const version = 'CockroachDB CCL v24.1.0 (x86_64-pc-linux-gnu)';
        const sqlane = createSqlane({ adapter: fakeAdapter({ version }).adapter });

        await expect(sqlane.migrate())
            .rejects.toThrow(`migrate(): "dialect" is "postgres", but the database is ${JSON.stringify(version)}`);
    });

    test.each([
        { dialect: 'mysql', version: '8.0.39-0ubuntu0.22.04.1', message: 'MySQL 8.0.39 is below the supported minimum 8.4' },
        { dialect: 'mariadb', version: '10.6.18-MariaDB', message: 'MariaDB 10.6.18 is below the supported minimum 10.11' },
        { dialect: 'postgres', version: 'PostgreSQL 14.12 on x86_64', message: 'PostgreSQL 14.12 is below the supported minimum 15' },
    ])('$dialect below the minimum: start() and migrate() throw a ConfigError', async ({ dialect, version, message }) => {
        const { adapter } = fakeAdapter({ dialect: /** @type {any} */ (dialect), version });
        const sqlane = createSqlane({ adapter });
        const hint = 'upgrade it, or pass allowUnsupportedDbVersion: true to the adapter';

        await expect(sqlane.start()).rejects.toThrow(new ConfigError(`start(): ${message}: ${hint}`));
        await expect(sqlane.migrate()).rejects.toThrow(new ConfigError(`migrate(): ${message}: ${hint}`));
        await sqlane.close({ deadline: 0 });
    });

    test('allowUnsupportedDbVersion: below the minimum, one warning for the instance', async () => {
        const { adapter, versionQueries } = fakeAdapter({ version: 'PostgreSQL 14.12', allowUnsupportedDbVersion: true });
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const sqlane = createSqlane({ adapter, logger });

        await sqlane.migrate();
        await sqlane.start();
        await sqlane.close({ deadline: 0 });

        expect(versionQueries()).toBe(1);
        expect(logger.warn.mock.calls).toStrictEqual([[
            { dialect: 'postgres', version: '14.12', minimum: '15' },
            'sqlane: PostgreSQL 14.12 is below the supported minimum 15',
        ]]);
    });

    test('allowUnsupportedDbVersion does not skip the check of the dialect', async () => {
        const adapter = fakeAdapter({ dialect: 'mysql', version: '10.6.18-MariaDB', allowUnsupportedDbVersion: true }).adapter;
        const sqlane = createSqlane({ adapter });

        await expect(sqlane.migrate()).rejects.toThrow('"dialect" is "mysql", but the database is MariaDB 10.6.18');
    });

    test('allowUnsupportedDbVersion without a logger: silent', async () => {
        const adapter = fakeAdapter({ version: 'PostgreSQL 13.16', allowUnsupportedDbVersion: true }).adapter;
        const sqlane = createSqlane({ adapter });

        await expect(sqlane.migrate()).resolves.toStrictEqual({ applied: expect.any(Array) });
    });

    test('a sql_mode without strict mode: start() and migrate() throw a ConfigError', async () => {
        const { adapter, versionQueries } = fakeAdapter({ dialect: 'mysql', version: '8.4.13', sqlMode: 'NO_ENGINE_SUBSTITUTION' });
        const sqlane = createSqlane({ adapter });
        const message = 'the sql_mode of MySQL lacks STRICT_TRANS_TABLES or STRICT_ALL_TABLES, NO_ZERO_DATE, '
            + 'NO_ZERO_IN_DATE and ERROR_FOR_DIVISION_BY_ZERO';

        await expect(sqlane.start()).rejects.toThrow(`start(): ${message}: `);
        await expect(sqlane.migrate()).rejects.toThrow(`migrate(): ${message}: `);
        await expect(sqlane.migrate()).rejects.toThrow(ConfigError);
        expect(versionQueries()).toBe(3);
        await sqlane.close({ deadline: 0 });
    });

    test('allowUnsupportedDbConfiguration: one warning for the instance', async () => {
        const { adapter, versionQueries } = fakeAdapter({
            dialect: 'mariadb',
            version: '11.8.9-MariaDB-ubu2404',
            allowUnsupportedDbConfiguration: true,
            sqlMode: 'NO_ENGINE_SUBSTITUTION',
        });
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const sqlane = createSqlane({ adapter, logger });

        await sqlane.start();
        await sqlane.close({ deadline: 0 });

        expect(versionQueries()).toBe(1);
        expect(logger.warn.mock.calls).toStrictEqual([[
            {
                dialect: 'mariadb',
                sqlMode: 'NO_ENGINE_SUBSTITUTION',
                missing: ['STRICT_TRANS_TABLES or STRICT_ALL_TABLES', 'ERROR_FOR_DIVISION_BY_ZERO'],
                forbidden: [],
            },
            'sqlane: the sql_mode of MariaDB lacks STRICT_TRANS_TABLES or STRICT_ALL_TABLES and ERROR_FOR_DIVISION_BY_ZERO',
        ]]);
    });

    test('a database that is down: migrate() rejects, and checks again', async () => {
        const { adapter, versionQueries } = fakeAdapter();
        const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

        vi.spyOn(adapter.queue, 'query').mockRejectedValueOnce(down);

        const sqlane = createSqlane({ adapter });

        await expect(sqlane.migrate()).rejects.toThrow(down);
        await sqlane.migrate();
        await sqlane.start();
        await sqlane.close({ deadline: 0 });

        expect(versionQueries()).toBe(1);
    });

    test('a database that is down at start(): start() resolves; the worker claims nothing before the check passes', async () => {
        const { sqlane, down, state, statements, events } = workerStartedWhileDown();

        await sqlane.start();
        expect(events[0]).toStrictEqual({ type: 'error', operation: 'server_check', error: down });

        state.up = true;
        // The dispatcher checks again after its back-off (1 s at most)
        await new Promise((resolve) => {
            setTimeout(resolve, 1500);
        });
        await sqlane.close({ deadline: 0 });

        expect(statements[0]).toBe('SELECT VERSION() AS version');
        expect(statements.filter(sql => sql === 'SELECT VERSION() AS version')).toHaveLength(1);
        expect(statements.length).toBeGreaterThan(1);
    });

    test('a database that is down at start(), then the wrong one: an error event, and no claim', async () => {
        const { sqlane, state, statements, events } = workerStartedWhileDown({
            dialect: 'mysql',
            version: '11.8.9-MariaDB-ubu2404',
        });

        await sqlane.start();
        state.up = true;
        await new Promise((resolve) => {
            setTimeout(resolve, 1500);
        });
        await sqlane.close({ deadline: 0 });

        expect(events.at(-1)).toMatchObject({
            type: 'error',
            operation: 'server_check',
            error: new ConfigError('start(): "dialect" is "mysql", but the database is MariaDB 11.8.9: pass dialect: '
                + '\'mariadb\' to the adapter'),
        });
        expect(statements.filter(sql => /FOR UPDATE|SKIP LOCKED/u.test(sql))).toStrictEqual([]);
    });

    test('a database that is down at start(), then a sql_mode with NO_BACKSLASH_ESCAPES: an error event, and no claim', async () => {
        const { sqlane, state, statements, events } = workerStartedWhileDown({
            dialect: 'mysql',
            version: '8.4.13',
            allowUnsupportedDbConfiguration: true,
            sqlMode: 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_BACKSLASH_ESCAPES',
        });

        await sqlane.start();
        state.up = true;
        await new Promise((resolve) => {
            setTimeout(resolve, 1500);
        });
        await sqlane.close({ deadline: 0 });

        expect(events.at(-1)).toMatchObject({ type: 'error', operation: 'server_check', error: expect.any(ConfigError) });
        expect(String(/** @type {any} */ (events.at(-1)).error.message))
            .toMatch(/^start\(\): the sql_mode of MySQL has NO_BACKSLASH_ESCAPES: /u);
        expect(statements.filter(sql => /FOR UPDATE|SKIP LOCKED/u.test(sql))).toStrictEqual([]);
    });

    test('a bad lockTimeout: migrate() rejects before any statement', async () => {
        const { adapter, versionQueries } = fakeAdapter();
        const sqlane = createSqlane({ adapter });

        await expect(sqlane.migrate({ lockTimeout: 'soon' })).rejects.toThrow('"lockTimeout" must be a duration');
        expect(versionQueries()).toBe(0);
    });
});
