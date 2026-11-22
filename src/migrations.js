import { parseDuration } from './duration.js';
import { ConfigError, InvalidOptionsError, MigrationLockTimeoutError } from './errors.js';
import { mariadbMigrations, mariadbMigrationsTable } from './schema/mariadb.js';
import { mysqlMigrations, mysqlMigrationsTable } from './schema/mysql.js';
import { postgresMigrations, postgresMigrationsTable } from './schema/postgres.js';
import { indexExists, recordedIds } from './store/schema_reads.js';
import { isLockTimeoutError } from './transient_error.js';
import { baseVersion, compareVersions, installedVersion, parseVersion } from './version.js';

/** @typedef {import('./types.js').Executor} Executor */

/**
 * A statement of a down migration, safe to run again: plain SQL, or SQL that runs only if an index exists (MySQL has
 * no `DROP KEY IF EXISTS`).
 * @typedef {string | { ifIndexExists: [table: string, index: string], sql: string }} DownStep
 */

/**
 * @typedef {object} Migration
 * @property {string} id Such as `0001_initial`. The order of the migrations.
 * @property {string} version The lowest version of sqlane that ships it, on this dialect. Never below the tag of an
 *     earlier id.
 * @property {readonly string[]} statements Its SQL, in order.
 * @property {readonly DownStep[]} [down] Reverts it: every migration tagged above 6.0.0 has one.
 */

/** The lowest `targetVersion`: 0005 and 0006 turned the mutex keys of 5.x into slots, with no way back */
const MIN_TARGET_VERSION = '6.0.0';

const MIGRATIONS = { mysql: mysqlMigrations, mariadb: mariadbMigrations, postgres: postgresMigrations };
const MIGRATIONS_TABLES = {
    mysql: mysqlMigrationsTable,
    mariadb: mariadbMigrationsTable,
    postgres: postgresMigrationsTable,
};

/**
 * @param {import('./types.js').Dialect} dialect
 * @param {string} p The table prefix, checked.
 * @returns {Migration[]} In id order.
 */
export function migrationsOf(dialect, p) {
    return MIGRATIONS[dialect](p);
}

/**
 * Checks a `targetVersion`: from 6.0.0 up to the installed version, or to the highest tag when it is above (a
 * migration merged before its release).
 * @param {unknown} targetVersion
 * @param {Migration[]} migrations
 * @param {string} installed The installed version: a pre-release counts as its base version.
 * @param {string} where The caller, for the error.
 * @returns {string} The target.
 */
function checkTarget(targetVersion, migrations, installed, where) {
    const highestTag = /** @type {Migration} */ (migrations.at(-1)).version;
    const base = baseVersion(installed);
    const maxTarget = compareVersions(base, highestTag) > 0 ? base : highestTag;

    if (
        !parseVersion(targetVersion)
        || compareVersions(/** @type {string} */ (targetVersion), MIN_TARGET_VERSION) < 0
        || compareVersions(/** @type {string} */ (targetVersion), maxTarget) > 0
    ) {
        throw new InvalidOptionsError(
            `${where}: "targetVersion" must be a version 'X.Y.Z' from ${MIN_TARGET_VERSION} to ${maxTarget}`,
        );
    }

    return /** @type {string} */ (targetVersion);
}

/**
 * @param {import('./types.js').Duration | undefined} lockTimeout
 * @param {string} where The caller, for the error.
 * @returns {number} The ms. Default: 10 minutes.
 */
