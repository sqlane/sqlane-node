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
 * @param {string} p The table prefix.
 * @returns {Promise<Set<string>>} The ids in `<p>migrations`. None: no such table.
 */
export async function recordedIds(executor, dialect, p) {
    if (!await tableExists(executor, dialect, `${p}migrations`)) {
        return new Set();
    }

    const rows = await executor.query(`SELECT id FROM ${p}migrations`, []);

    return new Set(rows.map(row => String(row.id)));
}
