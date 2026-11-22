import { parseDuration } from './duration.js';
import { InvalidOptionsError, MigrationLockTimeoutError } from './errors.js';
import { mariadbMigrations, mariadbMigrationsTable } from './schema/mariadb.js';
import { mysqlMigrations, mysqlMigrationsTable } from './schema/mysql.js';
import { postgresMigrations, postgresMigrationsTable } from './schema/postgres.js';
import { baseVersion, compareVersions, installedVersion, parseVersion } from './version.js';

/** @typedef {import('./types.js').Executor} Executor */

/**
 * @typedef {object} Migration
 * @property {string} id Such as `0001_initial`. The order of the migrations.
 * @property {string} version The lowest version of sqlane that ships it, on this dialect. Never below the tag of an
 *     earlier id.
 * @property {readonly string[]} statements Its SQL, in order.
 */

/** The lowest `targetVersion`: 0005 and 0006 turned the mutex keys of 5.x into slots, with no way back */
const MIN_TARGET_VERSION = '6.0.0';

const MIGRATIONS = { mysql: mysqlMigrations, mariadb: mariadbMigrations, postgres: postgresMigrations };

/**
 * @param {import('./types.js').Dialect} dialect
 * @param {string} p The table prefix, checked.
 * @returns {Migration[]} In id order.
 */
export function migrationsOf(dialect, p) {
    return MIGRATIONS[dialect](p);
}

/**
 * The migrations up to `targetVersion`: from 6.0.0 up to the installed version, or to the highest tag when it is
 * above (a migration merged before its release).
 * @param {Migration[]} migrations
 * @param {unknown} targetVersion
 * @param {string} installed The installed version: a pre-release counts as its base version.
 * @returns {Migration[]}
 */
function upToTarget(migrations, targetVersion, installed) {
    const highestTag = /** @type {Migration} */ (migrations.at(-1)).version;
    const base = baseVersion(installed);
    const maxTarget = compareVersions(base, highestTag) > 0 ? base : highestTag;

    if (
        !parseVersion(targetVersion)
        || compareVersions(/** @type {string} */ (targetVersion), MIN_TARGET_VERSION) < 0
        || compareVersions(/** @type {string} */ (targetVersion), maxTarget) > 0
    ) {
        throw new InvalidOptionsError(
            `schema.migrate(): "targetVersion" must be a version 'X.Y.Z' from ${MIN_TARGET_VERSION} to ${maxTarget}`,
        );
    }

    return migrations.filter(({ version }) => compareVersions(version, /** @type {string} */ (targetVersion)) <= 0);
}

/**
 * Runs the statements one after the other: DDL in order.
 * @param {Executor} executor
 * @param {{ sql: string, params: unknown[] }[]} steps
 * @returns {Promise<void>}
 */
async function runInOrder(executor, steps) {
    for (const { sql, params } of steps) {
        // oxlint-disable-next-line no-await-in-loop -- each statement needs the previous one
        await executor.query(sql, params);
    }
}

/**
 * The statements of the missing migrations, each followed by its record.
 * @param {Migration[]} missing
 * @param {string} recordSql
 * @returns {{ sql: string, params: unknown[] }[]}
 */
function toSteps(missing, recordSql) {
    return missing.flatMap(({ id, statements }) => [
        ...statements.map(sql => ({ sql, params: [] })),
        { sql: recordSql, params: [id] },
    ]);
}

/**
 * @param {Executor} executor
 * @param {string} table
 * @returns {Promise<Set<string>>}
 */
async function readApplied(executor, table) {
    const rows = await executor.query(`SELECT id FROM ${table}`, []);

    return new Set(rows.map(row => String(row.id)));
}

/**
 * MySQL and MariaDB: each has a schema of its own.
 * @param {Executor} executor
 * @param {string} p
 * @param {number} lockTimeoutMs
 * @param {object} schema
 * @param {Migration[]} schema.migrations Those to apply if missing.
 * @param {(p: string) => string} schema.migrationsTable
 * @returns {Promise<string[]>}
 */
async function migrateMysql(executor, p, lockTimeoutMs, { migrations, migrationsTable }) {
    const lockName = `${p}migrations`;
    // GET_LOCK waits whole seconds; -1 is forever, so at least 1
    const [{ locked }] = await executor.query('SELECT GET_LOCK(?, ?) AS locked', [
        lockName,
        Math.max(1, Math.ceil(lockTimeoutMs / 1000)),
    ]);

    if (Number(locked) !== 1) {
        throw new MigrationLockTimeoutError(
            `schema.migrate(): the lock "${lockName}" was not free in ${lockTimeoutMs} ms`,
        );
    }

    try {
        await executor.query(migrationsTable(p), []);

        const applied = await readApplied(executor, `${p}migrations`);
        const missing = migrations.filter(({ id }) => !applied.has(id));

        await runInOrder(executor, toSteps(missing, `INSERT INTO ${p}migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))`));

        return missing.map(({ id }) => id);
    } finally {
        await executor.query('SELECT RELEASE_LOCK(?)', [lockName]);
    }
}