function checkLockTimeout(lockTimeout, where) {
    const lockTimeoutMs = parseDuration(lockTimeout ?? '10m');

    if (lockTimeoutMs === null) {
        throw new InvalidOptionsError(`${where}: "lockTimeout" must be a duration`);
    }

    return lockTimeoutMs;
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
 * @typedef {object} MigrationLock
 * @property {number} lockTimeoutMs
 * @property {string} where The caller, for the errors.
 * @property {boolean} [boundTableLocks] PostgreSQL: `lock_timeout` stays at `lockTimeoutMs` for the table locks of
 *     the DDL, instead of 0. A rollback: its DDL waits behind the queries of the running processes.
 */

/**
 * MySQL and MariaDB: under `GET_LOCK`. Each DDL commits on its own.
 * @template T
 * @param {Executor} executor
 * @param {string} p
 * @param {MigrationLock} lock
 * @param {(executor: Executor) => Promise<T>} func
 * @returns {Promise<T>}
 */
async function withMysqlLock(executor, p, { lockTimeoutMs, where }, func) {
    const lockName = `${p}migrations`;
    // GET_LOCK waits whole seconds; -1 is forever, so at least 1
    const [{ locked }] = await executor.query('SELECT GET_LOCK(?, ?) AS locked', [
        lockName,
        Math.max(1, Math.ceil(lockTimeoutMs / 1000)),
    ]);

    if (Number(locked) !== 1) {
        throw new MigrationLockTimeoutError(`${where}: the lock "${lockName}" was not free in ${lockTimeoutMs} ms`);
    }

    try {
        return await func(executor);
    } finally {
        await executor.query('SELECT RELEASE_LOCK(?)', [lockName]);
    }
}

/**
 * PostgreSQL: one transaction under `pg_advisory_xact_lock`, without a statement timeout.
 * @template T
 * @param {Executor} executor
 * @param {string} p
 * @param {MigrationLock & { inTransaction: boolean }} lock `inTransaction`: the connection is in a transaction
 *     already, its owner commits it.
 * @param {(executor: Executor) => Promise<T>} func
 * @returns {Promise<T>}
 */
async function withPostgresLock(executor, p, { lockTimeoutMs, where, boundTableLocks, inTransaction }, func) {
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
            if (isLockTimeoutError(error)) {
                throw new MigrationLockTimeoutError(
                    `${where}: the lock of "${p}migrations" was not free in ${lockTimeoutMs} ms`,
                    { cause: error },
                );
            }

            throw error;
        }

        if (!boundTableLocks) {
            await executor.query('SET LOCAL lock_timeout = 0', []);
        }

        const result = await func(executor);

        if (!inTransaction) {
            await executor.query('COMMIT', []);
        }

        return result;
    } catch (error) {
        if (!inTransaction) {
            await executor.query('ROLLBACK', []);
        }

        throw error;
    }
}

/**
 * Runs func under the migration lock of the prefix, on a connection of its own.
 * @template T, C
 * @param {import('./types.js').Adapter<C>} adapter
 * @param {string} p
 * @param {MigrationLock} lock
 * @param {(executor: Executor) => Promise<T>} func
 * @returns {Promise<T>}
 */
function withMigrationLock(adapter, p, lock, func) {
    return adapter.withConnection(executor => (adapter.dialect === 'postgres'
        ? withPostgresLock(executor, p, { ...lock, inTransaction: adapter.transactionalConnection === true }, func)
        : withMysqlLock(executor, p, lock, func)));
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
    const where = 'schema.migrate()';
    const lockTimeoutMs = checkLockTimeout(options.lockTimeout, where);
    const known = migrationsOf(adapter.dialect, tablePrefix);
    const target = options.targetVersion === undefined
        ? null
        : checkTarget(options.targetVersion, known, context.installedVersion ?? installedVersion(), where);
    const migrations = target === null ? known : known.filter(({ version }) => compareVersions(version, target) <= 0);
    const recordSql = adapter.dialect === 'postgres'
        ? `INSERT INTO ${tablePrefix}migrations (id, applied_at) VALUES ($1, clock_timestamp())`
        : `INSERT INTO ${tablePrefix}migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))`;

    await context.checkServer?.();

    return withMigrationLock(adapter, tablePrefix, { lockTimeoutMs, where }, async (executor) => {
        await executor.query(MIGRATIONS_TABLES[adapter.dialect](tablePrefix), []);

        const applied = await readApplied(executor, `${tablePrefix}migrations`);
        const missing = migrations.filter(({ id }) => !applied.has(id));

        await runInOrder(executor, toSteps(missing, recordSql));

        return missing.map(({ id }) => id);
    });
}

