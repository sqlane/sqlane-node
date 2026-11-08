export type NewJob = {
    /**
     * `<name>:<jobId>`, or a ULID.
     */
    id: string;
    hasJobId: boolean;
    name: string;
    payloadJson: string;
    /**
     * Sorted, without duplicates.
     */
    mutexKeys: readonly string[];
    maxAttempts: number;
    maxStalls: number;
    completedRetentionMs: number;
    failedRetentionMs: number;
    failureJob: string | null;
    /**
     * From the DB clock at insert. 0 with `runAt`.
     */
    delayMs: number;
    runAt: Date | null;
};
export type NewJobParams = {
    name: string;
    /**
     * Null: an unknown name, the defaults only.
     */
    definition: import('./types.js').JobDefinition | null;
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
export declare function buildNewJob({ name, definition, defaults, payload, options, maxPayloadBytes }: NewJobParams): NewJob;
