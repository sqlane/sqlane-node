// The workload of the contention scenarios of ab.mjs: a trace of jobs, generated ahead from a seed, that the producer
// of app.mjs replays and its workers run. The same seed and length give the same trace in every process and on every
// ref, so both refs and both variants (with the limits of the profile, or without any) run the same jobs.
//
// - Arrivals: Poisson, 100/s, and 300/s in a burst of 2 s every 10 s (from 8 s to 10 s of each 10 s): 140/s on average.
// - Names: 1000, Zipf with s = 1 (the first name gets 13% of the jobs).
// - Durations: log-normal around the median of the name (20 ms; 300 ms for the slow names, which get 5% of the jobs),
//   σ = 1, at most 2 s: 56 ms on average.
// - Outcomes: 1% of the jobs throw once, and run again after a fixed backoff of 200 ms; 0.2% of the jobs throw a
//   RateLimitedError (retryAfter 1 s) once: jobs of the names with a rate limit only.
// - Payload: tenantId (1000 tenants, Zipf), userId (10 users per tenant, Zipf within it: 10,000), integration (20: a
//   Zipf rank rotated by the tenant). The keyed limits take their keys from them, so the hot keys go together.
//
// Profiles: the limits of the names. `realistic`: 70% of the names have no limit, 15% one, 10% two or three, 5% four or
// five, from a catalog of 8 concurrency limits (per tenant, per user, per integration, and shared); 10% of the names
// with a limit also have a rate limit (per tenant 10/s, or shared 50/s). `stress`: every name has 2 to 5 of 5
// concurrency limits of max 1 to 5, each with a key out of 20 per job (`keys` of the payload), no rate limit.
//
// The generator checks that the trace has a steady state: on each key, the work (the jobs' durations, retries
// included, per second) stays under 80% of its max, and the starts per second under 80% of its rate. Otherwise it
// throws, and names the key. The jobs wait on the keys in the bursts, and the queue drains between them.

/** The seed of the scenarios: the same jobs in both profiles, only the limits differ */
export const TRACE_SEED = 1;
export const PROFILES = /** @type {const} */ (['realistic', 'stress']);
/** The fixed backoff of a job that throws once */
export const RETRY_DELAY_MS = 200;
/** The retryAfter of a RateLimitedError */
export const RETRY_AFTER_MS = 1000;
export const OUTCOME = /** @type {const} */ ({ ok: 0, failsOnce: 1, rateLimited: 2 });

const NAMES = 1000;
const TENANTS = 1000;
const USERS_PER_TENANT = 10;
const INTEGRATIONS = 20;
const BASE_RATE = 100;
const BURST_RATE = 300;
const PERIOD_MS = 10_000;
/** The burst: the end of each period */
const BURST_FROM_MS = 8000;
const FAST_MEDIAN_MS = 20;
const SLOW_MEDIAN_MS = 300;
/** The share of the jobs of the slow names */
const SLOW_SHARE = 0.05;
/** The slow names are not among the first ones: one of them alone would take more than the share */
const FIRST_SLOW_RANK = 11;
const SIGMA = 1;
const MAX_DURATION_MS = 2000;
const FAILS_ONCE = 0.01;
const RATE_LIMITED = 0.002;
const STRESS_KEYS = 20;
const MAX_UTILIZATION = 0.8;

/**
 * @typedef {object} Limit
 * @property {string} name
 * @property {number} max
 * @property {'tenantId' | 'userId' | 'integration' | null} by The field of the payload of its key; null: no key.
 * @property {number} [slot] The stress limits: the index of its key in `keys` of the payload.
 */

/**
 * @typedef {Limit & { perMs: number, burst: number }} RateLimit
 */

