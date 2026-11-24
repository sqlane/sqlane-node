// The re-probes after an enqueue (or a hint) of a handled lane: its commit is to come, so the dispatcher probes its
// lanes again a few times, until the job is visible. See docs/design.md › Wake-up after the commit.

/** The wakes after the last enqueue (or hint), until its commit makes the job visible */
const REPROBE_DELAYS_MS = [20, 50, 100, 200, 500, 1000, 2000];

/**
 * @typedef {object} Reprobes
 * @property {(lanes: readonly string[]) => void} follow An enqueue of the lanes: one series of re-probes, from the
 *     last enqueue, of the lanes enqueued within its steps. Only the steps shorter than the poll interval count.
 */

/**
 * @param {object} params
 * @param {number} params.pollIntervalMs
 * @param {() => import('./runner.js').RunnerState} params.state No re-probe unless started.
 * @param {(func: () => void, delayMs: number) => NodeJS.Timeout} params.setTimer An unref'd timer.
 * @param {(timer: NodeJS.Timeout) => void} params.clearTimer
 * @param {(lanes: string[]) => void} params.wake A speculative wake of the lanes: a probe first.
 * @returns {Reprobes}
 */
export function createReprobes({ pollIntervalMs, state, setTimer, clearTimer, wake }) {
    /** @type {Map<string, number>} The lanes of the enqueues of the current series of re-probes: their last enqueue */
    const reprobeLanes = new Map();
    /** The time of the last enqueue (or hint): the re-probes follow it */
    let reprobeFrom = 0;
    /** @type {{ timer: NodeJS.Timeout, at: number } | null} The next re-probe */
    let reprobe = null;

    /** Sets the timer of the next step of the series, if one is left before the poll. */
    function scheduleReprobe() {
        const now = Date.now();
        const delays = REPROBE_DELAYS_MS.filter(delay => delay < pollIntervalMs);
        const at = delays.map(delay => reprobeFrom + delay).find(time => time > now);
        const lastDelay = delays.at(-1) ?? 0;

        if (at === undefined || state() !== 'started') {
            reprobe = null;
            reprobeLanes.clear();

            return;
        }

        const timer = setTimer(() => {
            const stepAt = Date.now();

            for (const [lane, enqueuedAt] of reprobeLanes) {
                // Its last step is past: a series that goes on for later enqueues does not probe it again
                if (stepAt - enqueuedAt > lastDelay) {
                    reprobeLanes.delete(lane);
                }
            }

            wake([...reprobeLanes.keys()]);
            scheduleReprobe();
        }, at - now);

        reprobe = { at, timer };
    }

    return {
        follow: (lanes) => {
            // One series of re-probes, from the last enqueue: of the lanes enqueued within its steps
            reprobeFrom = Date.now();

            for (const lane of lanes) {
                reprobeLanes.set(lane, reprobeFrom);
            }

            // A re-probe that comes sooner stays: then the series goes on from this enqueue. A burst of enqueues gives
            // a re-probe at most each first step, not one per enqueue.
            if (reprobe && reprobe.at <= reprobeFrom + REPROBE_DELAYS_MS[0]) {
                return;
            }

            if (reprobe) {
                clearTimer(reprobe.timer);
            }

            scheduleReprobe();
        },
    };
}
