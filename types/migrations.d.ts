export type Executor = import('./types.js').Executor;
/** @typedef {import('./types.js').Executor} Executor */
/**
 * The schema of sqlane as versioned SQL, for the app's own migration tool.
 * @param {object} options
 * @param {import('./types.js').Dialect} options.dialect
 * @param {string} [options.tablePrefix] Default: `'sqlane_'`.
 * @returns {import('./types.js').Migration[]}
 */
export declare function getMigrations({ dialect, tablePrefix }: {
    dialect: import('./types.js').Dialect;
    tablePrefix?: string;
}): import('./types.js').Migration[];
/**
 * Applies the missing migrations under a DB lock, on a connection of its own, without a statement timeout.
 * @template C
 * @param {import('./types.js').Adapter<C>} adapter
 * @param {string} tablePrefix Checked.
 * @param {import('./types.js').MigrateOptions} [options]
 * @returns {Promise<string[]>} The ids of the applied migrations.
 */
export declare function runMigrations<C>(adapter: import('./types.js').Adapter<C>, tablePrefix: string, options?: import('./types.js').MigrateOptions): Promise<string[]>;
