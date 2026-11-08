/**
 * @param {string} p The table prefix.
 * @returns {import('../types.js').Migration[]}
 */
export declare function postgresMigrations(p: string): import('../types.js').Migration[];
/**
 * @param {string} p
 * @returns {string}
 */
export declare function postgresMigrationsTable(p: string): string;
