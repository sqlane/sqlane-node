/**
 * @param {import('../types.js').Executor} executor
 * @param {import('../types.js').Dialect} dialect
 * @param {string} table
 * @returns {Promise<boolean>}
 */
export declare function tableExists(executor: import('../types.js').Executor, dialect: import('../types.js').Dialect, table: string): Promise<boolean>;
/**
 * MySQL and MariaDB.
 * @param {import('../types.js').Executor} executor
 * @param {string} table
 * @param {string} index
 * @returns {Promise<boolean>}
 */
export declare function indexExists(executor: import('../types.js').Executor, table: string, index: string): Promise<boolean>;
/**
 * @param {import('../types.js').Executor} executor
 * @param {import('../types.js').Dialect} dialect
 * @param {string} table
 * @returns {Promise<string[]>} Its columns. None: no such table.
 */
export declare function columnNames(executor: import('../types.js').Executor, dialect: import('../types.js').Dialect, table: string): Promise<string[]>;
/**
 * @param {import('../types.js').Executor} executor
 * @param {import('../types.js').Dialect} dialect
 * @param {string} p The table prefix.
 * @returns {Promise<Set<string>>} The ids in `<p>migrations`, as text: a table of the app under the prefix may have
 *     other ids. None: no such table, or no `id` column.
 */
export declare function recordedIds(executor: import('../types.js').Executor, dialect: import('../types.js').Dialect, p: string): Promise<Set<string>>;
