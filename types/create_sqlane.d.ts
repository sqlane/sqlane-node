/**
 * Creates a sqlane instance. It connects, migrates and starts nothing.
 * @template C The connections that `enqueue` accepts, from the adapter.
 * @template {string} [L=never] The lane names, from `lanes`.
 * @param {import('./types.js').SqlaneOptions<C, L>} options
 * @returns {import('./types.js').Sqlane<C, L>}
 */
export declare function createSqlane<C, L extends string = never>(options: import('./types.js').SqlaneOptions<C, L>): import('./types.js').Sqlane<C, L>;
