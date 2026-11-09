/**
 * Defines a job name and its options. Producers and workers import the definition. `defineJob<{ reportId: string }>(…)`
 * declares the payload: `enqueue`, `handle` and `mutexKeys` then check it.
 * @template [P=any]
 * @param {import('./types.js').JobOptions<P>} options
 * @returns {import('./types.js').JobDefinition<P>} Frozen.
 */
export declare function defineJob<P = any>(options: import('./types.js').JobOptions<P>): import('./types.js').JobDefinition<P>;
