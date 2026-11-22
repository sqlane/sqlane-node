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
 * @param {string} p The table prefix.
 * @param {ColumnRead[]} [columns] The columns of the prefix, from `readColumns`: no `<p>migrations` with an `id`
 *     column (none, or a table of the app) gives no id. Omitted: the table exists, created just before.
 * @returns {Promise<Set<string>>} The ids in `<p>migrations`, as strings.
 */
export declare function recordedIds(executor: import('../types.js').Executor, p: string, columns?: ColumnRead[]): Promise<Set<string>>;
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
 * The columns of the base tables of the prefix: also which tables exist.
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