/** @type {Limit[]} */
const REALISTIC_CONCURRENCY = [
    { name: 'tenant', max: 3, by: 'tenantId' },
    { name: 'tenant_export', max: 1, by: 'tenantId' },
    { name: 'user', max: 1, by: 'userId' },
    { name: 'user_sync', max: 2, by: 'userId' },
    { name: 'integration', max: 5, by: 'integration' },
    { name: 'email', max: 10, by: null },
    { name: 'pdf', max: 5, by: null },
    { name: 'warehouse', max: 50, by: null },
];
/** @type {RateLimit[]} */
const REALISTIC_RATE = [
    { name: 'tenant_api', max: 10, perMs: 1000, burst: 1, by: 'tenantId' },
    { name: 'email_api', max: 50, perMs: 1000, burst: 1, by: null },
];
/** @type {Limit[]} */
const STRESS_CONCURRENCY = [1, 2, 3, 4, 5].map((max, slot) => ({ name: `stress_${max}`, max, by: null, slot }));

/**
 * @typedef {object} TraceName
 * @property {string} name
 * @property {number} medianMs
 * @property {number[]} concurrency The indexes of its concurrency limits.
 * @property {number[]} rate The indexes of its rate limits.
 */

/**
 * @typedef {object} Payload
 * @property {number} i The index of the job in the trace.
 * @property {number} tenantId
 * @property {number} userId
 * @property {number} integration
 * @property {number[]} [keys] The stress profile: the key of each stress limit.
 */

/**
 * @typedef {object} TraceJob
 * @property {number} at Its enqueue, in ms from the start of the replay.
 * @property {number} name The index of its name.
 * @property {number} durationMs
 * @property {0 | 1 | 2} outcome
 * @property {Payload} payload
 */

/**
 * @typedef {object} Trace
 * @property {'realistic' | 'stress'} profile
 * @property {number} seed
 * @property {number} seconds
 * @property {{ concurrency: Limit[], rate: RateLimit[] }} limits
 * @property {TraceName[]} names
 * @property {TraceJob[]} jobs
 * @property {{ concurrency: { key: string, utilization: number }, rate: { key: string, utilization: number } | null }}
 *     check The busiest key of each kind: its work per second / its max, its starts per second / its rate.
 */

/**
 * splitmix32: a small seeded generator of floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function splitmix32(seed) {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x9E_37_79_B9) >>> 0;

        let value = state ^ (state >>> 16);

        value = Math.imul(value, 0x21_F0_AA_AD);
        value ^= value >>> 15;
        value = Math.imul(value, 0x73_5A_2D_97);
        value ^= value >>> 15;

        return (value >>> 0) / 4_294_967_296;
    };
}

/**
 * The generator of one aspect of the trace: one per aspect, so that the names do not shift the durations, and the
 * profile does not shift anything but the limits.
 * @param {number} seed
 * @param {number} stream
 * @returns {() => number}
 */
function streamOf(seed, stream) {
    return splitmix32(Math.imul(seed, 0x2C_1B_3C_6D) ^ Math.imul(stream + 1, 0x29_7A_2D_39));
}

/**
 * The cumulative distribution of a Zipf law with s = 1 over n ranks.
 * @param {number} n
 * @returns {Float64Array}
 */
function zipf(n) {
    const cdf = new Float64Array(n);
    let total = 0;

    for (let rank = 1; rank <= n; rank++) {
        total += 1 / rank;
        cdf[rank - 1] = total;
    }

    return cdf.map(value => value / total);
}

/**
 * @param {Float64Array} cdf
 * @param {number} u In [0, 1).
 * @returns {number} The index of the rank of u.
 */
function sample(cdf, u) {
    let low = 0;
    let high = cdf.length - 1;

    while (low < high) {
        const middle = (low + high) >>> 1;

        if (cdf[middle] > u) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }

    return low;
}

/**
 * @param {() => number} random
 * @returns {number} A standard normal value (Box–Muller; two draws).
 */
