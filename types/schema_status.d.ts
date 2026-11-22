/**
 * What `schema.migrate()` would do, by the records of `<p>migrations`.
 * @template C
 * @param {import('./types.js').Adapter<C>} adapter
 * @param {string} p
 * @param {string} installed The installed version.
 * @returns {Promise<import('./types.js').MigrationStatus>}
 */
export declare function getMigrationStatus<C>(adapter: import('./types.js').Adapter<C>, p: string, installed: string): Promise<import('./types.js').MigrationStatus>;
/**
 * Whether the queries of this version find what they need, by the catalog: the tables, columns and indexes that its
 * migrations create, by name. Anything extra is ignored.
 * @template C
 * @param {import('./types.js').Adapter<C>} adapter
 * @param {string} p
 * @param {string} installed The installed version.
 * @returns {Promise<import('./types.js').SchemaProblems>}
 */
export declare function findSchemaProblems<C>(adapter: import('./types.js').Adapter<C>, p: string, installed: string): Promise<import('./types.js').SchemaProblems>;
