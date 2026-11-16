import { expect, test } from 'vitest';
import { blockedJobs, guard, runsByKey } from './contention.mjs';
import { generateTrace, latencyBucket, OUTCOME, percentilesOf, splitmix32 } from './trace.mjs';

// The length of the trace of the contention scenarios: 30 s of warm-up, 60 s of window, 30 s of margin
const SECONDS = 120;
const realistic = generateTrace({ profile: 'realistic', seconds: SECONDS });
const stress = generateTrace({ profile: 'stress', seconds: SECONDS });

/**
 * @param {import('./trace.mjs').Trace} trace
 * @param {(job: import('./trace.mjs').TraceJob) => boolean} predicate
 * @returns {number} The share of the jobs that match.
 */
function shareOf(trace, predicate) {
    return trace.jobs.filter(predicate).length / trace.jobs.length;
}

/**
 * @param {number[]} values
 * @returns {{ min: number, max: number, mean: number }}
 */
function statsOf(values) {
    let total = 0;

    for (const value of values) {
        total += value;
    }

    return { min: Math.min(...values), max: Math.max(...values), mean: total / values.length };
}

/**
 * @param {number[]} values
 * @returns {boolean} Whether each value is at least the one before it.
 */
function ascending(values) {
    return values.every((value, index) => index === 0 || value >= values[index - 1]);
}

/**
 * @param {number[]} latencies
 * @returns {Map<number, number>} Their histogram.
 */
function histogramOf(latencies) {
    /** @type {Map<number, number>} */
    const histogram = new Map();

    for (const ms of latencies) {
        histogram.set(latencyBucket(ms), (histogram.get(latencyBucket(ms)) ?? 0) + 1);
    }

    return histogram;
}

/**
 * @param {number[]} counts
 * @param {number} low
 * @param {number} high
 * @returns {number} The share of the counts from low to high.
 */
function shareBetween(counts, low, high) {
    return counts.filter(count => count >= low && count <= high).length / counts.length;
}

test('splitmix32: the same seed gives the same values in [0, 1)', () => {
    const first = Array.from({ length: 1000 }, splitmix32(7));

    expect(Array.from({ length: 1000 }, splitmix32(7))).toStrictEqual(first);
    expect(Array.from({ length: 1000 }, splitmix32(8))).not.toStrictEqual(first);
    expect(Math.min(...first)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...first)).toBeLessThan(1);
});

test('the same seed gives the same trace; another seed another one', () => {
    expect(generateTrace({ profile: 'realistic', seconds: SECONDS })).toStrictEqual(realistic);
    expect(generateTrace({ profile: 'realistic', seed: 2, seconds: SECONDS }).jobs).not.toStrictEqual(realistic.jobs);
});

test('a shorter trace is the start of a longer one', () => {
    const short = generateTrace({ profile: 'realistic', seconds: 50 });

    expect(short.jobs.length).toBeGreaterThan(0);
    expect(realistic.jobs.slice(0, short.jobs.length)).toStrictEqual(short.jobs);
    expect(realistic.jobs[short.jobs.length].at).toBeGreaterThanOrEqual(50_000);
});

test('both profiles have the same arrivals, names, durations and payloads; only the limits differ', () => {
    expect(stress.jobs.map(job => [job.at, job.name, job.durationMs, job.payload.tenantId, job.payload.userId,
        job.payload.integration])).toStrictEqual(realistic.jobs.map(job => [job.at, job.name, job.durationMs,
        job.payload.tenantId, job.payload.userId, job.payload.integration]));
    expect(stress.names.map(name => name.medianMs)).toStrictEqual(realistic.names.map(name => name.medianMs));
    expect(stress.names.map(name => name.concurrency)).not.toStrictEqual(realistic.names.map(name => name.concurrency));
});

test('the arrivals: 100/s, 300/s in the burst of 2 s of each 10 s', () => {
    const inBurst = realistic.jobs.filter(job => job.at % 10_000 >= 8000).length;

    expect(realistic.jobs.length / SECONDS).toBeGreaterThan(140 * 0.95);
    expect(realistic.jobs.length / SECONDS).toBeLessThan(140 * 1.05);
    expect(inBurst / (SECONDS * 0.2)).toBeGreaterThan(300 * 0.93);
    expect(inBurst / (SECONDS * 0.2)).toBeLessThan(300 * 1.07);
    expect(ascending(realistic.jobs.map(job => job.at))).toBe(true);
});