function normal(random) {
    const u = 1 - random();
    const v = random();

    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * The first `count` indexes of a random order of the indexes below `n` (Fisher–Yates).
 * @param {() => number} random
 * @param {number} n
 * @param {number} count
 * @returns {number[]}
 */
function shuffled(random, n, count) {
    const indexes = Array.from({ length: n }, (_, index) => index);

    for (let index = 0; index < count; index++) {
        const other = index + Math.floor(random() * (n - index));

        [indexes[index], indexes[other]] = [indexes[other], indexes[index]];
    }

    return indexes.slice(0, count);
}

/**
 * @param {() => number} random
 * @param {number} n
 * @param {number} count
 * @returns {number[]} `count` distinct indexes below `n`, sorted.
 */
function pick(random, n, count) {
    return shuffled(random, n, count).toSorted((a, b) => a - b);
}

/**
 * The limits of each name in the profile.
 * @param {'realistic' | 'stress'} profile
 * @param {() => number} random
 * @returns {{ concurrency: number[], rate: number[] }[]}
 */
function limitsOfNames(profile, random) {
    return Array.from({ length: NAMES }, () => {
        const u = random();

        if (profile === 'stress') {
            return { concurrency: pick(random, STRESS_CONCURRENCY.length, 2 + Math.floor(u * 4)), rate: [] };
        }

        let count = 4 + Math.floor(random() * 2);

        if (u < 0.7) {
            count = 0;
        } else if (u < 0.85) {
            count = 1;
        } else if (u < 0.95) {
            count = 2 + Math.floor(random() * 2);
        }

        const concurrency = pick(random, REALISTIC_CONCURRENCY.length, count);
        const rate = count > 0 && random() < 0.1 ? [Math.floor(random() * REALISTIC_RATE.length)] : [];

        return { concurrency, rate };
    });
}

/**
 * @param {Limit} limit
 * @param {Payload} payload
 * @returns {number | null} The value of its key for the job: null for a limit without keys.
 */
export function keyValueOf(limit, payload) {
    if (limit.slot !== undefined) {
        return /** @type {number[]} */ (payload.keys)[limit.slot];
    }

    return limit.by === null ? null : payload[limit.by];
}

/**
 * @param {Limit} limit
 * @param {Payload} payload
 * @returns {string} The key of the job on the limit, as a name: `<limit>` or `<limit>:<value>`.
 */
export function keyOf(limit, payload) {
    const value = keyValueOf(limit, payload);

    return value === null ? limit.name : `${limit.name}:${value}`;
}

/**
 * The keys of a job with the limits of its name.
 * @param {Trace} trace
 * @param {TraceJob} job
 * @returns {{ concurrency: { key: string, max: number }[], rate: { key: string, max: number, perMs: number,
 *     burst: number }[] }}
 */
export function keysOfJob(trace, job) {
    const name = trace.names[job.name];

    return {
        concurrency: name.concurrency.map((index) => {
            const limit = trace.limits.concurrency[index];

            return { key: keyOf(limit, job.payload), max: limit.max };
        }),
        rate: name.rate.map((index) => {
            const limit = trace.limits.rate[index];

            return { key: keyOf(limit, job.payload), max: limit.max, perMs: limit.perMs, burst: limit.burst };
        }),
    };
}

/**
 * The trace of a profile. A longer trace starts with the jobs of a shorter one.
 * @param {{ profile: string, seed?: number, seconds: number, maxUtilization?: number }} options
 * @returns {Trace}
 */
export function generateTrace({ profile, seed = TRACE_SEED, seconds, maxUtilization = MAX_UTILIZATION }) {
    if (profile !== 'realistic' && profile !== 'stress') {
        throw new Error(`Unknown profile: ${profile} (${PROFILES.join(', ')})`);
    }

    if (!Number.isInteger(seed) || !(seconds > 0)) {
        throw new Error(`Invalid trace: seed ${seed}, ${seconds} s`);
    }

    const arrivals = streamOf(seed, 0);
    const namesOfJobs = streamOf(seed, 1);
    const durations = streamOf(seed, 2);
    const outcomes = streamOf(seed, 3);
    const payloads = streamOf(seed, 4);
    const slowNames = streamOf(seed, 5);
    const limitsRandom = streamOf(seed, profile === 'stress' ? 7 : 6);
    const nameCdf = zipf(NAMES);
    const tenantCdf = zipf(TENANTS);
    const userCdf = zipf(USERS_PER_TENANT);
    const integrationCdf = zipf(INTEGRATIONS);

    // The slow names: random names after the first ones, until they get SLOW_SHARE of the jobs
    const medians = Array.from({ length: NAMES }, () => FAST_MEDIAN_MS);
    let slowShare = 0;

    for (const index of shuffled(slowNames, NAMES, NAMES).filter(name => name >= FIRST_SLOW_RANK - 1)) {
        if (slowShare >= SLOW_SHARE) {
            break;
        }

        medians[index] = SLOW_MEDIAN_MS;
        slowShare += nameCdf[index] - (index > 0 ? nameCdf[index - 1] : 0);
    }

    const limitsOf = limitsOfNames(profile, limitsRandom);
    /** @type {TraceName[]} */
    const names = medians.map((medianMs, index) => ({
        name: `job_${String(index).padStart(4, '0')}`,
        medianMs,
        concurrency: limitsOf[index].concurrency,
        rate: limitsOf[index].rate,
    }));
    // RATE_LIMITED of all the jobs, from the names with a rate limit only
    let rateLimitedShare = 0;

    for (const [index, name] of names.entries()) {
        if (name.rate.length > 0) {
            rateLimitedShare += nameCdf[index] - (index > 0 ? nameCdf[index - 1] : 0);
        }
    }

    const rateLimitedOfName = rateLimitedShare > 0 ? Math.min(0.5, RATE_LIMITED / rateLimitedShare) : 0;
    /** @type {TraceJob[]} */
    const jobs = [];
    const endMs = seconds * 1000;

    for (let at = 0; ;) {
        const periodStart = Math.floor(at / PERIOD_MS) * PERIOD_MS;
        const inBurst = at - periodStart >= BURST_FROM_MS;
        const boundary = periodStart + (inBurst ? PERIOD_MS : BURST_FROM_MS);
        const next = at + (-Math.log(1 - arrivals()) / (inBurst ? BURST_RATE : BASE_RATE) * 1000);

        if (next >= boundary) {
            // Memoryless: the next rate from the boundary
            at = boundary;
        } else {
            at = next;

            if (at >= endMs) {
                break;
            }

            const name = sample(nameCdf, namesOfJobs());
            const durationMs = Math.min(MAX_DURATION_MS, Math.max(1, Math.round(
                names[name].medianMs * Math.exp(SIGMA * normal(durations)),
            )));
            const u = outcomes();
            const tenant = sample(tenantCdf, payloads());
            const user = sample(userCdf, payloads());
            const integration = (sample(integrationCdf, payloads()) + tenant) % INTEGRATIONS;
            const keys = Array.from({ length: STRESS_CONCURRENCY.length }, () => Math.floor(payloads() * STRESS_KEYS));
            /** @type {0 | 1 | 2} */
            let outcome = OUTCOME.ok;

            if (u < FAILS_ONCE) {
                outcome = OUTCOME.failsOnce;
            } else if (u < FAILS_ONCE + rateLimitedOfName && names[name].rate.length > 0) {
                outcome = OUTCOME.rateLimited;
            }

            jobs.push({
                at: Math.round(at * 1000) / 1000,
                name,
                durationMs,
                outcome,
                payload: {
                    i: jobs.length,
                    tenantId: tenant + 1,
                    userId: (tenant * USERS_PER_TENANT) + user + 1,
                    integration: integration + 1,
                    ...profile === 'stress' && { keys },
                },
            });
        }

        if (at >= endMs) {
            break;
        }
    }

    const limits = profile === 'stress'
        ? { concurrency: STRESS_CONCURRENCY, rate: [] }
        : { concurrency: REALISTIC_CONCURRENCY, rate: REALISTIC_RATE };
    /** @type {Trace} */
    const trace = {
        profile, seed, seconds, limits, names, jobs,
        check: { concurrency: { key: '', utilization: 0 }, rate: null },
    };

    trace.check = steadyState(trace, maxUtilization);

    return trace;
}

/**
 * Checks that each key has room on average: its work per second (the durations of its jobs, of each attempt) under
 * `maxUtilization` of its max, its starts per second under `maxUtilization` of its rate.
 * @param {Trace} trace
 * @param {number} maxUtilization
 * @returns {Trace['check']} The busiest keys.
 */
function steadyState(trace, maxUtilization) {
    /** @type {Map<string, { max: number, workMs: number }>} */
    const concurrency = new Map();
    /** @type {Map<string, { perSecond: number, starts: number }>} */
    const rate = new Map();

    for (const job of trace.jobs) {
        const attempts = job.outcome === OUTCOME.ok ? 1 : 2;
        const keys = keysOfJob(trace, job);

        for (const { key, max } of keys.concurrency) {
            const entry = concurrency.get(key) ?? { max, workMs: 0 };

            entry.workMs += job.durationMs * attempts;
            concurrency.set(key, entry);
        }

        for (const { key, max, perMs } of keys.rate) {
            const entry = rate.get(key) ?? { perSecond: max / perMs * 1000, starts: 0 };

            entry.starts += attempts;
            rate.set(key, entry);
        }
    }

    const busiest = { concurrency: { key: '', utilization: 0 }, rate: /** @type {any} */ (null) };

    for (const [key, { max, workMs }] of concurrency) {
        const utilization = workMs / (trace.seconds * 1000) / max;

        if (utilization >= maxUtilization) {
            throw new Error(`The trace has no steady state: key ${key} is busy ${(utilization * 100).toFixed(0)}% of `
                + `its max of ${max} on average (at most ${maxUtilization * 100}%)`);
        }

        if (utilization > busiest.concurrency.utilization) {
            busiest.concurrency = { key, utilization };
        }
    }

    for (const [key, { perSecond, starts }] of rate) {
        const utilization = starts / trace.seconds / perSecond;

        if (utilization >= maxUtilization) {
            throw new Error(`The trace has no steady state: rate key ${key} starts ${(utilization * 100).toFixed(0)}% `
                + `of its rate of ${perSecond}/s on average (at most ${maxUtilization * 100}%)`);
        }

        if (utilization > (busiest.rate?.utilization ?? 0)) {
            busiest.rate = { key, utilization };
        }
    }

    return busiest;
}

/** The buckets of the latency histograms: 16 per doubling (4.4% wide), from 1 ms; bucket 0 below 1 ms */
const BUCKETS_PER_DOUBLING = 16;

/**
 * @param {number} ms
 * @returns {number} The bucket of a latency.
 */
export function latencyBucket(ms) {
    return ms < 1 ? 0 : 1 + Math.floor(Math.log2(ms) * BUCKETS_PER_DOUBLING);
}

/**
 * The percentiles of a histogram, at the geometric middle of their bucket.
 * @param {Map<number, number>} histogram Bucket → count.
 * @param {number[]} percentiles From 0 to 1.
 * @returns {{ samples: number, values: number[] }} The values in ms.
 */
export function percentilesOf(histogram, percentiles) {
    const buckets = [...histogram].filter(([, count]) => count > 0).toSorted(([a], [b]) => a - b);
    let samples = 0;

    for (const [, count] of buckets) {
        samples += count;
    }

    const values = percentiles.map((percentile) => {
        let seen = 0;

        for (const [bucket, count] of buckets) {
            seen += count;

            if (seen >= percentile * samples) {
                return bucket === 0 ? 0.5 : 2 ** ((bucket - 0.5) / BUCKETS_PER_DOUBLING);
            }
        }

        return Number.NaN;
    });

    return { samples, values };
}
