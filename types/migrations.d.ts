export type Executor = import('./types.js').Executor;
export type DownStep = string | {
    ifIndexExists: [table: string, index: string];
    sql: string;
};
export type Migration = {
    /**
     * Such as `0001_initial`. The order of the migrations.
     */
    id: string;
    /**
     * The lowest version of sqlane that ships it, on this dialect. Never below the tag of an
     * earlier id.
     */
    version: string;
    /**
     * Its SQL, in order.
     */
    statements: readonly string[];
    /**
     * Reverts it: every migration tagged above 6.0.0 has one.
     */
    down?: readonly DownStep[];
};
/**
 * @param {import('./types.js').Dialect} dialect
 * @param {string} p The table prefix, checked.
 * @returns {Migration[]} In id order.
 */
export declare function migrationsOf(dialect: import('./types.js').Dialect, p: string): Migration[];
export type MigrationLock = {
    lockTimeoutMs: number;
    /**
     * The caller, for the errors.
     */
    where: string;
    /**
     * PostgreSQL: `lock_timeout` stays at `lockTimeoutMs` for the table locks of
     * the DDL, instead of 0. A rollback: its DDL waits behind the queries of the running processes.
     */
    boundTableLocks?: boolean;
};
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
export declare function runMigrations<C>(adapter: import('./types.js').Adapter<C>, tablePrefix: string, options?: import('./types.js').MigrateOptions, context?: {
    checkServer?: () => Promise<void>;
    installedVersion?: string;
}): Promise<string[]>;
/**
 * @param {Set<string>} recorded
 * @param {Migration[]} known
 * @returns {string[]} The recorded ids unknown to this version, sorted: a newer version applied them.
 */
export declare function unknownIds(recorded: Set<string>, known: Migration[]): string[];
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
export declare function rollbackMigrations<C>(adapter: import('./types.js').Adapter<C>, tablePrefix: string, options: import('./types.js').RollbackOptions, context?: {
    checkServer?: () => Promise<void>;
    installedVersion?: string;
}): Promise<string[]>;
/**
 * Drops every table that sqlane created under the prefix, in any version, under the lock of `runMigrations`. Only
 * the tables of sqlane: `<p>jobs` has `enqueue_token` and `lock_token` (every version), or `<p>migrations` records
 * `0001_initial`.
 * @template C
 * @param {import('./types.js').Adapter<C>} adapter
 * @param {string} tablePrefix Checked.
 * @param {import('./types.js').DropOptions} [options]
 * @param {() => Promise<void>} [checkServer] Runs after the options are checked, before the drop.
 * @returns {Promise<string[]>} The tables that existed, in the order of the drop: `<p>migrations` last.
 */
export declare function dropTables<C>(adapter: import('./types.js').Adapter<C>, tablePrefix: string, options?: import('./types.js').DropOptions, checkServer?: () => Promise<void>): Promise<string[]>;
