/**
 * @param {string} p The table prefix.
 * @returns {import('../migrations.js').Migration[]}
 */
export declare function mariadbMigrations(p: string): import('../migrations.js').Migration[];
/**
 * @param {string} p
 * @returns {string}
 */
export declare function mariadbMigrationsTable(p: string): string;
