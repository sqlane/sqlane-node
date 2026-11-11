import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { resolveDefaults } from './defaults.js';
import { defineJob } from './define_job.js';
import { LeaseLostError, RetryJobError, ShutdownError } from './errors.js';
import { createHintChannel } from './hint_channel.js';
import { createRegistry } from './registry.js';
import { createRunner } from './runner.js';

/**
 * A runner over a store of no jobs, whose makeDue() fails as given, call after call.
 * @param {unknown[]} makeDueErrors
 * @returns {{ runner: import('./runner.js').Runner, events: import('./types.js').SqlaneEvent[] }}
 */
function runnerWith(makeDueErrors) {
    const registry = createRegistry({
        jobsByName: new Map(),
        lanes: undefined,
        concurrency: 10,
        defaultTimeoutMs: null,
    });
    /** @type {import('./types.js').SqlaneEvent[]} */
    const events = [];
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        makeDue: async () => {
            const error = makeDueErrors.shift();

            if (error) {
                throw error;
            }
        },
        findCandidates: async () => [],
        claimDue: async () => ({ jobs: [], next: [] }),
    }));

    registry.handle('ping', () => {});

    return {
        runner: createRunner({
            store,
            registry,
            concurrency: 10,
            defaults: resolveDefaults(),
            cleanup: false,
            logger: undefined,
            onEvent: event => events.push(event),
            hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
            hintsAfterCommit: false,
        }),
        events,
    };
}

test('drain: a deadlock in a round is retried, not thrown', async () => {
    const deadlock = Object.assign(new Error('Deadlock found when trying to get lock'), { errno: 1213 });
    const { runner, events } = runnerWith([deadlock, deadlock]);

    await expect(runner.drain({ includeDelayed: true }))
        .resolves.toStrictEqual({ completed: 0, retried: 0, failed: 0 });
    expect(events).toMatchObject([
        { type: 'error', operation: 'drain', error: deadlock },
        { type: 'error', operation: 'drain', error: deadlock },
    ]);
});

test('drain: another error rejects', async () => {
    const { runner } = runnerWith([new Error('syntax error')]);

    await expect(runner.drain({ includeDelayed: true })).rejects.toThrow('syntax error');
});

/**
 * @typedef {object} HintedRunner
 * @property {import('./runner.js').Runner} runner
 * @property {() => number} lookups The probes and the claims of due jobs so far.
 * @property {(name: string) => void} deliver Delivers a hint message.
 */

/**
 * A started runner of the name `ping`, over a store of no jobs, with a hint whose messages the test delivers.
 * @param {boolean} hintsAfterCommit
 * @returns {Promise<HintedRunner>}
 */
async function runnerWithHint(hintsAfterCommit) {
    const registry = createRegistry({
        jobsByName: new Map(),
        lanes: undefined,
        concurrency: 10,
        defaultTimeoutMs: null,
    });
    // The probes and the claims of due jobs
    let lookups = 0;
    /** @type {((message: string) => void) | null} */
    let deliver = null;
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async () => {
            lookups++;

            return [];
        },
        claimDue: async () => {
            lookups++;

            return { jobs: [], next: [] };
        },
    }));

    registry.handle('ping', () => {});

    const runner = createRunner({
        store,
        registry,
        concurrency: 10,
        defaults: resolveDefaults(),
        cleanup: false,
        logger: undefined,
        onEvent: undefined,
        hintChannel: createHintChannel({
            hint: {
                publish: async () => {},
                subscribe: async (_channel, onMessage) => {
                    deliver = onMessage;

                    return async () => {};
                },
            },
            channel: 'c',
            reportError: () => {},
        }),
        hintsAfterCommit,
    });

    await runner.start();
    // The first turn
    await sleep(50);

    return { runner, lookups: () => lookups, deliver: name => deliver?.(name) };
}

test.each([
    { hint: 'NOTIFY, after the commit: looks at once', hintsAfterCommit: true, lookups: 1 },
    { hint: 'other, before the commit: looks again from 20 ms', hintsAfterCommit: false, lookups: 0 },
])('a hint: $hint', async ({ hintsAfterCommit, lookups: expected }) => {
    const { runner, lookups, deliver } = await runnerWithHint(hintsAfterCommit);
    const before = lookups();

    deliver('ping');
    await sleep(10);
    expect(lookups() - before).toBe(expected);
    await runner.close({ deadline: 0 });
});

