/**
 * Creates a sqlane instance. It connects, migrates and starts nothing.
 * @template C The connections that `enqueue` accepts, from the adapter.
 * @param {import('./types.js').SqlaneOptions<C>} options
 * @returns {import('./types.js').Sqlane<C>}
 */
export declare function createSqlane<C>(options: import('./types.js').SqlaneOptions<C>): import('./types.js').Sqlane<C>;
