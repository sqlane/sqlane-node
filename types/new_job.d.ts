export type NewJob = {
    /**
     * `<lane>:<dedupeKey>`, or a ULID.
     */
    id: string;
    hasJobId: boolean;
    lane: string;
    payloadJson: string;
    /**
     * Its global limits: sorted by key, without
     * duplicates.
     */
    limits: readonly import('./concurrency_keys.js').GlobalLimit[];
    /**
     * Its global rate limits: sorted by key,
     * without duplicates. At most 10 keys with `limits`.
     */
    rateLimits: readonly import('./rate_keys.js').GlobalRateLimit[];
    maxAttempts: number;
    maxStalls: number;
    completedRetentionMs: number;
    failedRetentionMs: number;
    /**
     * From the DB clock at insert. 0 with `runAt`.
     */
    delayMs: number;
    runAt: Date | null;
};
export type NewJobParams = {
    lane: string;
    /**
     * Null: an unknown name, the defaults only.
     */
    definition: import('./types.js').LaneDefinition | null;
    defaults: import('./defaults.js').ResolvedDefaults;
    payload: unknown;
    options: import('./types.js').EnqueueOptions | undefined;
    maxPayloadBytes: number;
};
/**
 * Checks an enqueue and computes the job to insert: options, then the definition, then the defaults.
 * @param {NewJobParams} params
 * @returns {NewJob}
 */
export declare function buildNewJob({ lane, definition, defaults, payload, options, maxPayloadBytes }: NewJobParams): NewJob;
