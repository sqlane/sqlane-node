// GCRA, the algorithm of the global rate limits. A key has a theoretical arrival time (tat) in the database. Its debt
// is `max(tat − now, 0)` in µs: a start of cost c adds `c × per / max`, rounded up to the µs, and a start is allowed
// while the debt before it is within `(burst − c) × per / max`, rounded down. That is the rule
// `max(tat, t) + c·T − T − τ ≤ t` with T = per / max and τ = (burst − 1)·T, in whole µs: without debt, a job always
// fits, and the increments rounded up delay a burst by µs, never by a start. The SQL of each dialect computes the same
// numbers.

/** @typedef {import('./rate_keys.js').GlobalRateLimit} GlobalRateLimit */

/** The most jobs that an unblock of a rate key makes pending at once */
export const RATE_UNBLOCK_BATCH = 500;
/** The least delay of the unblock after one that left no blocked job on its key (`nextUnblockMs`) */
export const RATE_RECHECK_MS = 1000;

/**
 * The microseconds that a start of the job adds to the tat of its key: cost × per / max, rounded up. Exact for every
 * valid limit: cost × ⌊per / max⌋ ≤ per, and cost × (per mod max) < max².
 * @param {GlobalRateLimit} limit
 * @returns {number}
 */
export function incrementUs({ max, per_us: perUs, cost }) {
    return (cost * Math.floor(perUs / max)) + Math.ceil(cost * (perUs % max) / max);
}

/**
 * The most debt that a key may have after a start of the job: its increment, and (burst − cost) × per / max rounded
 * down (the debt is whole µs). Without debt, a job always fits.
 * @param {GlobalRateLimit} limit
 * @returns {number}
 */
export function allowanceUs(limit) {
    const { max, per_us: perUs, burst, cost } = limit;
    const spare = burst - cost;

    return incrementUs(limit) + (spare * Math.floor(perUs / max)) + Math.floor(spare * (perUs % max) / max);
}

/**
 * τ of the limit: (burst − 1) × per / max, rounded down. A key whose tat is `t + τ` lets a start of cost 1 at `t`, and
 * none before: a RateLimitedError pushes the tat there, from `t = now + retryAfter`.
 * @param {{ max: number, per_us: number, burst: number }} limit
 * @returns {number}
 */
export function toleranceUs({ max, per_us: perUs, burst }) {
    return ((burst - 1) * Math.floor(perUs / max)) + Math.floor((burst - 1) * (perUs % max) / max);
}

/**
 * @param {number} debtUs The debt of the key.
 * @param {GlobalRateLimit} limit
 * @returns {number} The µs until the job may start: 0 or less, now.
 */
export function waitUs(debtUs, limit) {
    return debtUs + incrementUs(limit) - allowanceUs(limit);
}

/**
 * @param {number} us
 * @returns {number} The milliseconds of a wait, rounded up: a timer never fires before the time.
 */
export function waitMsOf(us) {
    return Math.max(Math.ceil(us / 1000), 0);
}

/**
 * The oldest job blocked on a rate key: the jobs after it wait behind it, FIFO.
 * @typedef {{ runAtMs: number, id: string }} BlockedHead
 */

/**
 * A rate key in a claim: its debt, read with its row locked, and its oldest blocked job.
 * @typedef {{ debtUs: number, head: BlockedHead | null }} RateKeyState
 */

/**
 * A rate key with blocked jobs, and the time until its oldest one may start.
 * @typedef {{ key: string, delayMs: number }} RateWait
 */

/**
 * @template {{ id: string, name: string, rateLimits: readonly GlobalRateLimit[] }} J
 * @typedef {object} RateSplit
 * @property {J[]} open The jobs whose rate keys allow them, with the older jobs of the claim.
 * @property {{ id: string, name: string, key: string }[]} blocked The others, each with the key that it waits on.
 * @property {RateWait[]} waits The keys on which the split blocked the first job: the time until it may start.
 */

/**
 * Splits locked jobs, oldest first, by their rate keys. A job waits on the first of its keys that has an older blocked
 * job, or an older job of this split that waits, or not enough quota after the older jobs of the split that fit: FIFO
 * per key. A job that fits takes its quota of each of its keys, in the simulation only.
 * @template {{ id: string, name: string, rateLimits: readonly GlobalRateLimit[] }} J
 * @param {{ job: J, runAtMs: number }[]} rows In the order of (run_at, id).
 * @param {Map<string, RateKeyState>} states Of their keys.
 * @returns {RateSplit<J>}
 */