test('hints before the commit: the re-probes of a name end with its steps, while later enqueues go on', async () => {
    const registry = createRegistry({
        jobsByName: new Map(),
        lanes: undefined,
        concurrency: 10,
        defaultTimeoutMs: null,
    });
    /** @type {string[]} The names of each probe, joined; "null": all names */
    const probed = [];
    const hints = { deliver: /** @type {(message: string) => void} */ (() => {}) };
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async (/** @type {string[] | null} */ names) => {
            probed.push(String(names));

            return [];
        },
    }));

    registry.handle('old', () => {});
    registry.handle('new', () => {});

    const runner = createRunner({
        store,
        registry,
        concurrency: 10,
        defaults: resolveDefaults(),
        cleanup: false,
        logger: undefined,
        onEvent: undefined,
        hintChannel: createHintChannel({
            hint: {
                publish: async () => {},
                subscribe: async (_channel, onMessage) => {
                    hints.deliver = onMessage;

                    return async () => {};
                },
            },
            channel: 'c',
            reportError: () => {},
        }),
        hintsAfterCommit: false,
        // Steps of 20, 50, 100 and 200 ms
        timings: { pollIntervalMs: 300 },
    });

    try {
        await runner.start();
        await sleep(50);
        hints.deliver('old');

        // Enqueues of `new` keep the series going, past the last step of `old`
        for (let index = 0; index < 8; index++) {
            // oxlint-disable-next-line no-await-in-loop -- one enqueue after the other
            await sleep(60);
            hints.deliver('new');
        }

        const lastProbes = probed.slice(-3);

        expect(probed.some(names => names.split(',').includes('old'))).toBe(true);
        expect(lastProbes.every(names => !names.split(',').includes('old'))).toBe(true);
        expect(lastProbes.some(names => names.split(',').includes('new'))).toBe(true);
    } finally {
        await runner.close({ deadline: 0 });
    }
});

/** @returns {number} The timers that keep the process alive. */
function refTimers() {
    return process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
}

test('close() leaves no timer that keeps the process alive', async () => {
    const before = refTimers();
    const { runner } = runnerWith([]);

    await runner.start();
    await runner.close({ deadline: '30s' });
    expect(refTimers()).toBe(before);
});

/**
 * A runner with spare slots and held handlers. A plain claim takes all due jobs; a keyed claim takes only one.
 * @param {boolean} keyed
 * @param {{
 *     claimDelayMs?: number,
 *     futureDelayMs?: number,
 *     sameNameFutureMs?: number,
 *     processConcurrency?: number,
 *     laneConcurrency?: number,
 *     completeCount?: number,
 *     handlerError?: unknown,
 * }} [options]
 * @returns {{
 *     runner: import('./runner.js').Runner,
 *     lookups: () => number,
 *     lookupTimes: number[],
 *     started: string[],
 *     events: import('./types.js').SqlaneEvent[],
 *     store: import('./store/store.js').Store,
 *     addJob: (id: string) => void,
 *     release: () => void,
 * }}
 */
