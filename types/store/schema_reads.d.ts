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
 * @returns {Promise<Set<string>>} The ids in `<p>migrations`, as strings. None: no such table, or no `id` column (a
 *     table of the app under the prefix).
 */
export declare function recordedIds(executor: import('../types.js').Executor, dialect: import('../types.js').Dialect, p: string): Promise<Set<string>>;
export type ColumnRead = {
    table: string;
    column: string;
    /**
     * As the catalog reports it, normalized: MySQL and MariaDB without the display widths of the
     * integers; PostgreSQL `format_type`.
     */
    type: string;
    notNull: boolean;
    collation: string | null;
};
/**
 * @typedef {object} ColumnRead
 * @property {string} table
 * @property {string} column
 * @property {string} type As the catalog reports it, normalized: MySQL and MariaDB without the display widths of the
 *     integers; PostgreSQL `format_type`.
 * @property {boolean} notNull
 * @property {string | null} collation
 */
/**
 * The columns of the tables of the prefix.
 * @param {import('../types.js').Executor} executor
 * @param {import('../types.js').Dialect} dialect
 * @param {string} p
 * @returns {Promise<ColumnRead[]>}
 */
export declare function readColumns(executor: import('../types.js').Executor, dialect: import('../types.js').Dialect, p: string): Promise<ColumnRead[]>;
/**
 * The indexes of the tables of the prefix, primary keys included.
 * @param {import('../types.js').Executor} executor
 * @param {import('../types.js').Dialect} dialect
 * @param {string} p
 * @returns {Promise<Map<string, string>>} By `<table>.<index>`: `unique ` if unique, the columns in order in
 *     parentheses, then ` where <predicate>` (PostgreSQL), and ` invalid` for a failed build (PostgreSQL).
 */
export declare function readIndexes(executor: import('../types.js').Executor, dialect: import('../types.js').Dialect, p: string): Promise<Map<string, string>>;
