import { expect, test } from 'vitest';
import { migrationsOf, runMigrations } from './migrations.js';
import { compareVersions, parseVersion } from './version.js';

/** The migrations of 6.0, of the rate limits and of the lists of jobs */
const SIX = ['0005_concurrency_limits', '0006_concurrency_slots', '0007_rate_limits', '0008_job_list'];

test.each([
    // No 0003 on MySQL and MariaDB: the ids are matched, never counted
    { dialect: 'mysql', ids: ['0001_initial', '0002_job_keys', '0004_schedules', ...SIX] },
    { dialect: 'mariadb', ids: ['0001_initial', '0002_job_keys', '0004_schedules', ...SIX] },
    { dialect: 'postgres', ids: ['0001_initial', '0002_pending_order', '0003_job_keys', '0004_schedules', ...SIX] },
])('$dialect: the migrations use the table prefix', ({ dialect, ids }) => {
    const migrations = migrationsOf(/** @type {import('./types.js').Dialect} */ (dialect), 'q_');

    expect(migrations.map(({ id }) => id)).toStrictEqual(ids);
    expect(migrations[0].statements.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS q_jobs /);
    expect(migrations[0].statements.join('\n')).not.toMatch(/sqlane_/);
});

test.each(['mysql', 'mariadb', 'postgres'])('%s: each migration is tagged with a version; tags never decrease', (
    dialect,
) => {
    const migrations = migrationsOf(/** @type {import('./types.js').Dialect} */ (dialect), 'q_');
    const versions = migrations.map(({ version }) => version);

    expect(versions.filter(version => !parseVersion(version))).toStrictEqual([]);
    expect(versions.toSorted(compareVersions)).toStrictEqual(versions);
});

test.each(['mysql', 'mariadb', 'postgres'])('%s: each migration tagged above 6.0.0 has a down', (dialect) => {
    const migrations = migrationsOf(/** @type {import('./types.js').Dialect} */ (dialect), 'q_')
        .filter(({ version }) => compareVersions(version, '6.0.0') > 0);

    expect(migrations.map(({ id }) => id)).toContain('0008_job_list');
    expect(migrations.filter(({ down }) => !down?.length).map(({ id }) => id)).toStrictEqual([]);
});

test.each(['mysql', 'mariadb', 'postgres'])('%s: 0004_schedules creates the table of the schedules', (dialect) => {
    const migrations = migrationsOf(/** @type {import('./types.js').Dialect} */ (dialect), 'q_');
    const sql = migrations.find(({ id }) => id === '0004_schedules')?.statements.join('\n');

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS q_schedules /);
});

test('mariadb: the collation of MariaDB 10.11 (it has no utf8mb4_0900_bin)', () => {
    const sql = migrationsOf('mariadb', 'sqlane_').flatMap(({ statements }) => statements).join('\n');

    expect(sql).toMatch(/COLLATE = utf8mb4_bin/);
    expect(sql).not.toMatch(/utf8mb4_0900_bin/);
});

test.each([
    { dialect: 'mysql', time: /tat DATETIME\(6\) NOT NULL/, column: /ADD COLUMN rate_limits JSON NULL/,
        index: /KEY q_rate_limits_tat \(tat\)/ },
    { dialect: 'mariadb', time: /tat DATETIME\(6\) NOT NULL/, column: /ADD COLUMN IF NOT EXISTS rate_limits JSON NULL/,
        index: /KEY q_rate_limits_tat \(tat\)/ },
    { dialect: 'postgres', time: /tat timestamptz\(6\) NOT NULL/, column: /ADD COLUMN IF NOT EXISTS rate_limits jsonb/,
        index: /CREATE INDEX IF NOT EXISTS q_rate_limits_tat ON q_rate_limits \(tat\)/ },
])('$dialect: 0007_rate_limits: the table of the rate keys, in µs, with an index on tat, and the column of the jobs', ({
    dialect, time, column, index,
}) => {
    const migrations = migrationsOf(/** @type {import('./types.js').Dialect} */ (dialect), 'q_');
    const sql = migrations.find(({ id }) => id === '0007_rate_limits')?.statements.join('\n');

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS q_rate_limits /);
    expect(sql).toMatch(time);
    expect(sql).toMatch(column);
    expect(sql).toMatch(index);
});

test.each([
    { dialect: 'mysql', index: /^ALTER TABLE q_jobs ADD KEY q_jobs_list \(job_name, created_at, id\)$/ },
    { dialect: 'mariadb', index: /^ALTER TABLE q_jobs ADD KEY IF NOT EXISTS q_jobs_list \(job_name, created_at, id\)$/ },
    { dialect: 'postgres', index: /^CREATE INDEX IF NOT EXISTS q_jobs_list ON q_jobs \(job_name, created_at, id\)$/ },
])('$dialect: 0008_job_list: an index for the lists of a name, newest first', ({ dialect, index }) => {
    const migrations = migrationsOf(/** @type {import('./types.js').Dialect} */ (dialect), 'q_');

    expect(migrations.find(({ id }) => id === '0008_job_list')?.statements).toMatchObject([expect.stringMatching(index)]);
});

/**
 * The statements of a migration on PostgreSQL, against a database that has all the migrations.
 * @param {string} lockTimeout
 * @returns {Promise<{ sql: string, params: readonly unknown[] }[]>}
 */
async function postgresStatements(lockTimeout) {
    /** @type {{ sql: string, params: readonly unknown[] }[]} */
    const statements = [];
    const applied = migrationsOf('postgres', 'sqlane_').map(({ id }) => ({ id }));
    /** @type {import('./types.js').Executor} */
    const executor = {
        query: async (sql, params) => {
            statements.push({ sql, params });

            return sql.startsWith('SELECT id FROM') ? applied : [{}];
        },
        run: async () => 0,
    };
    /**
     * @param {(executor: import('./types.js').Executor) => Promise<unknown>} func
     * @returns {Promise<unknown>}
     */
    const withConnection = func => func(executor);
    const adapter = /** @type {import('./types.js').Adapter<unknown>} */ (/** @type {unknown} */ ({
        dialect: 'postgres',
        withConnection,
    }));

    await runMigrations(adapter, 'sqlane_', { lockTimeout });

    return statements;
}

test('postgres: the SQL of migrate does not depend on lockTimeout: one prepared statement each', async () => {
    const short = await postgresStatements('1s');
    const long = await postgresStatements('7m');

    expect(short.map(({ sql }) => sql)).toStrictEqual(long.map(({ sql }) => sql));
    const sql = 'SELECT set_config(\'lock_timeout\', $1, true) AS lock_timeout';

    expect(short).toContainEqual({ sql, params: ['1000ms'] });
    expect(long).toContainEqual({ sql, params: ['420000ms'] });
});