test('the names, the durations and the outcomes', () => {
    const meanMs = statsOf(realistic.jobs.map(job => job.durationMs)).mean;
    const fast = realistic.jobs.filter(job => realistic.names[job.name].medianMs === 20).map(job => job.durationMs);

    // Zipf: the first name gets 1 / H(1000) = 13.4% of the jobs
    expect(shareOf(realistic, job => job.name === 0)).toBeGreaterThan(0.12);
    expect(shareOf(realistic, job => job.name === 0)).toBeLessThan(0.15);
    expect(shareOf(realistic, job => realistic.names[job.name].medianMs === 300)).toBeGreaterThan(0.04);
    expect(shareOf(realistic, job => realistic.names[job.name].medianMs === 300)).toBeLessThan(0.065);
    expect(fast.toSorted((a, b) => a - b)[Math.floor(fast.length / 2)]).toBeGreaterThanOrEqual(18);
    expect(fast.toSorted((a, b) => a - b)[Math.floor(fast.length / 2)]).toBeLessThanOrEqual(22);
    expect(meanMs).toBeGreaterThan(45);
    expect(meanMs).toBeLessThan(65);
    expect(Math.max(...realistic.jobs.map(job => job.durationMs))).toBe(2000);
    expect(shareOf(realistic, job => job.outcome === OUTCOME.failsOnce)).toBeGreaterThan(0.008);
    expect(shareOf(realistic, job => job.outcome === OUTCOME.failsOnce)).toBeLessThan(0.012);
    expect(shareOf(realistic, job => job.outcome === OUTCOME.rateLimited)).toBeGreaterThan(0.001);
    expect(shareOf(realistic, job => job.outcome === OUTCOME.rateLimited)).toBeLessThan(0.003);
    expect(realistic.jobs.filter(job => job.outcome === OUTCOME.rateLimited)
        .every(job => realistic.names[job.name].rate.length > 0)).toBe(true);
    expect(stress.jobs.some(job => job.outcome === OUTCOME.rateLimited)).toBe(false);
});

test('the payloads: tenants, their users and integrations, and the keys of the stress profile', () => {
    const payloads = stress.jobs.map(job => job.payload);

    expect(statsOf(payloads.map(payload => payload.tenantId))).toMatchObject({ min: 1, max: 1000 });
    expect(payloads.every(({ tenantId, userId }) => Math.ceil(userId / 10) === tenantId)).toBe(true);
    expect(new Set(payloads.map(payload => payload.integration)).size).toBe(20);
    expect(shareOf(stress, job => job.payload.tenantId === 1)).toBeGreaterThan(0.12);
    const keys = payloads.map(payload => /** @type {number[]} */ (payload.keys));

    expect(keys.map(values => values.length)).toStrictEqual(payloads.map(() => 5));
    expect(statsOf(keys.flat())).toMatchObject({ min: 0, max: 19 });
    expect(realistic.jobs.some(job => 'keys' in job.payload)).toBe(false);
});

test('the limits of the names: the shares of the realistic profile, 2 to 5 of the stress one', () => {
    const counts = realistic.names.map(name => name.concurrency.length);
    const limited = realistic.names.filter(name => name.concurrency.length > 0);

    const withRate = shareBetween(limited.map(name => name.rate.length), 1, 1);

    expect(shareBetween(counts, 0, 0)).toBeGreaterThan(0.65);
    expect(shareBetween(counts, 0, 0)).toBeLessThan(0.75);
    expect(shareBetween(counts, 1, 1)).toBeGreaterThan(0.12);
    expect(shareBetween(counts, 2, 3)).toBeGreaterThan(0.07);
    expect(shareBetween(counts, 4, 5)).toBeGreaterThan(0.03);
    expect(withRate).toBeGreaterThan(0.05);
    expect(withRate).toBeLessThan(0.15);
    // Only names with a concurrency limit have a rate limit
    expect(realistic.names.filter(name => name.rate.length > 0)).toHaveLength(Math.round(withRate * limited.length));
    expect(shareBetween(stress.names.map(name => name.concurrency.length), 2, 5)).toBe(1);
    expect(stress.names.every(name => name.rate.length === 0)).toBe(true);
});

