export type Executor = import('./types.js').Executor;
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
};
/**
 * @param {import('./types.js').Dialect} dialect
 * @param {string} p The table prefix, checked.
 * @returns {Migration[]} In id order.
 */
export declare function migrationsOf(dialect: import('./types.js').Dialect, p: string): Migration[];
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
