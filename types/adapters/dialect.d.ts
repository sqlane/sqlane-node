export type AdapterDialect<D extends import('../types.js').Dialect> = {
    dialect: D;
    allowUnsupportedDbVersion: boolean;
    allowUnsupportedDbConfiguration: boolean;
};
/**
 * Checks `dialect`, `allowUnsupportedDbVersion` and `allowUnsupportedDbConfiguration` of the options of an adapter.
 * @template {import('../types.js').Dialect} D
 * @param {unknown} options
 * @param {string} where The adapter, for the error.
 * @param {readonly D[]} allowed The dialects of the adapter.
 * @returns {AdapterDialect<D>}
 */
export declare function checkAdapterDialect<D extends import('../types.js').Dialect>(options: unknown, where: string, allowed: readonly D[]): AdapterDialect<D>;
/**
 * Checks the dialect against the database that the library tells.
 * @template {import('../types.js').Dialect} D
 * @param {D} dialect Checked.
 * @param {readonly import('../types.js').Dialect[]} possible The dialects of the library's database.
 * @param {string} where The adapter, for the error.
 * @param {string} library What tells the database, for the error: `the client of knex is "mariadb"`.
 * @returns {D}
 */
export declare function matchLibraryDialect<D extends import('../types.js').Dialect>(dialect: D, possible: readonly import('../types.js').Dialect[], where: string, library: string): D;
