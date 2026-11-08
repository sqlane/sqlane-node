import { parseDuration } from './duration.js';
import { ConfigError, InvalidOptionsError, MigrationLockTimeoutError } from './errors.js';
import { mysqlMigrations, mysqlMigrationsTable } from './schema/mysql.js';
import { postgresMigrations, postgresMigrationsTable } from './schema/postgres.js';
import { checkTablePrefix } from './validate.js';

/** @typedef {import('./types.js').Executor} Executor */

/**
 * The schema of sqlane as versioned SQL, for the app's own migration tool.
 * @param {object} options
 * @param {'mysql' | 'postgres'} options.dialect
 * @param {string} [options.tablePrefix] Default: `'sqlane_'`.
 * @returns {import('./types.js').Migration[]}
 */
export function getMigrations({ dialect, tablePrefix = 'sqlane_' }) {
    const scope = { where: 'getMigrations', ErrorClass: ConfigError };

    checkTablePrefix(tablePrefix, scope);

    if (dialect === 'mysql') {
        return mysqlMigrations(tablePrefix);
    }

    if (dialect === 'postgres') {
        return postgresMigrations(tablePrefix);
    }

    throw new ConfigError(`getMigrations: "dialect" must be 'mysql' or 'postgres'`);
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
 * @param {import('./types.js').Migration[]} missing
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
 * @param {Executor} executor
 * @param {string} p
 * @param {number} lockTimeoutMs
 * @returns {Promise<string[]>}
 */
async function migrateMysql(executor, p, lockTimeoutMs) {
    const lockName = `${p}migrations`;
    // GET_LOCK waits whole seconds; -1 is forever, so at least 1
    const [{ locked }] = await executor.query('SELECT GET_LOCK(?, ?) AS locked', [
        lockName,
        Math.max(1, Math.ceil(lockTimeoutMs / 1000)),
    ]);

    if (Number(locked) !== 1) {
        throw new MigrationLockTimeoutError(`migrate: the lock "${lockName}" was not free in ${lockTimeoutMs} ms`);
    }

    try {
        await executor.query(mysqlMigrationsTable(p), []);

        const applied = await readApplied(executor, `${p}migrations`);
        const missing = mysqlMigrations(p).filter(({ id }) => !applied.has(id));

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
 * @param {boolean} inTransaction The connection is in a transaction already: its owner commits it.
 * @returns {Promise<string[]>}
 */
async function migratePostgres(executor, p, lockTimeoutMs, inTransaction) {
    if (!inTransaction) {
        await executor.query('BEGIN', []);
    }

    try {
        // SET LOCAL: until the end of the transaction, then the pooled connection gets its settings back
        await executor.query('SET LOCAL statement_timeout = 0', []);
        await executor.query(`SET LOCAL lock_timeout = ${Math.max(1, lockTimeoutMs)}`, []);

        try {
            // In FROM: the function returns void, a type that some clients cannot read (Prisma)
            await executor.query('SELECT true AS locked FROM pg_advisory_xact_lock(hashtext($1))', [`${p}migrations`]);
        } catch (error) {
            if (/** @type {{ code?: string }} */ (error).code === '55P03') {
                throw new MigrationLockTimeoutError(
                    `migrate: the lock of "${p}migrations" was not free in ${lockTimeoutMs} ms`,
                    { cause: error },
                );
            }

            throw error;
        }

        await executor.query('SET LOCAL lock_timeout = 0', []);
        await executor.query(postgresMigrationsTable(p), []);

        const applied = await readApplied(executor, `${p}migrations`);
        const missing = postgresMigrations(p).filter(({ id }) => !applied.has(id));

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
 * Applies the missing migrations under a DB lock, on a connection of its own, without a statement timeout.
 * @template C
 * @param {import('./types.js').Adapter<C>} adapter
 * @param {string} tablePrefix Checked.
 * @param {import('./types.js').MigrateOptions} [options]
 * @returns {Promise<string[]>} The ids of the applied migrations.
 */
export function runMigrations(adapter, tablePrefix, options = {}) {
    const lockTimeoutMs = parseDuration(options.lockTimeout ?? '10m');

    if (lockTimeoutMs === null) {
        return Promise.reject(new InvalidOptionsError('migrate: "lockTimeout" must be a duration'));
    }

    return adapter.withConnection(executor => (adapter.dialect === 'mysql'
        ? migrateMysql(executor, tablePrefix, lockTimeoutMs)
        : migratePostgres(executor, tablePrefix, lockTimeoutMs, adapter.transactionalConnection === true)));
}