/**
 * MySQL and MariaDB: each DDL waits for its table lock up to `lockTimeoutMs` (`lock_wait_timeout`, whole seconds).
 * @param {Executor} executor
 * @param {number} lockTimeoutMs
 * @returns {Promise<() => Promise<void>>} Restores the value of the session.
 */
async function boundMysqlTableLocks(executor, lockTimeoutMs) {
    const [{ seconds }] = await executor.query('SELECT @@SESSION.lock_wait_timeout AS seconds', []);

    await executor.query('SET SESSION lock_wait_timeout = ?', [Math.max(1, Math.ceil(lockTimeoutMs / 1000))]);

    return async () => {
        await executor.query('SET SESSION lock_wait_timeout = ?', [Number(seconds)]);
    };
}

/**
 * @param {Executor} executor
 * @param {DownStep} step
 * @returns {Promise<void>}
 */
async function runDownStep(executor, step) {
    if (typeof step === 'string') {
        await executor.query(step, []);
    } else if (await indexExists(executor, ...step.ifIndexExists)) {
        await executor.query(step.sql, []);
    }
}

/**
 * Reverts the recorded migrations tagged above `targetVersion`, newest first: the down of each, then the delete of its
 * record. Under the lock of `runMigrations`; PostgreSQL: in its one transaction.
 * @template C
 * @param {import('./types.js').Adapter<C>} adapter
 * @param {string} tablePrefix Checked.
 * @param {import('./types.js').RollbackOptions} options
 * @param {object} [context]
 * @param {() => Promise<void>} [context.checkServer] Runs after the options are checked, before the rollback.
 * @param {string} [context.installedVersion] For the tests of sqlane. Default: the version of package.json.
 * @returns {Promise<string[]>} The ids of the reverted migrations, in the order of their revert.
 */
export async function rollbackMigrations(adapter, tablePrefix, options, context = {}) {
    const where = 'schema.rollback()';
    const { dialect } = adapter;
    const lockTimeoutMs = checkLockTimeout(options?.lockTimeout, where);
    const known = migrationsOf(dialect, tablePrefix);
    const target = checkTarget(options?.targetVersion, known, context.installedVersion ?? installedVersion(), where);
    const deleteSql = dialect === 'postgres'
        ? `DELETE FROM ${tablePrefix}migrations WHERE id = $1`
        : `DELETE FROM ${tablePrefix}migrations WHERE id = ?`;

    await context.checkServer?.();

    try {
        return await withMigrationLock(adapter, tablePrefix, { lockTimeoutMs, where, boundTableLocks: true }, async (
            executor,
        ) => {
            const recorded = await recordedIds(executor, dialect, tablePrefix);
            const unknown = [...recorded].filter(id => !known.some(migration => migration.id === id)).toSorted();

            if (unknown.length > 0) {
                throw new ConfigError(`${where}: migrations unknown to this version are recorded `
                    + `(${unknown.join(', ')}): a newer version of sqlane applied them, and their down statements `
                    + 'are not in this code');
            }

            const reverted = known
                .filter(({ id, version }) => recorded.has(id) && compareVersions(version, target) > 0)
                .toReversed();
            const restore = dialect === 'postgres' ? null : await boundMysqlTableLocks(executor, lockTimeoutMs);

            try {
                for (const { id, down = [] } of reverted) {
                    for (const step of down) {
                        // oxlint-disable-next-line no-await-in-loop -- DDL in order
                        await runDownStep(executor, step);
                    }

                    // oxlint-disable-next-line no-await-in-loop -- after its down
                    await executor.query(deleteSql, [id]);
                }
            } finally {
                await restore?.();
            }

            return reverted.map(({ id }) => id);
        });
    } catch (error) {
        if (isLockTimeoutError(error) && !(error instanceof MigrationLockTimeoutError)) {
            throw new MigrationLockTimeoutError(`${where}: a table lock was not free in ${lockTimeoutMs} ms`, {
                cause: error,
            });
        }

        throw error;
    }
}
