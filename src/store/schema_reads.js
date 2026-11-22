// The reads of the catalog for the schema: in the current schema only (MySQL and MariaDB `DATABASE()`, PostgreSQL its
// `search_path`). A table is looked up before it is read: a failing SELECT would abort a PostgreSQL transaction. Each
// read selects a boolean or `1 AS found`: a column that every client reads (Prisma).

/**
 * @param {import('../types.js').Executor} executor
 * @param {import('../types.js').Dialect} dialect
 * @param {string} table
 * @returns {Promise<boolean>}
 */
export async function tableExists(executor, dialect, table) {
    if (dialect === 'postgres') {
        const [{ found }] = await executor.query('SELECT to_regclass($1) IS NOT NULL AS found', [table]);

        return found === true;
    }

    const rows = await executor.query(
        'SELECT 1 AS found FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
        [table],
    );

    return rows.length > 0;
}

/**
 * MySQL and MariaDB.
 * @param {import('../types.js').Executor} executor
 * @param {string} table
 * @param {string} index
 * @returns {Promise<boolean>}
 */
export async function indexExists(executor, table, index) {
    const rows = await executor.query(`SELECT 1 AS found FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`, [table, index]);

    return rows.length > 0;
}

/**
 * @param {import('../types.js').Executor} executor
 * @param {import('../types.js').Dialect} dialect
 * @param {string} table
 * @returns {Promise<string[]>} Its columns. None: no such table.
 */
export async function columnNames(executor, dialect, table) {
    const rows = dialect === 'postgres'
        ? await executor.query(`SELECT attname AS name FROM pg_attribute
            WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`, [table])
        : await executor.query(`SELECT column_name AS name FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ?`, [table]);

    return rows.map(row => String(row.name));
}

/**
 * @param {import('../types.js').Executor} executor
 * @param {import('../types.js').Dialect} dialect
 * @param {string} p The table prefix.
 * @returns {Promise<Set<string>>} The ids in `<p>migrations`, as text: a table of the app under the prefix may have
 *     other ids. None: no such table, or no `id` column.
 */
export async function recordedIds(executor, dialect, p) {
    if (!(await columnNames(executor, dialect, `${p}migrations`)).includes('id')) {
        return new Set();
    }

    const id = dialect === 'postgres' ? 'id::text' : 'CAST(id AS CHAR)';
    const rows = await executor.query(`SELECT ${id} AS id FROM ${p}migrations`, []);

    return new Set(rows.map(row => String(row.id)));
}