test('the steady state: the busiest key under 80%, else the generation fails and names the key', () => {
    expect(realistic.check.concurrency.utilization).toBeLessThan(0.8);
    expect(realistic.check.rate?.utilization).toBeLessThan(0.8);
    expect(stress.check.concurrency.utilization).toBeLessThan(0.8);
    expect(stress.check.rate).toBeNull();
    expect(() => generateTrace({ profile: 'stress', seconds: SECONDS, maxUtilization: 0.1 }))
        .toThrow(/no steady state: key stress_\d:\d+ is busy/v);
    expect(() => generateTrace({ profile: 'realistic', seconds: SECONDS, maxUtilization: 0.01 }))
        .toThrow(/no steady state: (rate )?key \S+/v);
    expect(() => generateTrace({ profile: 'other', seconds: SECONDS })).toThrow(/Unknown profile/v);
});

test('the latency histogram: buckets of 4.4%, percentiles at their middle', () => {
    const histogram = histogramOf(Array.from({ length: 100 }, (_, index) => index + 1));
    const { samples, values: [p50, p99] } = percentilesOf(histogram, [0.5, 0.99]);

    expect(samples).toBe(100);
    expect(p50 / 50).toBeCloseTo(1, 1);
    expect(p99 / 99).toBeCloseTo(1, 1);
    expect(latencyBucket(0.2)).toBe(0);
});

/**
 * A trace of 4 jobs of one name with a concurrency limit of max 1 and a rate limit of 1 per 100 ms, without keys.
 * @returns {import('./trace.mjs').Trace}
 */
function tinyTrace() {
    const payload = { i: 0, tenantId: 1, userId: 1, integration: 1 };

    return {
        profile: 'realistic', seed: 1, seconds: 1,
        limits: {
            concurrency: [{ name: 'one', max: 1, by: null }],
            rate: [{ name: 'api', max: 1, perMs: 200, burst: 1, by: null }],
        },
        names: [{ name: 'job_0000', medianMs: 20, concurrency: [0], rate: [0] }],
        jobs: [0, 1, 2, 3].map(index => ({
            at: 0, name: 0, durationMs: 50, outcome: /** @type {const} */ (0), payload: { ...payload, i: index },
        })),
        check: { concurrency: { key: 'one', utilization: 0 }, rate: null },
    };
}

test('the guard: runs at once over the max of a key, or starts in a period over its rate, are violations', () => {
    const trace = tinyTrace();
    // One after the other, 200 ms apart: the end of one at the start of the next is no overlap
    const ok = { index: [0, 1, 2], start: [1000, 1200, 1400], end: [1200, 1300, 0], enqueuedAt: [1000, 1000, 1000] };

    expect(guard(runsByKey(trace, ok)).violations).toStrictEqual([]);

    const overlap = { index: [0, 1], start: [1000, 1400], end: [1500, 1450], enqueuedAt: [1000, 1000] };

    expect(guard(runsByKey(trace, overlap)).violations).toStrictEqual(['one: 2 at once, max 1']);

    // A run still running at the end overlaps everything after it
    const running = { index: [0, 1], start: [1000, 5000], end: [0, 5050], enqueuedAt: [1000, 1000] };

    expect(guard(runsByKey(trace, running)).violations).toContain('one: 2 at once, max 1');

    // 2 starts 50 ms apart: within the period less the slack (100 ms)
    const fast = { index: [0, 1], start: [1000, 1050], end: [1010, 1060], enqueuedAt: [1000, 1000] };

    expect(guard(runsByKey(trace, fast)).violations).toStrictEqual(['@api: 2 starts in 100 ms, at most 1']);
});

test('the blocked jobs: a full key, or a rate key without quota, between the enqueue and the first start', () => {
    const trace = tinyTrace();
    // Job 0 runs from 1000 to 1100. Job 1, enqueued at 1050, starts at 1300: it waited on both keys. Job 2, enqueued
    // at 1500 when the keys were free, starts at once. Job 3 runs before the window
    const runs = {
        index: [3, 0, 1, 2],
        start: [100, 1000, 1300, 1500],
        end: [150, 1100, 1350, 1550],
        enqueuedAt: [100, 1000, 1050, 1500],
    };

    expect(blockedJobs(trace, runs, runsByKey(trace, runs), { from: 1000, to: 2000 }))
        .toStrictEqual({ jobs: 3, blocked: 1 });
});