/**
 * One transaction: the lock, the DDL and the ids of the migrations.
 * @param {Executor} executor
 * @param {string} p
 * @param {number} lockTimeoutMs
 * @param {object} run
 * @param {Migration[]} run.migrations Those to apply if missing.
 * @param {boolean} run.inTransaction The connection is in a transaction already: its owner commits it.
 * @returns {Promise<string[]>}
 */
async function migratePostgres(executor, p, lockTimeoutMs, { migrations, inTransaction }) {
    if (!inTransaction) {
        await executor.query('BEGIN', []);
    }

    try {
        // SET LOCAL: until the end of the transaction, then the pooled connection gets its settings back
        await executor.query('SET LOCAL statement_timeout = 0', []);
        // set_config(…, true) is SET LOCAL with a parameter: one SQL text for every timeout (one prepared statement)
        await executor.query('SELECT set_config(\'lock_timeout\', $1, true) AS lock_timeout', [
            `${Math.max(1, lockTimeoutMs)}ms`,
        ]);

        try {
            // In FROM: the function returns void, a type that some clients cannot read (Prisma)
            await executor.query('SELECT true AS locked FROM pg_advisory_xact_lock(hashtext($1))', [`${p}migrations`]);
        } catch (error) {
            if (/** @type {{ code?: string }} */ (error).code === '55P03') {
                throw new MigrationLockTimeoutError(
                    `schema.migrate(): the lock of "${p}migrations" was not free in ${lockTimeoutMs} ms`,
                    { cause: error },
                );
            }

            throw error;
        }

        await executor.query('SET LOCAL lock_timeout = 0', []);
        await executor.query(postgresMigrationsTable(p), []);

        const applied = await readApplied(executor, `${p}migrations`);
        const missing = migrations.filter(({ id }) => !applied.has(id));

        await runInOrder(executor, toSteps(missing, `INSERT INTO ${p}migrations (id, applied_at) VALUES ($1, clock_timestamp())`));

        if (!inTransaction) {
            await executor.query('COMMIT', []);
        }

        return missing.map(({ id }) => id);
    } catch (error) {
        if (!inTransaction) {
            await executor.query('ROLLBACK', []);
        }

        throw error;
    }
}

/**
 * Applies the missing migrations, up to `targetVersion` if given, under a DB lock, on a connection of its own, without
 * a statement timeout.
 * @template C
 * @param {import('./types.js').Adapter<C>} adapter
 * @param {string} tablePrefix Checked.
 * @param {import('./types.js').MigrateOptions} [options]
 * @param {object} [context]
 * @param {() => Promise<void>} [context.checkServer] Runs after the options are checked, before the migration.
 * @param {string} [context.installedVersion] For the tests of sqlane. Default: the version of package.json, read
 *     only with a `targetVersion`.
 * @returns {Promise<string[]>} The ids of the applied migrations.
 */
export async function runMigrations(adapter, tablePrefix, options = {}, context = {}) {
    const lockTimeoutMs = parseDuration(options.lockTimeout ?? '10m');

    if (lockTimeoutMs === null) {
        throw new InvalidOptionsError('schema.migrate(): "lockTimeout" must be a duration');
    }

    const known = migrationsOf(adapter.dialect, tablePrefix);
    const migrations = options.targetVersion === undefined
        ? known
        : upToTarget(known, options.targetVersion, context.installedVersion ?? installedVersion());

    await context.checkServer?.();

    return adapter.withConnection((executor) => {
        if (adapter.dialect === 'mysql') {
            return migrateMysql(executor, tablePrefix, lockTimeoutMs, {
                migrations,
                migrationsTable: mysqlMigrationsTable,
            });
        }

        if (adapter.dialect === 'mariadb') {
            return migrateMysql(executor, tablePrefix, lockTimeoutMs, {
                migrations,
                migrationsTable: mariadbMigrationsTable,
            });
        }

        return migratePostgres(executor, tablePrefix, lockTimeoutMs, {
            migrations,
            inTransaction: adapter.transactionalConnection === true,
        });
    });
}
