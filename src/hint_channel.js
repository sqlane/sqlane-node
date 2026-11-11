// Hints between processes: "jobs of this name are ready". Only an optimization: a lost hint delays a job until the
// next poll, it never loses one.

/** At most one message per name in this window; the messages in it make one more at its end */
const THROTTLE_MS = 100;
/** The message of a wake of all names: every process probes all its names */
export const ANY_NAME = '*';
/** The prefix of the message after a release of a mutex key: `#<key>`. A job name cannot start with it. */
export const KEY_PREFIX = '#';

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
export function createHintChannel({ hint, channel, reportError }) {
    /** @type {Map<string, { timer: NodeJS.Timeout, again: boolean }>} */
    const windows = new Map();
    /** @type {(() => Promise<void>) | null} */
    let unsubscribe = null;
    let stopped = false;

    /** @param {string} name */
    function send(name) {
        if (!hint || stopped) {
            return;
        }

        const { publish } = hint;

        // Not awaited: the enqueue does not wait for the hint
        (async () => {
            try {
                await publish(channel, name);
            } catch (error) {
                reportError('hint_publish', error);
            }
        })();
    }

    /** @param {string} name */
    function openWindow(name) {
        const timer = setTimeout(() => {
            const window = windows.get(name);

            windows.delete(name);

            if (window?.again) {
                send(name);
                openWindow(name);
            }
        }, THROTTLE_MS);

        timer.unref();
        windows.set(name, { timer, again: false });
    }

    return {
        publish: (name) => {
            const window = windows.get(name);

            if (window) {
                window.again = true;

                return;
            }

            send(name);
            openWindow(name);
        },
        listen: async (onMessage) => {
            if (!hint) {
                return;
            }

            unsubscribe = await hint.subscribe(channel, (message) => {
                try {
                    onMessage(message);
                } catch (error) {
                    reportError('hint_message', error);
                }
            });
        },
        stop: async () => {
            stopped = true;

            for (const { timer } of windows.values()) {
                clearTimeout(timer);
            }

            windows.clear();

            try {
                await unsubscribe?.();
            } catch (error) {
                reportError('hint_unsubscribe', error);
            }
        },
    };
}