function runnerWithHeldJobs(keyed, {
    claimDelayMs = 0,
    futureDelayMs,
    sameNameFutureMs,
    processConcurrency = 10,
    laneConcurrency = 5,
    completeCount,
    handlerError,
} = {}) {
    const registry = createRegistry({
        jobsByName: new Map(),
        lanes: undefined,
        concurrency: processConcurrency,
        defaultTimeoutMs: null,
    });
    const held = Promise.withResolvers();
    /** @type {string[]} */
    const started = [];
    /** @type {import('./types.js').SqlaneEvent[]} */
    const events = [];
    /** @type {number[]} */
    const lookupTimes = [];
    const pending = Array.from({
        length: keyed || sameNameFutureMs !== undefined || futureDelayMs !== undefined ? 2 : 1,
    }, (_, index) => ({
        id: `job-${index + 1}`,
        name: index > 0 && futureDelayMs !== undefined ? 'later' : 'ping',
        runAtMs: index > 0 ? Date.now() + (sameNameFutureMs ?? futureDelayMs ?? 0) : 0,
        mutexKeys: keyed ? [`key-${index + 1}`] : [],
        attempts: 0,
        maxAttempts: 3,
        stalls: 0,
        maxStalls: 2,
        failureJob: null,
        enqueuedAt: new Date(),
        waitedMs: 0,
        lockToken: `token-${index + 1}`,
        payload: { found: true, payload: null },
    }));
    const template = pending[0];

    /**
     * @param {Set<string>} names
     * @returns {import('./store/store.js').ProbeRow[]} The next due time of the names with pending jobs.
     */
    function nextDueTimes(names) {
        const times = new Map();

        for (const job of pending.filter(pendingJob => names.has(pendingJob.name))) {
            times.set(job.name, Math.min(times.get(job.name) ?? Infinity, job.runAtMs));
        }

        return [...times].map(([name, runAtMs]) => ({ name, delayMs: runAtMs - Date.now() }));
    }
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async () => {
            lookupTimes.push(Date.now());
            const times = new Map();

            for (const job of pending) {
                times.set(job.name, Math.min(times.get(job.name) ?? Infinity, job.runAtMs));
            }

            return [...times].map(([name, runAtMs]) => ({ name, delayMs: runAtMs - Date.now() }));
        },
        claimDue: async (/** @type {import('./store/store.js').ClaimDueParams} */ { requests }) => {
            lookupTimes.push(Date.now());

            if (claimDelayMs > 0) {
                await sleep(claimDelayMs);
            }

            const names = new Set(requests.map(request => request.name));
            const due = pending.filter(job => names.has(job.name) && job.runAtMs <= Date.now());

            for (const job of due) {
                pending.splice(pending.indexOf(job), 1);
            }

            return { jobs: due, next: nextDueTimes(names) };
        },
        findCandidates: async () => pending.map(job => ({ id: job.id, name: job.name, runAtMs: 0 })),
        claim: async () => pending.splice(0, 1),
        readPayloads: async (/** @type {string[]} */ ids) => new Map(ids.map(id => [id, null])),
        completeJobs: async (/** @type {unknown[]} */ jobs) => completeCount ?? jobs.length,
        renewLeases: async (/** @type {import('./store/store.js').OwnedJob[]} */ jobs) => (
            new Set(jobs.map(job => job.id))
        ),
        releaseJob: async () => true,
        findStaleJobs: async () => [],
    }));
    const definition = keyed ? defineJob({ name: 'ping', mutexKeys: () => ['key'], timeout: '1m' }) : 'ping';
    let nextError = handlerError;

    /** @param {import('./types.js').HandlerContext} context */
    async function handler({ job }) {
        started.push(job.id);
        await held.promise;

        if (nextError !== undefined) {
            const error = nextError;

            nextError = undefined;

            throw error;
        }
    }

    registry.handle(definition, handler, { concurrency: laneConcurrency });
    registry.handle('later', handler);

    return {
        runner: createRunner({
            store,
            registry,
            concurrency: processConcurrency,
            defaults: resolveDefaults(),
            cleanup: false,
            logger: undefined,
            onEvent: event => events.push(event),
            hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
            hintsAfterCommit: false,
            timings: { pollIntervalMs: 60_000 },
        }),
        lookups: () => lookupTimes.length,
        lookupTimes,
        started,
        events,
        store,
        addJob: id => pending.push({ ...template, id, runAtMs: 0 }),
        release: () => held.resolve(undefined),
    };
}

test('dispatch: a plain claim gives its next due times, then a successful completion with spare slots keeps it asleep', async () => {
    const { runner, lookups, started, events, release } = runnerWithHeldJobs(false);

    try {
        await runner.start();
        await waitFor(() => started.length === 1, 1000);
        await sleep(50);

        expect(started).toStrictEqual(['job-1']);
        expect(runner.canStartNow('ping')).toBe(true);
        expect(lookups()).toBe(2);

        const lookupsWhileHeld = lookups();

        release();
        await waitFor(() => events.some(event => event.type === 'completed'), 1000);
        await sleep(50);

        expect(events).toContainEqual(expect.objectContaining({ type: 'completed', jobId: 'job-1' }));
        expect(lookups()).toBe(lookupsWhileHeld);
    } finally {
        release();
        await runner.close({ deadline: 0 });
    }
});

