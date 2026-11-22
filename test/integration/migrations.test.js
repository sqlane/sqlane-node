import mysql from 'mysql2/promise';
import { afterAll, beforeAll, expect, inject, test, vi } from 'vitest';
import {
    ConfigError,
    createSqlane,
    defineRateLimit,
    InvalidOptionsError,
    MigrationLockTimeoutError,
} from '../../src/index.js';
import { migrationsOf } from '../../src/migrations.js';
import { mysql2Adapter } from '../../src/adapters/mysql2.js';
import { parseServerVersion, SERVER_VERSION_SQL } from '../../src/server_check.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @type {Record<'mysql' | 'postgres', (table: string) => string>} */
const INSERT_TWO_PAYLOADS_SQL = {
    mysql: table => `INSERT INTO ${table} (id, payload) VALUES (?, '{}'), (?, '{}')`,
    postgres: table => `INSERT INTO ${table} (id, payload) VALUES ($1, '{}'), ($2, '{}')`,
};

/** @type {Record<'mysql' | 'postgres', { lock: string, unlock: string }>} */
const LOCK_SQL = {
    mysql: { lock: 'SELECT GET_LOCK(?, 0)', unlock: 'SELECT RELEASE_LOCK(?)' },
    postgres: { lock: 'SELECT pg_advisory_lock(hashtext($1))', unlock: 'SELECT pg_advisory_unlock(hashtext($1))' },
};

/** The migrations of the dialect, in order */
const SIX = ['0005_concurrency_limits', '0006_concurrency_slots'];
const RATE_LIMITS = ['0007_rate_limits'];
const JOB_LIST = ['0008_job_list'];
const ALL_MIGRATIONS = inject('databaseDialect') === 'postgres'
    ? ['0001_initial', '0002_pending_order', '0003_job_keys', '0004_schedules', ...SIX, ...RATE_LIMITS, ...JOB_LIST]
    : ['0001_initial', '0002_job_keys', '0004_schedules', ...SIX, ...RATE_LIMITS, ...JOB_LIST];

const isMysqlFamily = inject('databaseDialect') !== 'postgres';

/** @type {Record<'mysql' | 'postgres', string>} The index of 0008 by the catalog: a row if it exists */
const JOBS_LIST_SQL = {
    mysql: `SELECT 1 AS found FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND index_name = CONCAT(?, 'jobs_list')`,
    postgres: 'SELECT 1 AS found WHERE to_regclass($1 || \'jobs_list\') IS NOT NULL',
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} The index of 0008, dropped by hand */
const DROP_JOBS_LIST_SQL = {
    mysql: p => `ALTER TABLE ${p}jobs DROP KEY ${p}jobs_list`,
    postgres: p => `DROP INDEX ${p}jobs_list`,
};

/** @type {Record<'mysql' | 'postgres', { time: string, now: string }>} */
const TIME_SQL = {
    mysql: { time: 'datetime(3)', now: 'UTC_TIMESTAMP(3)' },
    postgres: { time: 'timestamptz(3)', now: 'now()' },
};

/**
 * @param {unknown} value A JSON column: a text on MySQL and MariaDB, parsed on PostgreSQL.
 * @returns {unknown}
 */
function parsedJson(value) {
    return typeof value === 'string' ? JSON.parse(value) : value;
}

