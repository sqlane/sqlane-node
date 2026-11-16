export type GlobalRateLimit = import('./rate_keys.js').GlobalRateLimit;
/** @typedef {import('./rate_keys.js').GlobalRateLimit} GlobalRateLimit */
/** The most jobs that an unblock of a rate key makes pending at once */
export declare const RATE_UNBLOCK_BATCH = 500;
/** The least delay of the unblock after one that left no blocked job on its key (`nextUnblockMs`) */
export declare const RATE_RECHECK_MS = 1000;
/**
 * The microseconds that a start of the job adds to the tat of its key: cost × per / max, rounded up. Exact for every
 * valid limit: cost × ⌊per / max⌋ ≤ per, and cost × (per mod max) < max².
 * @param {GlobalRateLimit} limit
 * @returns {number}
 */
export declare function incrementUs({ max, per_us: perUs, cost }: GlobalRateLimit): number;
/**
 * The most debt that a key may have after a start of the job: its increment, and (burst − cost) × per / max rounded
 * down (the debt is whole µs). Without debt, a job always fits.
 * @param {GlobalRateLimit} limit
 * @returns {number}
 */
export declare function allowanceUs(limit: GlobalRateLimit): number;
/**
 * τ of the limit: (burst − 1) × per / max, rounded down. A key whose tat is `t + τ` lets a start of cost 1 at `t`, and
 * none before: a RateLimitedError pushes the tat there, from `t = now + retryAfter`.
 * @param {{ max: number, per_us: number, burst: number }} limit
 * @returns {number}
 */
export declare function toleranceUs({ max, per_us: perUs, burst }: {
    max: number;
    per_us: number;
    burst: number;
}): number;
/**
 * @param {number} debtUs The debt of the key.
 * @param {GlobalRateLimit} limit
 * @returns {number} The µs until the job may start: 0 or less, now.
 */
export declare function waitUs(debtUs: number, limit: GlobalRateLimit): number;
/**
 * @param {number} us
 * @returns {number} The milliseconds of a wait, rounded up: a timer never fires before the time.
 */
export declare function waitMsOf(us: number): number;
export type BlockedHead = {
    runAtMs: number;
    id: string;
};
export type RateKeyState = {
    debtUs: number;
    head: BlockedHead | null;
};
export type RateWait = {
    key: string;
    delayMs: number;
};
export type RateSplit<J extends {
    id: string;
    name: string;
    rateLimits: readonly GlobalRateLimit[];
}> = {
    /**
     * The jobs whose rate keys allow them, with the older jobs of the claim.
     */
    open: J[];
    /**
     * The others, each with the key that it waits on.
     */
    blocked: {
        id: string;
        name: string;
        key: string;
    }[];
    /**
     * The keys on which the split blocked the first job: the time until it may start.
     */
    waits: RateWait[];
};
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
export declare function splitByRate<J extends {
    id: string;
    name: string;
    rateLimits: readonly GlobalRateLimit[];
}>(rows: {
    job: J;
    runAtMs: number;
}[], states: Map<string, RateKeyState>): RateSplit<J>;
/**
 * The jobs blocked on a key, oldest first, that may start now: a prefix, as long as each fits after the ones before it.
 * The unblock does not take their quota, the claim does: the debt after them is for the next unblock of the key, until
 * the claims catch up with it (`floorUs` of the store).
 * @param {number} debtUs The debt of the key.
 * @param {GlobalRateLimit[]} queue The settings of the key in each blocked job, oldest first.
 * @param {number} most At most this many.
 * @returns {RateAdmission}
 */
export declare function admitQueue(debtUs: number, queue: GlobalRateLimit[], most: number): RateAdmission;
export type RateAdmission = {
    /**
     * The jobs of the prefix.
     */
    count: number;
    /**
     * The µs until the first job after the prefix may start, as if the prefix started
     * now: 0 when a full batch leaves jobs that fit. With none left, until a job like the last one may: a job blocked
     * during the unblock may be behind them (`nextUnblockMs`). Null: no blocked job at all.
     */
    waitUs: number | null;
    /**
     * The debt of the key after the prefix.
     */
    debtUs: number;
    /**
     * A blocked job is left after the prefix.
     */
    left: boolean;
};
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
export declare function nextUnblockMs(us: number, left: boolean): number;
/**
 * @param {readonly { rateLimits: readonly GlobalRateLimit[] }[]} jobs Jobs that start.
 * @returns {Map<string, number>} The µs that they add to the tat of each of their keys.
 */
export declare function incrementsOf(jobs: readonly {
    rateLimits: readonly GlobalRateLimit[];
}[]): Map<string, number>;
