/**
 * @param {string} p The table prefix.
 * @returns {import('../migrations.js').Migration[]}
 */
export declare function postgresMigrations(p: string): import('../migrations.js').Migration[];
/**
 * @param {string} p
 * @returns {string}
 */
export declare function postgresMigrationsTable(p: string): string;