test('dispatch: a partial keyed claim refills spare slots before a handler completes', async () => {
    const { runner, lookups, started, events, release } = runnerWithHeldJobs(true);

    try {
        await runner.start();
        await waitFor(() => started.length === 2, 1000);

        expect(started).toStrictEqual(['job-1', 'job-2']);
        expect(lookups()).toBeGreaterThanOrEqual(2);
        expect(events.filter(event => event.type === 'completed')).toStrictEqual([]);
    } finally {
        release();
        await runner.close({ deadline: 0 });
    }
});

test('dispatch: a slow plain claim preserves the next due deadline', async () => {
    const { runner, lookups, lookupTimes, started, events, release } = runnerWithHeldJobs(false, {
        claimDelayMs: 300,
        futureDelayMs: 600,
    });

    try {
        await runner.start();
        await waitFor(() => started.length === 2, 1500);

        expect(started).toStrictEqual(['job-1', 'job-2']);
        expect(events.filter(event => event.type === 'completed')).toStrictEqual([]);
        expect(lookups()).toBeGreaterThanOrEqual(3);
        // The claim ends at 300 ms; the next one takes the future job at its existing 600 ms deadline.
        expect(lookupTimes[2] - lookupTimes[0]).toBeGreaterThanOrEqual(550);
        expect(lookupTimes[2] - lookupTimes[0]).toBeLessThan(750);
    } finally {
        release();
        await runner.close({ deadline: 0 });
    }
});

test('dispatch: a delayed job of the same name starts while its earlier handler is held', async () => {
    const { runner, started, events, release } = runnerWithHeldJobs(false, { sameNameFutureMs: 200 });

    try {
        await runner.start();
        await waitFor(() => started.length === 2, 1000);

        expect(started).toStrictEqual(['job-1', 'job-2']);
        expect(events.filter(event => event.type === 'completed')).toStrictEqual([]);
    } finally {
        release();
        await runner.close({ deadline: 0 });
    }
});

test.each([
    { reason: 'a full process', keyed: false, options: { processConcurrency: 1 } },
    { reason: 'a full lane', keyed: false, options: { laneConcurrency: 1 } },
    { reason: 'an unconfirmed completion', keyed: false, options: { completeCount: 0 } },
    { reason: 'mutex keys', keyed: true, options: {} },
])('dispatch: completion still wakes for $reason', async ({ keyed, options }) => {
    const { runner, lookups, started, events, release } = runnerWithHeldJobs(keyed, options);

    try {
        await runner.start();
        await waitFor(() => started.length > 0, 1000);
        await sleep(50);
        const lookupsWhileHeld = lookups();

        release();
        await waitFor(() => events.some(event => event.type === 'completed'), 1000);
        await waitFor(() => lookups() > lookupsWhileHeld, 1000);

        expect(events).toContainEqual(expect.objectContaining({ type: 'completed', jobId: 'job-1' }));
        expect(lookups()).toBeGreaterThan(lookupsWhileHeld);
    } finally {
        release();
        await runner.close({ deadline: 0 });
    }
});

test('dispatch: a retry with spare slots wakes and runs its newly due job', async () => {
    const { runner, lookups, started, events, store, addJob, release } = runnerWithHeldJobs(false, {
        handlerError: new RetryJobError('retry now', { delay: 0 }),
    });

    store.retryJob = async () => {
        addJob('job-retry');

        return true;
    };

    try {
        await runner.start();
        await waitFor(() => lookups() >= 2, 1000);
        release();
        await waitFor(() => started.length === 2, 1000);

        expect(started).toStrictEqual(['job-1', 'job-retry']);
        expect(events).toContainEqual(expect.objectContaining({ type: 'retried', jobId: 'job-1' }));
    } finally {
        release();
        await runner.close({ deadline: 0 });
    }
});

