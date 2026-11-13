/**
 * Defines a concurrency group: a cap on the handlers of several job names that run at once in one instance. Pass it to
 * `handle()` as `concurrencyGroup`. Each instance counts its own handlers in the group.
 * @param {import('./types.js').ConcurrencyGroupOptions} options
 * @returns {import('./types.js').ConcurrencyGroup} Frozen.
 */
export declare function defineConcurrencyGroup(options: import('./types.js').ConcurrencyGroupOptions): import('./types.js').ConcurrencyGroup;
/**
 * @param {unknown} value
 * @returns {value is import('./types.js').ConcurrencyGroup} A group as defineConcurrencyGroup() makes it: frozen, with
 *     a valid name and maxConcurrency, and nothing else. No registry of groups: sqlane keeps no global state.
 */
export declare function isConcurrencyGroup(value: unknown): value is import('./types.js').ConcurrencyGroup;
