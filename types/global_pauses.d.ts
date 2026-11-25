/**
 * The spec of a row that a pause created from an id: no timing reads it (`timingOfSpec`), so `schedules.list()` gives
 * no next slot; the first fire of the schedule writes its own spec.
 */
export declare const PLACEHOLDER_SPEC = "unknown";
/**
 * @param {string} where
 * @param {unknown} error
 * @returns {unknown} A missing table or column (a migration not run, such as 0010_pause): a `ConfigError`. Another
 *     error: as it is.
 */
export declare function schemaErrorOf(where: string, error: unknown): unknown;
/**
 * A schedule given to a pause, a resume or a remove: a definition, or an id.
 * @param {unknown} schedule
 * @param {string} where
 * @param {{ keyless?: boolean }} [options] `keyless`: an id without a key, as the schedules of 9.x had.
 * @returns {{ id: string, lane: string, spec: string }} The spec of the definition; of an id, the placeholder.
 */
export declare function scheduleOf(schedule: unknown, where: string, { keyless }?: {
    keyless?: boolean;
}): {
    id: string;
    lane: string;
    spec: string;
};
export type GlobalPausesParams = {
    store: import('./store/store.js').Store;
    adapter: import('./types.js').Adapter<any>;
    /**
     * The runner of this process.
     */
    attached: () => import('./sqlane_internals.js').AttachedRunner | null;
    hintChannel: import('./hint_channel.js').HintChannel;
    /**
     * Never rejects.
     */
    unblockKeys: (keys: string[]) => Promise<void>;
    reportError: (operation: string, error: unknown) => void;
    /**
     * The sqlane is closed: no unblock after it.
     */
    isClosed: () => boolean;
};
/**
 * @typedef {object} GlobalPausesParams
 * @property {import('./store/store.js').Store} store
 * @property {import('./types.js').Adapter<any>} adapter
 * @property {() => import('./sqlane_internals.js').AttachedRunner | null} attached The runner of this process.
 * @property {import('./hint_channel.js').HintChannel} hintChannel
 * @property {(keys: string[]) => Promise<void>} unblockKeys Never rejects.
 * @property {(operation: string, error: unknown) => void} reportError
 * @property {() => boolean} isClosed The sqlane is closed: no unblock after it.
 */
/**
 * @param {GlobalPausesParams} params
 * @returns {{
 *     lanes: Pick<import('./sqlane.js').SqlaneLanes, 'pauseGlobally' | 'resumeGlobally' | 'stats' | 'groupStats'>,
 *     schedules: Pick<import('./sqlane.js').SqlaneSchedules, 'pauseGlobally' | 'resumeGlobally' | 'remove'>,
 * }}
 */
export declare function createGlobalPauses({ store, adapter, attached, hintChannel, unblockKeys, reportError, isClosed }: GlobalPausesParams): {
    lanes: Pick<import('./sqlane.js').SqlaneLanes, 'pauseGlobally' | 'resumeGlobally' | 'stats' | 'groupStats'>;
    schedules: Pick<import('./sqlane.js').SqlaneSchedules, 'pauseGlobally' | 'resumeGlobally' | 'remove'>;
};
