/**
 * @template C
 * @param {object} params
 * @param {import('./enqueue.js').Enqueuer<C>} params.enqueuer
 * @param {import('./defaults.js').ResolvedDefaults} params.defaults
 * @param {number} params.maxPayloadBytes
 * @param {(connection: C | undefined, lane: string) => void} params.onCreated The wakes of a created job.
 * @returns {(schedule: import('./types.js').ScheduleDefinition, options?: import('./types.js').RunSlotOptions<C>)
 *     => Promise<import('./types.js').EnqueueResult>}
 */
export declare function createRunSlot<C>({ enqueuer, defaults, maxPayloadBytes, onCreated }: {
    enqueuer: import('./enqueue.js').Enqueuer<C>;
    defaults: import('./defaults.js').ResolvedDefaults;
    maxPayloadBytes: number;
    onCreated: (connection: C | undefined, lane: string) => void;
}): (schedule: import('./types.js').ScheduleDefinition, options?: import('./types.js').RunSlotOptions<C>) => Promise<import('./types.js').EnqueueResult>;