/** @type {Record<'mysql' | 'postgres', (p: string) => string[]>} A job of 5.x with 2 mutex keys, a hold of one */
const FIVE_X_ROWS_SQL = {
    mysql: p => [
        `INSERT INTO ${p}jobs (id, job_name, status, run_at, max_attempts, max_stalls, mutex_keys, enqueue_token,
            completed_retention_ms, failed_retention_ms, created_at, updated_at)
         VALUES ('j1', 'sync', 'pending', UTC_TIMESTAMP(3), 3, 2, JSON_ARRAY('order:1', 'order:2'), 't', 0, 0,
            UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
        `INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
         VALUES ('order:1', 'j0', 'old', NULL, UTC_TIMESTAMP(3))`,
    ],
    postgres: p => [
        `INSERT INTO ${p}jobs (id, job_name, status, run_at, max_attempts, max_stalls, mutex_keys, enqueue_token,
            completed_retention_ms, failed_retention_ms, created_at, updated_at)
         VALUES ('j1', 'sync', 'pending', now(), 3, 2, ARRAY['order:1', 'order:2'], 't', 0, 0, now(), now())`,
        `INSERT INTO ${p}mutexes (mutex_key, job_id, lock_token, held_until, created_at)
         VALUES ('order:1', 'j0', 'old', NULL, now())`,
    ],
};

/** @type {Record<'mysql' | 'postgres', (p: string) => string[]>} A job of 6.0 with a global limit */
const SIX_ROWS_SQL = {
    mysql: p => [
        `INSERT INTO ${p}jobs (id, job_name, status, run_at, max_attempts, max_stalls, limit_keys, limit_maxes,
            enqueue_token, completed_retention_ms, failed_retention_ms, created_at, updated_at)
         VALUES ('j1', 'sync', 'pending', UTC_TIMESTAMP(3), 3, 2, JSON_ARRAY('order:1'), JSON_ARRAY(2), 't', 0, 0,
            UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    ],
    postgres: p => [
        `INSERT INTO ${p}jobs (id, job_name, status, run_at, max_attempts, max_stalls, limit_keys, limit_maxes,
            enqueue_token, completed_retention_ms, failed_retention_ms, created_at, updated_at)
         VALUES ('j1', 'sync', 'pending', now(), 3, 2, ARRAY['order:1'], ARRAY[2], 't', 0, 0, now(), now())`,
    ],
};

/** @type {Record<'mysql' | 'postgres', (p: string) => { insert: string, read: string }>} A time in µs */
const RATE_ROW_SQL = {
    mysql: p => ({
        insert: `INSERT INTO ${p}rate_limits (limit_key, tat) VALUES ('@api:1', '2030-01-02 03:04:05.123456')`,
        read: `SELECT limit_key, TIMESTAMPDIFF(MICROSECOND, '1970-01-01', tat) AS tat_us FROM ${p}rate_limits`,
    }),
    postgres: p => ({
        insert: `INSERT INTO ${p}rate_limits (limit_key, tat) VALUES ('@api:1', '2030-01-02 03:04:05.123456+00')`,
        read: `SELECT limit_key, (EXTRACT(EPOCH FROM tat) * 1000000)::bigint AS tat_us FROM ${p}rate_limits`,
    }),
};

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
let prefixCount = 0;

beforeAll(async () => {
    database = await connectTestDatabase();
    testAdapter = createTestAdapter();
});

afterAll(async () => {
    await testAdapter?.close();
    await database?.close();
});

/**
 * A prefix of its own for each test: it starts with the prefix of the file, so close() drops its tables.
 * @returns {string}
 */
function nextPrefix() {
    prefixCount++;

    return `${database.tablePrefix}${prefixCount}_`;
}

/**
 * @param {string} tablePrefix
 * @param {string} [installedVersion] In place of the version of package.json.
 * @returns {import('../../src/types.js').Sqlane<any>}
 */
function sqlaneOf(tablePrefix, installedVersion) {
    return createSqlane(/** @type {import('../../src/types.js').SqlaneOptions<any>} */ ({
        adapter: testAdapter.adapter,
        tablePrefix,
        installedVersion,
    }));
}

/**
 * Applies the migrations but the last `count`, as the version that had them left the database.
 * @param {string} tablePrefix
 * @param {number} count
 * @param {string[]} rowsSql Rows of that version, added before the record of the migrations.
 */
async function migrateAllBut(tablePrefix, count, rowsSql) {
    const migrations = migrationsOf(database.dialect, tablePrefix).slice(0, -count);

    for (const sql of [...migrations.flatMap(migration => migration.statements), ...rowsSql]) {
        // oxlint-disable-next-line no-await-in-loop -- DDL in order
        await database.query(sql);
    }

    const { time, now } = TIME_SQL[database.family];

    await database.query(`CREATE TABLE IF NOT EXISTS ${tablePrefix}migrations (id varchar(64) NOT NULL PRIMARY KEY, `
        + `applied_at ${time} NOT NULL)`);

    for (const migration of migrations) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await database.query(`INSERT INTO ${tablePrefix}migrations (id, applied_at) VALUES ('${migration.id}', ${now})`);
    }
}

