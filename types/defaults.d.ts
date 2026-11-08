export type ResolvedDefaults = {
    maxAttempts: number;
    maxStalls: number;
    backoff: import('./types.js').Backoff;
    retention: {
        completedMs: number;
        failedMs: number;
    };
    /**
     * Null: no timeout.
     */
    timeoutMs: number | null;
};
/**
 * @param {import('./types.js').JobDefaults} [defaults]
 * @returns {ResolvedDefaults}
 */
export declare function resolveDefaults(defaults?: import('./types.js').JobDefaults): ResolvedDefaults;
