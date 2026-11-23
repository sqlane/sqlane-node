/** The message of a wake of all lanes: every process probes all its lanes */
export declare const ANY_LANE = "*";
export type HintChannel = {
    /**
     * Fire-and-forget: never throws, never waits.
     */
    publish: (lane: string) => void;
    listen: (onMessage: (lane: string) => void) => Promise<void>;
    /**
     * Stops listening; drops the pending messages.
     */
    stop: () => Promise<void>;
};
/**
 * @typedef {object} HintChannel
 * @property {(lane: string) => void} publish Fire-and-forget: never throws, never waits.
 * @property {(onMessage: (lane: string) => void) => Promise<void>} listen
 * @property {() => Promise<void>} stop Stops listening; drops the pending messages.
 */
/**
 * @param {object} params
 * @param {import('./types.js').Hint | null} params.hint
 * @param {string} params.channel
 * @param {(operation: string, error: unknown) => void} params.reportError
 * @returns {HintChannel}
 */
export declare function createHintChannel({ hint, channel, reportError }: {
    hint: import('./types.js').Hint | null;
    channel: string;
    reportError: (operation: string, error: unknown) => void;
}): HintChannel;
