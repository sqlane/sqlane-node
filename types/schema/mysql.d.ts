/**
 * @param {string} p The table prefix.
 * @returns {import('../migrations.js').Migration[]}
 */
export declare function mysqlMigrations(p: string): import('../migrations.js').Migration[];
/**
 * @param {string} p
 * @returns {string}
 */
export declare function mysqlMigrationsTable(p: string): string;