test('dispatch: completion during an awaited claim wakes a refill after that claim fails', async () => {
    const { runner, lookups, started, events, store, addJob, release } = runnerWithHeldJobs(false);
    const claiming = Promise.withResolvers();
    const originalClaim = store.claimDue;
    let claimStarted = false;

    try {
        await runner.start();
        await waitFor(() => lookups() >= 2, 1000);
        addJob('job-2');
        store.claimDue = async () => {
            claimStarted = true;
            await claiming.promise;

            return { jobs: [], next: [] };
        };
        runner.wake();
        await waitFor(() => claimStarted, 1000);

        expect(claimStarted).toBe(true);
        expect(runner.canStartNow('ping')).toBe(true);

        release();
        await waitFor(() => events.some(event => event.type === 'completed'), 1000);
        // The rejected claim would otherwise make dispatch sleep for its 1 s error backoff.
        store.claimDue = originalClaim;
        claiming.reject(new Error('claim connection lost'));
        await waitFor(() => started.length === 2, 300);

        expect(started).toStrictEqual(['job-1', 'job-2']);
        expect(events).toContainEqual(expect.objectContaining({ type: 'error', operation: 'dispatch' }));
    } finally {
        store.claimDue = originalClaim;
        claiming.resolve(undefined);
        release();
        await runner.close({ deadline: 0 });
    }
});

const LEASE_TIMINGS = { leaseMs: 800, renewIntervalMs: 200, recoveryIntervalMs: 60_000 };

/**
 * @typedef {object} LeasedRunner
 * @property {import('./runner.js').Runner} runner
 * @property {import('./types.js').SqlaneEvent[]} events
 * @property {() => number} claimedAt When the job was claimed: its lease ends `leaseMs` after.
 * @property {{ reason: unknown, at: number }[]} aborts The aborts of the handler's signal.
 * @property {() => number} renewCalls The calls of store.renewLeases().
 * @property {() => number} renewErrors The `renew_leases` errors reported.
 */

/**
 * A runner that claims one job of `ping`, whose handler runs until its signal aborts, or for `handlerMs`.
 * @param {(jobs: import('./store/store.js').OwnedJob[]) => Promise<Set<string>>} renewLeases
 * @param {{ start?: boolean, handlerMs?: number }} [options] `start: false`: not started, for drain().
 * @returns {Promise<LeasedRunner>}
 */
async function runnerWithLease(renewLeases, { start = true, handlerMs } = {}) {
    const registry = createRegistry({
        jobsByName: new Map(),
        lanes: undefined,
        concurrency: 10,
        defaultTimeoutMs: null,
    });
    /** @type {import('./types.js').SqlaneEvent[]} */
    const events = [];
    /** @type {{ reason: unknown, at: number }[]} */
    const aborts = [];
    let claimedAt = 0;
    let renewCalls = 0;
    let due = true;
    const job = {
        id: 'job-1',
        name: 'ping',
        mutexKeys: [],
        attempts: 0,
        maxAttempts: 3,
        stalls: 0,
        maxStalls: 2,
        failureJob: null,
        enqueuedAt: new Date(),
        waitedMs: 0,
        lockToken: 'token-1',
        payload: { found: true, payload: null },
    };
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async () => (due ? [{ name: 'ping', delayMs: 0 }] : []),
        claimDue: async () => {
            const claimed = due ? [job] : [];

            due = false;

            return { jobs: claimed, next: [] };
        },
        renewLeases: (/** @type {import('./store/store.js').OwnedJob[]} */ jobs) => {
            renewCalls++;

            return renewLeases(jobs);
        },
        releaseJob: async () => true,
        completeJobs: async (/** @type {unknown[]} */ jobs) => jobs.length,
        findStaleJobs: async () => [],
    }));

    registry.handle('ping', ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
            aborts.push({ reason: signal.reason, at: Date.now() });
            resolve(undefined);
        }, { once: true });

        if (handlerMs !== undefined) {
            setTimeout(resolve, handlerMs);
        }
    }));

    const runner = createRunner({
        store,
        registry,
        concurrency: 10,
        defaults: resolveDefaults(),
        cleanup: false,
        logger: undefined,
        onEvent: (event) => {
            if (event.type === 'claimed') {
                claimedAt = Date.now();
            }

            events.push(event);
        },
        hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
        hintsAfterCommit: false,
        timings: LEASE_TIMINGS,
    });

    if (start) {
        await runner.start();
    }

    return {
        runner,
        events,
        claimedAt: () => claimedAt,
        aborts,
        renewCalls: () => renewCalls,
        renewErrors: () => events.filter(event => event.type === 'error' && event.operation === 'renew_leases').length,
    };
}

