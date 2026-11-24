/**
 * Creates a sqlane: the database side, for every process. It connects, migrates and starts nothing. A process that
 * runs jobs adds a runner over it: `createRunner()` of `@sqlane/core/runner`.
 * @template C The connections that `enqueue` accepts, from the adapter.
 * @param {import('./types.js').SqlaneOptions<C>} options
 * @returns {import('./types.js').Sqlane<C>}
 */
export declare function createSqlane<C>(options: import('./types.js').SqlaneOptions<C>): import('./types.js').Sqlane<C>;
