/**
 * The schema of sqlane as versioned SQL, for the app's own migration tool.
 * @param {object} options
 * @param {'mysql' | 'postgres'} options.dialect
 * @param {string} [options.tablePrefix] Default: `'sqlane_'`.
 * @returns {import('./types.js').Migration[]}
 */
export function getMigrations(options) {
    throw new Error(`sqlane: getMigrations(${options.dialect}) is not implemented yet`);
}
