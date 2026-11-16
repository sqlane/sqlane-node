// What the contention scenarios of ab.mjs read from the handler runs of their workers (app.mjs records the job, the
// start and the end of each run in memory, and sends them once, after the window): the guard of the limits, and the
// share of the jobs that waited on a full key.
import { keysOfJob } from './trace.mjs';

/**
 * A run starts after its claim and ends before its completion, so it sees a key free a little earlier than the
 * database does: the guard of a rate key counts the starts in a window this much shorter than its period.
 */
export const RATE_SLACK_MS = 100;

/**
 * @typedef {object} Runs The handler runs of the workers, one per attempt, merged.
 * @property {number[]} index The job's index in the trace.
 * @property {number[]} start Epoch ms.
 * @property {number[]} end Epoch ms; 0: still running.
 * @property {number[]} enqueuedAt Epoch ms, from the handler context.
 */

/**
 * @typedef {object} KeyRuns
 * @property {'concurrency' | 'rate'} kind
 * @property {number} max
 * @property {number} perMs
 * @property {number} burst
 * @property {number[]} starts Sorted.
 * @property {number[]} ends Sorted; Infinity: still running.
 */

/**
 * @param {number[]} sorted
 * @param {number} value
 * @returns {number} The number of values ≤ value.
 */
function upperBound(sorted, value) {
    let low = 0;
    let high = sorted.length;

    while (low < high) {
        const middle = (low + high) >>> 1;

        if (sorted[middle] <= value) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}

/**
 * The runs of each key.
 * @param {import('./trace.mjs').Trace} trace
 * @param {Runs} runs
 * @returns {Map<string, KeyRuns>}
 */
export function runsByKey(trace, runs) {
    /** @type {Map<string, KeyRuns>} */
    const keys = new Map();

    for (let run = 0; run < runs.index.length; run++) {
        const { concurrency, rate } = keysOfJob(trace, trace.jobs[runs.index[run]]);
        const end = runs.end[run] || Infinity;

        for (const { key, max } of concurrency) {
            const entry = keys.get(key) ?? { kind: 'concurrency', max, perMs: 0, burst: 0, starts: [], ends: [] };

            entry.starts.push(runs.start[run]);
            entry.ends.push(end);
            keys.set(key, entry);
        }

        for (const { key, max, perMs, burst } of rate) {
            const entry = keys.get(`@${key}`) ?? { kind: 'rate', max, perMs, burst, starts: [], ends: [] };

            entry.starts.push(runs.start[run]);
            keys.set(`@${key}`, entry);
        }
    }

    for (const entry of keys.values()) {
        entry.starts.sort((a, b) => a - b);
        entry.ends.sort((a, b) => a - b);
    }

    return keys;
}

/**
 * The guard: on each concurrency key, at most its max of runs at once; on each rate key, at most `max + burst − 1`
 * starts in any window of its period (less RATE_SLACK_MS).
 * @param {Map<string, KeyRuns>} keys
 * @returns {{ keys: number, violations: string[], busiest: { concurrency: string | null, rate: string | null } }}
 *     The violations, and the key closest to its bound of each kind.
 */
export function guard(keys) {
    /** @type {string[]} */
    const violations = [];
    /** @type {Record<'concurrency' | 'rate', { ratio: number, text: string | null }>} */
    const busiest = { concurrency: { ratio: 0, text: null }, rate: { ratio: 0, text: null } };

    for (const [key, entry] of keys) {
        let peak = 0;
        let allowed = entry.max;

        if (entry.kind === 'concurrency') {
            // A sweep: at the same time, an end before a start
            let running = 0;

            for (let start = 0, end = 0; start < entry.starts.length;) {
                if (entry.ends[end] <= entry.starts[start]) {
                    running--;
                    end++;
                } else {
                    running++;
                    start++;
                    peak = Math.max(peak, running);
                }
            }
        } else {
            const windowMs = entry.perMs - RATE_SLACK_MS;

            allowed = entry.max + entry.burst - 1;

            for (let first = 0, last = 0; first < entry.starts.length; first++) {
                while (last < entry.starts.length && entry.starts[last] < entry.starts[first] + windowMs) {
                    last++;
                }

                peak = Math.max(peak, last - first);
            }
        }

        const text = entry.kind === 'concurrency'
            ? `${key}: ${peak} at once, max ${allowed}`
            : `${key}: ${peak} starts in ${entry.perMs - RATE_SLACK_MS} ms, at most ${allowed}`;

        if (peak > allowed) {
            violations.push(text);
        }

        if (peak / allowed > busiest[entry.kind].ratio) {
            busiest[entry.kind] = { ratio: peak / allowed, text };
        }
    }

    return {
        keys: keys.size,
        violations,
        busiest: { concurrency: busiest.concurrency.text, rate: busiest.rate.text },
    };
}

/**
 * The jobs whose first run started in [from, to], and how many of them waited on a full key: between their enqueue and
 * that start, one of their concurrency keys had its max of runs, or one of their rate keys had no quota (a start of
 * the key used it up). An estimate from the runs: sqlane does not say which jobs it blocked.
 * @param {import('./trace.mjs').Trace} trace
 * @param {Runs} runs
 * @param {Map<string, KeyRuns>} keys
 * @param {{ from: number, to: number }} window Epoch ms.
 * @returns {{ jobs: number, blocked: number }}
 */
export function blockedJobs(trace, runs, keys, { from, to }) {
    /** @type {Map<number, number>} The first run of each job */
    const firstRuns = new Map();

    for (let run = 0; run < runs.index.length; run++) {
        const first = firstRuns.get(runs.index[run]);

        if (first === undefined || runs.start[run] < runs.start[first]) {
            firstRuns.set(runs.index[run], run);
        }
    }

    /** @type {Map<KeyRuns, number[]>} The running count at each start of a concurrency key, or the TAT of a rate key */
    const after = new Map();

    for (const entry of keys.values()) {
        if (entry.kind === 'concurrency') {
            after.set(entry, entry.starts.map(start => (
                upperBound(entry.starts, start) - upperBound(entry.ends, start)
            )));
        } else {
            let tat = -Infinity;

            after.set(entry, entry.starts.map((start) => {
                tat = Math.max(tat, start) + (entry.perMs / entry.max);

                return tat;
            }));
        }
    }

    /**
     * @param {KeyRuns} entry
     * @param {number} enqueuedAt
     * @param {number} start
     * @returns {boolean} Whether the key was full between them.
     */
    const fullBetween = (entry, enqueuedAt, start) => {
        if (enqueuedAt >= start) {
            // No wait: the clocks of the database and of the worker differ by less than a millisecond or so
            return false;
        }

        const values = /** @type {number[]} */ (after.get(entry));
        const firstAfter = upperBound(entry.starts, enqueuedAt);

        if (entry.kind === 'concurrency') {
            if (upperBound(entry.starts, enqueuedAt) - upperBound(entry.ends, enqueuedAt) >= entry.max) {
                return true;
            }

            for (let index = firstAfter; index < entry.starts.length && entry.starts[index] < start; index++) {
                if (values[index] >= entry.max) {
                    return true;
                }
            }

            return false;
        }

        const allowanceMs = (entry.burst - 1) * entry.perMs / entry.max;

        if (firstAfter > 0 && values[firstAfter - 1] - enqueuedAt > allowanceMs) {
            return true;
        }

        for (let index = firstAfter; index < entry.starts.length && entry.starts[index] < start; index++) {
            if (values[index] - entry.starts[index] > allowanceMs) {
                return true;
            }
        }

        return false;
    };

    let jobs = 0;
    let blocked = 0;

    for (const [index, run] of firstRuns) {
        const start = runs.start[run];

        if (start < from || start > to) {
            continue;
        }

        jobs++;

        const { concurrency, rate } = keysOfJob(trace, trace.jobs[index]);
        const entries = [
            ...concurrency.map(({ key }) => keys.get(key)),
            ...rate.map(({ key }) => keys.get(`@${key}`)),
        ];

        if (entries.some(entry => entry && fullBetween(entry, runs.enqueuedAt[run], start))) {
            blocked++;
        }
    }

    return { jobs, blocked };
}
