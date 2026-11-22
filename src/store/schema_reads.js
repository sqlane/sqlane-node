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
 * @returns {Promise<Set<string>>} The ids in `<p>migrations`, as strings. None: no such table, or no `id` column (a
 *     table of the app under the prefix).
 */
export async function recordedIds(executor, dialect, p) {
    if (!(await columnNames(executor, dialect, `${p}migrations`)).includes('id')) {
        return new Set();
    }

    const rows = await executor.query(`SELECT id FROM ${p}migrations`, []);

    return new Set(rows.map(row => String(row.id)));
}

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
export async function readColumns(executor, dialect, p) {
    if (dialect === 'postgres') {
        const rows = await executor.query(`SELECT c.relname AS table_name, a.attname AS column_name,
                format_type(a.atttypid, a.atttypmod) AS column_type, a.attnotnull AS not_null,
                co.collname AS collation_name
              FROM pg_class c
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
              LEFT JOIN pg_collation co ON co.oid = a.attcollation
             WHERE c.relkind = 'r' AND starts_with(c.relname, $1) AND pg_table_is_visible(c.oid)`, [p]);

        return rows.map(row => ({
            table: String(row.table_name),
            column: String(row.column_name),
            type: String(row.column_type),
            notNull: row.not_null === true,
            collation: row.collation_name === null ? null : String(row.collation_name),
        }));
    }

    const rows = await executor.query(`SELECT table_name AS table_name, column_name AS column_name,
            column_type AS column_type, is_nullable AS is_nullable, collation_name AS collation_name
          FROM information_schema.columns
         WHERE table_schema = DATABASE() AND LEFT(table_name, CHAR_LENGTH(?)) = ?`, [p, p]);

    return rows.map(row => ({
        table: String(row.table_name),
        column: String(row.column_name),
        // MariaDB: `int(11)`, `bigint(20)`; MySQL 8.4 has no display widths
        type: String(row.column_type).toLowerCase().replace(/^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/u, '$1'),
        notNull: row.is_nullable === 'NO',
        collation: row.collation_name === null ? null : String(row.collation_name),
    }));
}

/**
 * The indexes of the tables of the prefix, primary keys included.
 * @param {import('../types.js').Executor} executor
 * @param {import('../types.js').Dialect} dialect
 * @param {string} p
 * @returns {Promise<Map<string, string>>} By `<table>.<index>`: `unique ` if unique, the columns in order in
 *     parentheses, then ` where <predicate>` (PostgreSQL), and ` invalid` for a failed build (PostgreSQL).
 */
export async function readIndexes(executor, dialect, p) {
    /** @type {Map<string, string>} */
    const indexes = new Map();

    if (dialect === 'postgres') {
        const rows = await executor.query(`SELECT t.relname AS table_name, i.relname AS index_name,
                x.indisunique AS is_unique, x.indisvalid AND x.indisready AS is_valid,
                pg_get_expr(x.indpred, x.indrelid) AS predicate,
                (SELECT string_agg(a.attname::text, ', ' ORDER BY k.n)
                   FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, n)
                   JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) AS column_names
              FROM pg_index x
              JOIN pg_class t ON t.oid = x.indrelid
              JOIN pg_class i ON i.oid = x.indexrelid
             WHERE starts_with(t.relname, $1) AND pg_table_is_visible(t.oid)`, [p]);

        for (const row of rows) {
            const unique = row.is_unique === true ? 'unique ' : '';
            const where = row.predicate === null ? '' : ` where ${row.predicate}`;
            const invalid = row.is_valid === true ? '' : ' invalid';

            indexes.set(`${row.table_name}.${row.index_name}`, `${unique}(${row.column_names})${where}${invalid}`);
        }

        return indexes;
    }

    const rows = await executor.query(`SELECT table_name AS table_name, index_name AS index_name,
            column_name AS column_name, non_unique AS non_unique
          FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND LEFT(table_name, CHAR_LENGTH(?)) = ?
         ORDER BY table_name, index_name, seq_in_index`, [p, p]);
    /** @type {Map<string, { unique: boolean, columns: string[] }>} */
    const byName = new Map();

    for (const row of rows) {
        const key = `${row.table_name}.${row.index_name}`;
        const index = byName.get(key) ?? { unique: Number(row.non_unique) === 0, columns: [] };

        index.columns.push(String(row.column_name));
        byName.set(key, index);
    }

    for (const [key, { unique, columns }] of byName) {
        indexes.set(key, `${unique ? 'unique ' : ''}(${columns.join(', ')})`);
    }

    return indexes;
}
