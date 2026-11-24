// Hints between processes: "jobs of this lane are ready". Only an optimization: a lost hint delays a job until the
// next poll, it never loses one.

/** At most one message per lane in this window; the messages in it make one more at its end */
const THROTTLE_MS = 100;
/** The message of a wake of all lanes: every process probes all its lanes */
export const ANY_LANE = '*';

/**
 * @typedef {object} HintChannel
 * @property {(lane: string) => void} publish Fire-and-forget: never throws, never waits.
 * @property {(onMessage: (lane: string) => void) => Promise<void>} listen
 * @property {() => Promise<void>} unlisten Stops listening; the publishes go on.
 * @property {() => Promise<void>} stop Stops listening and publishing; drops the pending messages.
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
    /** Each unlisten() ends the subscriptions before it: also one whose subscribe() is pending */
    let unlistens = 0;

    /**
     * @param {(() => Promise<void>) | null} end
     */
    async function endSubscription(end) {
        try {
            await end?.();
        } catch (error) {
            reportError('hint_unsubscribe', error);
        }
    }

    async function unlisten() {
        const current = unsubscribe;

        unsubscribe = null;
        unlistens++;
        await endSubscription(current);
    }

    /** @param {string} lane */
    function send(lane) {
        if (!hint || stopped) {
            return;
        }

        const { publish } = hint;

        // Not awaited: the enqueue does not wait for the hint
        (async () => {
            try {
                await publish(channel, lane);
            } catch (error) {
                reportError('hint_publish', error);
            }
        })();
    }

    /** @param {string} lane */
    function openWindow(lane) {
        const timer = setTimeout(() => {
            const window = windows.get(lane);

            windows.delete(lane);

            if (window?.again) {
                send(lane);
                openWindow(lane);
            }
        }, THROTTLE_MS);

        timer.unref();
        windows.set(lane, { timer, again: false });
    }

    return {
        publish: (lane) => {
            const window = windows.get(lane);

            if (window) {
                window.again = true;

                return;
            }

            send(lane);
            openWindow(lane);
        },
        listen: async (onMessage) => {
            if (!hint) {
                return;
            }

            const seen = unlistens;
            const end = await hint.subscribe(channel, (message) => {
                try {
                    onMessage(message);
                } catch (error) {
                    reportError('hint_message', error);
                }
            });

            // unlisten() or stop() ran during the subscribe: it ends now
            if (unlistens !== seen) {
                await endSubscription(end);

                return;
            }

            unsubscribe = end;
        },
        unlisten,
        stop: async () => {
            stopped = true;

            for (const { timer } of windows.values()) {
                clearTimeout(timer);
            }

            windows.clear();
            await unlisten();
        },
    };
}