/**
 * @param {string} tablePrefix
 * @returns {Promise<string[]>}
 */
async function listTables(tablePrefix) {
    const rows = database.family === 'mysql'
        ? await database.query(`
            SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = DATABASE() AND LEFT(table_name, CHAR_LENGTH(?)) = ? ORDER BY table_name
        `, [tablePrefix, tablePrefix])
        : await database.query(`
            SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = current_schema() AND starts_with(table_name, $1) ORDER BY table_name
        `, [tablePrefix]);

    // In JS: the collation of information_schema orders `_` before or after letters
    return rows.map(row => String(row.name)).toSorted();
}

test('applies the migrations once', async () => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix);

    await expect(sqlane.schema.migrate()).resolves.toStrictEqual({ applied: ALL_MIGRATIONS });
    await expect(listTables(tablePrefix)).resolves.toStrictEqual(
        ['concurrency_slots', 'jobs', 'migrations', 'payloads', 'rate_limits', 'schedules']
            .map(table => `${tablePrefix}${table}`).toSorted(),
    );
    await expect(sqlane.schema.migrate()).resolves.toStrictEqual({ applied: [] });
});

test('a database of 3.x applies only 0004_schedules, and keeps its jobs', async () => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix);

    await sqlane.schema.migrate();
    // As 3.x left it: without the table of the schedules and its record
    await database.query(`DROP TABLE ${tablePrefix}schedules`);
    await database.query(`DELETE FROM ${tablePrefix}migrations WHERE id = '0004_schedules'`);
    await sqlane.enqueue(testAdapter.pool, 'nightly_report', {});

    await expect(sqlane.schema.migrate()).resolves.toStrictEqual({ applied: ['0004_schedules'] });
    await expect(database.query(`SELECT job_name FROM ${tablePrefix}jobs`))
        .resolves.toStrictEqual([{ job_name: 'nightly_report' }]);
    await expect(database.query(`SELECT id FROM ${tablePrefix}schedules`)).resolves.toStrictEqual([]);
});

test('a database of 5.x: mutex keys become global limits with max 1, a hold becomes slot 0', async () => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix);

    await migrateAllBut(
        tablePrefix,
        SIX.length + RATE_LIMITS.length + JOB_LIST.length,
        FIVE_X_ROWS_SQL[database.family](tablePrefix),
    );

    await expect(sqlane.schema.migrate()).resolves.toStrictEqual({ applied: [...SIX, ...RATE_LIMITS, ...JOB_LIST] });

    const [job] = await database.query(`SELECT limit_keys, limit_maxes, blocked_on, rate_limits FROM ${tablePrefix}jobs`);

    expect([job.limit_keys, job.limit_maxes, job.blocked_on, job.rate_limits].map(parsedJson))
        .toStrictEqual([['order:1', 'order:2'], [1, 1], null, null]);
    await expect(database.query(`SELECT limit_key, slot, job_id FROM ${tablePrefix}concurrency_slots`))
        .resolves.toStrictEqual([{ limit_key: 'order:1', slot: 0, job_id: 'j0' }]);
});