export function splitByRate(rows, states) {
    /** @type {Map<string, number>} */
    const debts = new Map([...states].map(([key, state]) => [key, state.debtUs]));
    /** @type {Set<string>} The keys on which a job of the split waits */
    const waiting = new Set();
    /** @type {RateSplit<J>} */
    const split = { open: [], blocked: [], waits: [] };

    for (const { job, runAtMs } of rows) {
        let key = null;

        for (const limit of job.rateLimits) {
            const head = states.get(limit.key)?.head;

            if (waiting.has(limit.key)
                || (head && (head.runAtMs < runAtMs || (head.runAtMs === runAtMs && head.id < job.id)))) {
                key = limit.key;
                break;
            }

            const wait = waitUs(debts.get(limit.key) ?? 0, limit);

            if (wait > 0) {
                key = limit.key;
                // The first job that waits on a key without blocked jobs: its time, for the timer
                split.waits.push({ key, delayMs: waitMsOf(wait) });
                break;
            }
        }

        if (key === null) {
            for (const limit of job.rateLimits) {
                debts.set(limit.key, (debts.get(limit.key) ?? 0) + incrementUs(limit));
            }

            split.open.push(job);
        } else {
            waiting.add(key);
            split.blocked.push({ id: job.id, name: job.name, key });
        }
    }

    return split;
}

/**
 * The jobs blocked on a key, oldest first, that may start now: a prefix, as long as each fits after the ones before it.
 * The unblock does not take their quota, the claim does: the debt after them is for the next unblock of the key, until
 * the claims catch up with it (`floorUs` of the store).
 * @param {number} debtUs The debt of the key.
 * @param {GlobalRateLimit[]} queue The settings of the key in each blocked job, oldest first.
 * @param {number} most At most this many.
 * @returns {RateAdmission}
 */
export function admitQueue(debtUs, queue, most) {
    let debt = debtUs;

    for (const [count, limit] of queue.entries()) {
        const wait = waitUs(debt, limit);

        if (count >= most || wait > 0) {
            return { count, waitUs: Math.max(wait, 0), debtUs: debt, left: true };
        }

        debt += incrementUs(limit);
    }

    const last = queue.at(-1);

    return { count: queue.length, waitUs: last ? Math.max(waitUs(debt, last), 0) : null, debtUs: debt, left: false };
}

/**
 * The prefix of the blocked jobs of a key that an unblock makes pending, and what comes after it.
 * @typedef {object} RateAdmission
 * @property {number} count The jobs of the prefix.
 * @property {number | null} waitUs The µs until the first job after the prefix may start, as if the prefix started
 *     now: 0 when a full batch leaves jobs that fit. With none left, until a job like the last one may: a job blocked
 *     during the unblock may be behind them (`nextUnblockMs`). Null: no blocked job at all.
 * @property {number} debtUs The debt of the key after the prefix.
 * @property {boolean} left A blocked job is left after the prefix.
 */

/**
 * The delay of the next unblock of a key. With no blocked job left, one more unblock, in a second at the earliest: a
 * claim that blocked a job behind the ones that this unblock made pending, while it ran, saw them as blocked and armed
 * no timer, and the unblock did not see that job (not committed yet).
 * @param {number} us The wait of `RateAdmission`.
 * @param {boolean} left
 * @returns {number}
 */
export function nextUnblockMs(us, left) {
    return left ? waitMsOf(us) : Math.max(waitMsOf(us), RATE_RECHECK_MS);
}

/**
 * @param {readonly { rateLimits: readonly GlobalRateLimit[] }[]} jobs Jobs that start.
 * @returns {Map<string, number>} The µs that they add to the tat of each of their keys.
 */
export function incrementsOf(jobs) {
    /** @type {Map<string, number>} */
    const increments = new Map();

    for (const job of jobs) {
        for (const limit of job.rateLimits) {
            increments.set(limit.key, (increments.get(limit.key) ?? 0) + incrementUs(limit));
        }
    }

    return increments;
}