/**
 * A renewal of the leases that fails the given times, then renews all.
 * @param {number} failures
 * @returns {(jobs: import('./store/store.js').OwnedJob[]) => Promise<Set<string>>}
 */
function failingFirst(failures) {
    let left = failures;

    return async (jobs) => {
        if (left > 0) {
            left--;

            throw new Error('connection reset');
        }

        return new Set(jobs.map(job => job.id));
    };
}

/**
 * @param {() => boolean} condition
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitFor(condition, timeoutMs) {
    const until = Date.now() + timeoutMs;

    while (!condition() && Date.now() < until) {
        // oxlint-disable-next-line no-await-in-loop -- a poll
        await sleep(5);
    }
}

test.each([
    {
        renewal: 'rejects',
        renewLeases: async () => {
            throw new Error('pool exhausted');
        },
        minCalls: 2,
        maxCalls: Infinity,
    },
    // Not started again while it hangs
    { renewal: 'never settles', renewLeases: () => new Promise(() => {}), minCalls: 1, maxCalls: 1 },
])('lease: a renewal that $renewal aborts the handler before the lease ends', async ({
    renewLeases,
    minCalls,
    maxCalls,
}) => {
    const { runner, events, claimedAt, aborts, renewCalls, renewErrors } = await runnerWithLease(
        /** @type {() => Promise<Set<string>>} */ (renewLeases),
    );

    await waitFor(() => aborts.length > 0, 2 * LEASE_TIMINGS.leaseMs);
    // More renewals: the lease is lost once
    await sleep(2 * LEASE_TIMINGS.renewIntervalMs);
    await runner.close({ deadline: 0 });

    expect(aborts).toHaveLength(1);
    expect(aborts[0].reason).toBeInstanceOf(LeaseLostError);
    expect(aborts[0].at).toBeLessThan(claimedAt() + LEASE_TIMINGS.leaseMs);
    expect(events.filter(event => event.type === 'lease_lost')).toMatchObject([{ type: 'lease_lost', jobId: 'job-1' }]);
    // Each failed renewal is reported
    expect(renewErrors()).toBe(renewCalls());
    expect(renewCalls()).toBeGreaterThanOrEqual(minCalls);
    expect(renewCalls()).toBeLessThanOrEqual(maxCalls);
});

test('lease: a renewal that fails once, then succeeds in time, keeps the job', async () => {
    const { runner, events, claimedAt, aborts, renewErrors } = await runnerWithLease(failingFirst(1));

    await waitFor(() => claimedAt() > 0, 1000);
    // Past the end of the first lease
    await sleep(LEASE_TIMINGS.leaseMs + (2 * LEASE_TIMINGS.renewIntervalMs));

    expect(aborts).toStrictEqual([]);
    expect(events.filter(event => event.type === 'lease_lost')).toStrictEqual([]);
    expect(renewErrors()).toBe(1);
    await runner.close({ deadline: 0 });
});

/** @returns {(jobs: import('./store/store.js').OwnedJob[]) => Promise<Set<string>>} A renewal that renews all. */
function renewingAll() {
    return failingFirst(0);
}

test('lease: renewed while close() waits for a handler longer than a lease', async () => {
    const { runner, events, claimedAt, aborts, renewCalls } = await runnerWithLease(renewingAll());

    await waitFor(() => claimedAt() > 0, 1000);

    const closed = runner.close({ deadline: 3 * LEASE_TIMINGS.leaseMs });
    const callsAtClose = renewCalls();

    await sleep(2 * LEASE_TIMINGS.leaseMs);

    // Past the end of the first lease: still renewed, not lost
    expect(renewCalls()).toBeGreaterThan(callsAtClose);
    expect(aborts).toStrictEqual([]);
    await closed;
    expect(aborts.map(abort => abort.reason)).toStrictEqual([expect.any(ShutdownError)]);
    expect(events.filter(event => event.type === 'lease_lost')).toStrictEqual([]);
});