test('a database of 6.0: 0007 adds the rate keys in µs and the rate limits of the jobs, and keeps the jobs', async () => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix);
    const api = defineRateLimit({ name: 'api', max: 10, per: '1s', burst: 2 });

    await migrateAllBut(tablePrefix, RATE_LIMITS.length + JOB_LIST.length, SIX_ROWS_SQL[database.family](tablePrefix));

    await expect(sqlane.schema.migrate()).resolves.toStrictEqual({ applied: [...RATE_LIMITS, ...JOB_LIST] });

    const [job] = await database.query(`SELECT limit_keys, limit_maxes, rate_limits FROM ${tablePrefix}jobs`);

    expect([job.limit_keys, job.limit_maxes, job.rate_limits].map(parsedJson)).toStrictEqual([['order:1'], [2], null]);

    const { insert, read } = RATE_ROW_SQL[database.family](tablePrefix);

    await database.query(insert);
    await expect(database.query(read)).resolves.toMatchObject([{ limit_key: '@api:1' }]);
    expect(Number((await database.query(read))[0].tat_us)).toBe(Date.UTC(2030, 0, 2, 3, 4, 5, 123) * 1000 + 456);

    // An enqueue after the migration writes the column
    const { id } = await sqlane.enqueue(testAdapter.pool, 'sync', {}, { globalRateLimits: [api.key(1)] });
    const [enqueued] = await database.query(`SELECT rate_limits FROM ${tablePrefix}jobs WHERE id = '${id}'`);

    expect(parsedJson(enqueued.rate_limits))
        .toStrictEqual([{ key: '@api:1', max: 10, per_us: 1_000_000, burst: 2, cost: 1 }]);
});

test('a database of 7.x: 0008 adds the index of the lists; jobs.list pages through the jobs', async () => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix);

    await migrateAllBut(tablePrefix, JOB_LIST.length, []);
    await expect(sqlane.schema.migrate()).resolves.toStrictEqual({ applied: JOB_LIST });

    const added = await sqlane.enqueueMany(testAdapter.pool, 'ping', [{ payload: {} }, { payload: {} }, { payload: {} }]);
    const page1 = await sqlane.jobs.list({ jobName: 'ping' }, { limit: 2 });
    const page2 = await sqlane.jobs.list({ jobName: 'ping' }, { limit: 2, cursor: page1.nextCursor });

    expect([page1.jobs.length, page2.jobs.length, page2.nextCursor]).toStrictEqual([2, 1, null]);
    expect([...page1.jobs, ...page2.jobs].map(job => job.id).toSorted())
        .toStrictEqual(added.map(({ id }) => id).toSorted());
});

test('concurrent migrations apply each version once', async () => {
    const tablePrefix = nextPrefix();
    const results = await Promise.all([sqlaneOf(tablePrefix).schema.migrate(), sqlaneOf(tablePrefix).schema.migrate()]);

    expect(results.flatMap(result => result.applied)).toStrictEqual(ALL_MIGRATIONS);
});

test('ids are case-sensitive', async () => {
    const tablePrefix = nextPrefix();
    await sqlaneOf(tablePrefix).schema.migrate();
    await database.query(INSERT_TWO_PAYLOADS_SQL[database.family](`${tablePrefix}payloads`), ['job:ABC', 'job:abc']);

    await expect(database.query(`SELECT id FROM ${tablePrefix}payloads ORDER BY id`))
        .resolves.toStrictEqual([{ id: 'job:ABC' }, { id: 'job:abc' }]);
});

test('waits for the migration lock up to lockTimeout', async () => {
    const tablePrefix = nextPrefix();
    const lockName = `${tablePrefix}migrations`;
    const { lock, unlock } = LOCK_SQL[database.family];

    await database.query(lock, [lockName]);

    try {
        await expect(sqlaneOf(tablePrefix).schema.migrate({ lockTimeout: '1s' }))
            .rejects.toThrow(MigrationLockTimeoutError);
    } finally {
        await database.query(unlock, [lockName]);
    }

    await expect(sqlaneOf(tablePrefix).schema.migrate({ lockTimeout: '1s' }))
        .resolves.toStrictEqual({ applied: ALL_MIGRATIONS });
});

test('targetVersion: the migrations tagged up to it, then the next ones', async () => {
    const sqlane = sqlaneOf(nextPrefix());

    await expect(sqlane.schema.migrate({ targetVersion: '6.0.0' }))
        .resolves.toStrictEqual({ applied: ALL_MIGRATIONS.slice(0, -JOB_LIST.length) });
    await expect(sqlane.schema.migrate({ targetVersion: '7.1.0' })).resolves.toStrictEqual({ applied: JOB_LIST });
    await expect(sqlane.schema.migrate()).resolves.toStrictEqual({ applied: [] });
});

