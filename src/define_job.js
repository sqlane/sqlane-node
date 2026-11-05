/**
 * Defines a job name and its options. Producers and workers import the definition.
 * @param {import('./types.js').JobOptions} options
 * @returns {import('./types.js').JobDefinition}
 */
export function defineJob(options) {
    // The validation of the options comes with the implementation.
    return Object.freeze({ ...options });
}
