// The wakes of the rate keys with blocked jobs: one time per key, in a min-heap, and one timer for the earliest. The
// keys due within `batchMs` of it go together, in one unblock.

/** Node's timers overflow above this: they would fire at once */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * @typedef {object} RateWakes
 * @property {(key: string, delayMs: number) => void} arm The key is due after the delay. A key that is due sooner keeps
 *     its time: its unblock gives the next one.
 * @property {(at: number) => boolean} dueBefore A key is due before this time.
 * @property {() => void} clear Forgets the keys, and stops the timer.
 */

/**
 * @param {object} params
 * @param {(func: () => void, delayMs: number) => NodeJS.Timeout} params.setTimer An unref'd timer.
 * @param {(timer: NodeJS.Timeout) => void} params.clearTimer
 * @param {(keys: string[]) => void} params.onDue The due keys: the timer forgot them.
 * @param {number} [params.batchMs] The keys due within this time of the timer go with it.
 * @param {() => number} [params.now]
 * @returns {RateWakes}
 */
export function createRateWakes({ setTimer, clearTimer, onDue, batchMs = 10, now = Date.now }) {
    /** @type {Map<string, number>} The time of each key */
    const atByKey = new Map();
    /** @type {{ at: number, key: string }[]} A min-heap by time. An entry whose time is not its key's is stale */
    const heap = [];
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    let timerAt = Infinity;

    /**
     * @param {number} a
     * @param {number} b
     */
    function swap(a, b) {
        [heap[a], heap[b]] = [heap[b], heap[a]];
    }

    /** @param {{ at: number, key: string }} entry */
    function push(entry) {
        heap.push(entry);

        for (let at = heap.length - 1; at > 0;) {
            const parent = (at - 1) >> 1;

            if (heap[parent].at <= heap[at].at) {
                break;
            }

            swap(at, parent);
            at = parent;
        }
    }

    function pop() {
        const last = /** @type {{ at: number, key: string }} */ (heap.pop());

        if (!heap.length) {
            return;
        }

        heap[0] = last;

        for (let at = 0; ;) {
            const left = (2 * at) + 1;
            const right = left + 1;
            let least = at;

            if (left < heap.length && heap[left].at < heap[least].at) {
                least = left;
            }

            if (right < heap.length && heap[right].at < heap[least].at) {
                least = right;
            }

            if (least === at) {
                break;
            }

            swap(at, least);
            at = least;
        }
    }

    /** @returns {{ at: number, key: string } | null} The earliest key, without the stale entries. */
    function top() {
        while (heap.length && atByKey.get(heap[0].key) !== heap[0].at) {
            pop();
        }

        return heap[0] ?? null;
    }

    function setNextTimer() {
        const next = top();
        const at = next?.at ?? Infinity;

        if (at === timerAt) {
            return;
        }

        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }

        timerAt = at;

        if (next) {
            timer = setTimer(fire, Math.min(Math.max(at - now(), 0), MAX_TIMER_MS));
        }
    }

    function fire() {
        timer = null;
        timerAt = Infinity;

        const until = now() + batchMs;
        /** @type {string[]} */
        const keys = [];

        for (let next = top(); next && next.at <= until; next = top()) {
            pop();
            atByKey.delete(next.key);
            keys.push(next.key);
        }

        setNextTimer();

        if (keys.length) {
            onDue(keys);
        }
    }

    return {
        arm: (key, delayMs) => {
            const at = now() + Math.max(delayMs, 0);
            const known = atByKey.get(key);

            if (known !== undefined && known <= at) {
                return;
            }

            atByKey.set(key, at);
            push({ at, key });
            setNextTimer();
        },
        dueBefore: at => (top()?.at ?? Infinity) < at,
        clear: () => {
            atByKey.clear();
            heap.length = 0;

            if (timer !== null) {
                clearTimer(timer);
            }

            timer = null;
            timerAt = Infinity;
        },
    };
}