test('a targetVersion with no migration of its own: the migrations tagged below it', async () => {
    await expect(sqlaneOf(nextPrefix()).schema.migrate({ targetVersion: '7.0.4' }))
        .resolves.toStrictEqual({ applied: ALL_MIGRATIONS.slice(0, -JOB_LIST.length) });
});

test('without targetVersion: every known migration, also those tagged above the installed version', async () => {
    await expect(sqlaneOf(nextPrefix(), '7.0.4').schema.migrate()).resolves.toStrictEqual({ applied: ALL_MIGRATIONS });
});

test('a targetVersion above the installed version, up to the highest tag (merged before its release)', async () => {
    await expect(sqlaneOf(nextPrefix(), '7.0.4').schema.migrate({ targetVersion: '7.1.0' }))
        .resolves.toStrictEqual({ applied: ALL_MIGRATIONS });
});

test('an installed pre-release counts as its base version', async () => {
    await expect(sqlaneOf(nextPrefix(), '8.0.0-rc.1').schema.migrate({ targetVersion: '8.0.0' }))
        .resolves.toStrictEqual({ applied: ALL_MIGRATIONS });
});

test.each([
    { targetVersion: '5.9.0', installed: '7.1.0' },
    { targetVersion: '7.1.1', installed: '7.1.0' },
    { targetVersion: '7.1.1', installed: '7.0.4' },
    { targetVersion: '8.0.1', installed: '8.0.0-rc.1' },
    { targetVersion: 'v7.1.0', installed: '7.1.0' },
    { targetVersion: '7.1.0-rc.1', installed: '7.1.0' },
    { targetVersion: null, installed: '7.1.0' },
])('targetVersion $targetVersion, $installed installed: an InvalidOptionsError, nothing applied', async ({
    targetVersion, installed,
}) => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix, installed);

    await expect(sqlane.schema.migrate({ targetVersion: /** @type {any} */ (targetVersion) }))
        .rejects.toThrow(InvalidOptionsError);
    await expect(listTables(tablePrefix)).resolves.toStrictEqual([]);
});

/**
 * @param {string} tablePrefix
 * @returns {Promise<boolean>} The index of 0008_job_list exists, by the catalog.
 */
async function hasJobsList(tablePrefix) {
    return (await database.query(JOBS_LIST_SQL[database.family], [tablePrefix])).length > 0;
}

/**
 * @param {string} tablePrefix
 * @returns {Promise<string[]>} The recorded ids, sorted.
 */
async function recordedIds(tablePrefix) {
    const rows = await database.query(`SELECT id FROM ${tablePrefix}migrations ORDER BY id`);

    return rows.map(row => String(row.id));
}

test('rollback: reverts the migrations tagged above targetVersion; migrate() applies them again', async () => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix);

    await sqlane.schema.migrate();
    await expect(sqlane.schema.rollback({ targetVersion: '6.0.0' })).resolves.toStrictEqual({ reverted: JOB_LIST });
    await expect(hasJobsList(tablePrefix)).resolves.toBe(false);
    await expect(recordedIds(tablePrefix)).resolves.toStrictEqual(ALL_MIGRATIONS.slice(0, -JOB_LIST.length));
    await expect(sqlane.schema.migrate()).resolves.toStrictEqual({ applied: JOB_LIST });
    await expect(hasJobsList(tablePrefix)).resolves.toBe(true);
});

test('rollback: nothing above targetVersion, or no table: nothing reverted', async () => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix);

    await expect(sqlane.schema.rollback({ targetVersion: '6.0.0' })).resolves.toStrictEqual({ reverted: [] });
    await expect(listTables(tablePrefix)).resolves.toStrictEqual([]);
    await sqlane.schema.migrate({ targetVersion: '6.0.0' });
    await expect(sqlane.schema.rollback({ targetVersion: '6.0.0' })).resolves.toStrictEqual({ reverted: [] });
    await sqlane.schema.migrate();
    await expect(sqlane.schema.rollback({ targetVersion: '7.1.0' })).resolves.toStrictEqual({ reverted: [] });
    await expect(recordedIds(tablePrefix)).resolves.toStrictEqual(ALL_MIGRATIONS.toSorted());
});