test('lease: lost while close() waits, if the renewals fail', async () => {
    const { runner, events, claimedAt, aborts } = await runnerWithLease(async () => {
        throw new Error('pool exhausted');
    });

    await waitFor(() => claimedAt() > 0, 1000);

    const closed = runner.close({ deadline: 3 * LEASE_TIMINGS.leaseMs });

    await waitFor(() => aborts.length > 0, 2 * LEASE_TIMINGS.leaseMs);
    await closed;

    expect(aborts).toHaveLength(1);
    expect(aborts[0].reason).toBeInstanceOf(LeaseLostError);
    expect(aborts[0].at).toBeLessThan(claimedAt() + LEASE_TIMINGS.leaseMs);
    expect(events.filter(event => event.type === 'lease_lost')).toHaveLength(1);
});

test('lease: renewed during drain() for a handler longer than a lease', async () => {
    const { runner, events, aborts, renewCalls } = await runnerWithLease(renewingAll(), {
        start: false,
        handlerMs: 2 * LEASE_TIMINGS.leaseMs,
    });

    await expect(runner.drain()).resolves.toMatchObject({ completed: 1 });
    expect(renewCalls()).toBeGreaterThan(0);
    expect(aborts).toStrictEqual([]);
    expect(events.filter(event => event.type === 'lease_lost')).toStrictEqual([]);
    await runner.close({ deadline: 0 });
});

test.each([
    { result: 'released', event: { type: 'stalled', jobId: 'job-9', jobName: 'ping', attempt: 2 } },
    { result: 'failed', event: { type: 'failed', jobId: 'job-9', jobName: 'ping', attempt: 2, durationMs: 250_000 } },
])('stall recovery: the $result event has the attempt and the duration of the run that stalled', async ({
    result,
    event,
}) => {
    const registry = createRegistry({
        jobsByName: new Map(),
        lanes: undefined,
        concurrency: 10,
        defaultTimeoutMs: null,
    });
    /** @type {import('./types.js').SqlaneEvent[]} */
    const events = [];
    let stale = [{ id: 'job-9', name: 'ping' }];
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async () => [],
        findStaleJobs: async () => {
            const found = stale;

            stale = [];

            return found;
        },
        recoverStaleJob: async () => ({ result, failureJob: null, attempt: 2, runMs: 250_000 }),
        sweepMutexes: async () => ({ lingers: 0, orphans: 0 }),
    }));

    registry.handle('ping', () => {});

    const runner = createRunner({
        store,
        registry,
        concurrency: 10,
        defaults: resolveDefaults(),
        cleanup: false,
        logger: undefined,
        onEvent: e => events.push(e),
        hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
        hintsAfterCommit: false,
        timings: { recoveryIntervalMs: 20 },
    });

    await runner.start();
    await waitFor(() => events.some(e => e.type === event.type), 1000);
    await runner.close({ deadline: 0 });
    expect(events.filter(e => e.type === event.type)).toMatchObject([event]);
});

/** A log function that drops its message. */
function ignore() {}

test.each([
    { label: 'a deadline that is not a duration', options: { deadline: 'soon' } },
    { label: 'unordered deadline units', options: { deadline: '1ms 1s' } },
    { label: 'an unknown mode', options: { mode: 'kill' } },
    { label: 'an exitsBy before the deadline', options: { deadline: 0, exitsBy: -1 } },
    { label: 'an exitsBy that is not a duration', options: { exitsBy: 'later' } },
    { label: 'an unknown option', options: { timeout: '1s' } },
])('close(): $label logs a warning, and close() still closes', async ({ options }) => {
    /** @type {string[]} */
    const warnings = [];
    const registry = createRegistry({
        jobsByName: new Map(),
        lanes: undefined,
        concurrency: 10,
        defaultTimeoutMs: null,
    });
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({ probe: async () => [] }));
    registry.handle('ping', () => {});

    const runner = createRunner({
        store,
        registry,
        concurrency: 10,
        defaults: resolveDefaults(),
        cleanup: false,
        logger: {
            debug: ignore,
            info: ignore,
            error: ignore,
            warn: (_object, message) => warnings.push(String(message)),
        },
        onEvent: () => {},
        hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
        hintsAfterCommit: false,
    });

    await runner.start();
    // A shutdown always releases its jobs: no rejection because of the options
    await expect(runner.close(/** @type {any} */ ({ deadline: 0, ...options }))).resolves.toBeUndefined();
    expect(runner.isClosed()).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^sqlane: close\(\) got .+: the default is used$/u);
});
