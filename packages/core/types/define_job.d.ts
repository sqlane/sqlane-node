/**
 * Defines a job name and its options. Producers and workers import the definition.
 * @param {import('./types.js').JobOptions} options
 * @returns {import('./types.js').JobDefinition} Frozen.
 */
export declare function defineJob(options: import('./types.js').JobOptions): import('./types.js').JobDefinition;