test('rollback: a cut run is finished by running it again (the index gone, its record kept)', async () => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix);

    await sqlane.schema.migrate();
    await database.query(DROP_JOBS_LIST_SQL[database.family](tablePrefix));

    await expect(sqlane.schema.rollback({ targetVersion: '6.0.0' })).resolves.toStrictEqual({ reverted: JOB_LIST });
    await expect(recordedIds(tablePrefix)).resolves.toStrictEqual(ALL_MIGRATIONS.slice(0, -JOB_LIST.length));
});

test('rollback: a migration recorded but unknown to this version: a ConfigError, nothing reverted', async () => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix);

    await sqlane.schema.migrate();
    await database.query(`INSERT INTO ${tablePrefix}migrations (id, applied_at) VALUES ('0099_future', `
        + `${TIME_SQL[database.family].now})`);

    await expect(sqlane.schema.rollback({ targetVersion: '6.0.0' })).rejects.toThrow(new ConfigError(
        'schema.rollback(): migrations unknown to this version are recorded (0099_future): a newer version of sqlane '
        + 'applied them, and their down statements are not in this code',
    ));
    await expect(hasJobsList(tablePrefix)).resolves.toBe(true);
    await expect(recordedIds(tablePrefix)).resolves.toContain('0008_job_list');
});

test('rollback: waits for the lock of a table up to lockTimeout, then a MigrationLockTimeoutError', async () => {
    const tablePrefix = nextPrefix();
    const sqlane = sqlaneOf(tablePrefix);
    const holder = await testAdapter.connect();

    await sqlane.schema.migrate();
    // A transaction that read the table: it holds its lock (PostgreSQL ACCESS SHARE, a MySQL metadata lock)
    await holder.begin();
    await holder.execute(`SELECT count(*) FROM ${tablePrefix}jobs`);

    try {
        const startedAt = Date.now();

        await expect(sqlane.schema.rollback({ targetVersion: '6.0.0', lockTimeout: '1s' }))
            .rejects.toThrow(MigrationLockTimeoutError);
        expect(Date.now() - startedAt).toBeLessThan(5000);
    } finally {
        await holder.rollback();
        holder.release();
    }

    await expect(hasJobsList(tablePrefix)).resolves.toBe(true);
    await expect(recordedIds(tablePrefix)).resolves.toContain('0008_job_list');
});

test.runIf(isMysqlFamily)('rollback: the lock_wait_timeout of the session is restored', async () => {
    const pool = mysql.createPool({ uri: inject('databaseUrl'), connectionLimit: 1 });
    const dialect = /** @type {'mysql' | 'mariadb'} */ (database.dialect);
    const sqlane = createSqlane({ adapter: mysql2Adapter(pool, { dialect }), tablePrefix: nextPrefix() });

    try {
        await pool.query('SET SESSION lock_wait_timeout = 77');
        await sqlane.schema.migrate();
        await sqlane.schema.rollback({ targetVersion: '6.0.0', lockTimeout: '1s' });

        const [rows] = await pool.query('SELECT @@SESSION.lock_wait_timeout AS seconds');

        expect(Number(/** @type {any} */ (rows)[0].seconds)).toBe(77);
    } finally {
        await sqlane.close({ deadline: 0 });
        await pool.end();
    }
});

test('the check of the server: the version of the database, through the adapter', async () => {
    const [{ version }] = await testAdapter.adapter.queue.query(SERVER_VERSION_SQL, []);
    const server = parseServerVersion(String(version));
    // `mysql-8.4`, `mariadb-10.11`, `postgres-15`
    const [, major] = database.name.split('-');

    expect(server.dialect).toBe(database.dialect);
    expect(`${server.version}.`.startsWith(`${major}.`)).toBe(true);
});

