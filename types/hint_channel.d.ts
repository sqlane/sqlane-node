/** The message of a wake of all names: every process probes all its names */
export declare const ANY_NAME = "*";
/** The prefix of the message after a release of a mutex key: `#<key>`. A job name cannot start with it. */
export declare const KEY_PREFIX = "#";
export type HintChannel = {
    /**
     * Fire-and-forget: never throws, never waits.
     */
    publish: (name: string) => void;
    listen: (onMessage: (name: string) => void) => Promise<void>;
    /**
     * Stops listening; drops the pending messages.
     */
    stop: () => Promise<void>;
};
/**
 * @typedef {object} HintChannel
 * @property {(name: string) => void} publish Fire-and-forget: never throws, never waits.
 * @property {(onMessage: (name: string) => void) => Promise<void>} listen
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