test('the check of the server: another dialect, a ConfigError before any table', async () => {
    const other = /** @type {const} */ ({ mysql: 'mariadb', mariadb: 'mysql', postgres: 'mysql' })[database.dialect];
    const p = nextPrefix();
    const sqlane = createSqlane({ adapter: { ...testAdapter.adapter, dialect: other }, tablePrefix: p });

    await expect(sqlane.schema.migrate()).rejects.toThrow(ConfigError);
    await expect(sqlane.schema.migrate())
        .rejects.toThrow(`schema.migrate(): "dialect" is "${other}", but the database is `);
    await expect(sqlane.start()).rejects.toThrow(ConfigError);
    await sqlane.close({ deadline: 0 });
    await expect(listTables(p)).resolves.toStrictEqual([]);
});

/**
 * A mysql2 pool of one connection, with the sql_mode of its session: the check of the server reads that session.
 * @param {string} sqlMode
 * @param {{ allowUnsupportedDbConfiguration?: boolean }} [options]
 * @returns {Promise<{ adapter: import('../../src/types.js').Adapter<any>, pool: import('mysql2/promise').Pool }>}
 */
async function adapterWithSqlMode(sqlMode, options = {}) {
    const pool = mysql.createPool({ uri: inject('databaseUrl'), connectionLimit: 1 });
    const dialect = /** @type {'mysql' | 'mariadb'} */ (database.dialect);

    await pool.query(`SET SESSION sql_mode = ${sqlMode}`);

    return { adapter: mysql2Adapter(pool, { dialect, ...options }), pool };
}

const LACKING_STRICT = `the sql_mode of ${inject('databaseDialect') === 'mariadb' ? 'MariaDB' : 'MySQL'} lacks `
    + 'STRICT_TRANS_TABLES or STRICT_ALL_TABLES';

test.runIf(isMysqlFamily)('the check of the server: a sql_mode without strict mode, a ConfigError before any table', async () => {
    const { adapter, pool } = await adapterWithSqlMode('\'NO_ENGINE_SUBSTITUTION\'');
    const p = nextPrefix();
    const sqlane = createSqlane({ adapter, tablePrefix: p });

    try {
        await expect(sqlane.schema.migrate()).rejects.toThrow(ConfigError);
        await expect(sqlane.schema.migrate()).rejects.toThrow(`schema.migrate(): ${LACKING_STRICT}`);
        await expect(sqlane.start()).rejects.toThrow(`start(): ${LACKING_STRICT}`);
        await expect(listTables(p)).resolves.toStrictEqual([]);
    } finally {
        await sqlane.close({ deadline: 0 });
        await pool.end();
    }
});

test.runIf(isMysqlFamily)('the check of the server: allowUnsupportedDbConfiguration, a warning', async () => {
    const { adapter, pool } = await adapterWithSqlMode('\'NO_ENGINE_SUBSTITUTION\'', {
        allowUnsupportedDbConfiguration: true,
    });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sqlane = createSqlane({ adapter, tablePrefix: nextPrefix(), logger });

    try {
        await expect(sqlane.schema.migrate()).resolves.toStrictEqual({ applied: ALL_MIGRATIONS });
        expect(logger.warn).toHaveBeenCalledOnce();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ dialect: database.dialect, sqlMode: 'NO_ENGINE_SUBSTITUTION', forbidden: [] }),
            expect.stringContaining(`sqlane: ${LACKING_STRICT}`),
        );
    } finally {
        await sqlane.close({ deadline: 0 });
        await pool.end();
    }
});

test.runIf(isMysqlFamily)('the check of the server: NO_BACKSLASH_ESCAPES, a ConfigError also with allowUnsupportedDbConfiguration', async () => {
    const { adapter, pool } = await adapterWithSqlMode('CONCAT(@@SESSION.sql_mode, \',NO_BACKSLASH_ESCAPES\')', {
        allowUnsupportedDbConfiguration: true,
    });
    const p = nextPrefix();
    const sqlane = createSqlane({ adapter, tablePrefix: p });

    try {
        await expect(sqlane.schema.migrate()).rejects.toThrow(ConfigError);
        await expect(sqlane.schema.migrate())
            .rejects.toThrow(/^schema\.migrate\(\): the sql_mode of (MySQL|MariaDB) has NO_BACKSLASH_ESCAPES: /u);
        await expect(listTables(p)).resolves.toStrictEqual([]);
    } finally {
        await sqlane.close({ deadline: 0 });
        await pool.end();
    }
});
