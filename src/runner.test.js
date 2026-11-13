import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { resolveDefaults } from './defaults.js';
import { defineConcurrencyGroup } from './define_concurrency_group.js';
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
        maxConcurrency: 10,
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
        probe: async () => [{ name: 'ping', delayMs: 0 }],
        claimDue: async () => ({ jobs: [], next: [] }),
    }));

    registry.handle('ping', () => {});

    return {
        runner: createRunner({
            store,
            registry,
            maxConcurrency: 10,
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
        maxConcurrency: 10,
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
        maxConcurrency: 10,
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
        maxConcurrency: 10,
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
        maxConcurrency: 10,
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
 * A runner with spare slots and held handlers. A plain claim takes all due jobs; a claim with mutex keys takes only
 * one.
 * @param {boolean} withKeys
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
 *     probedNames: (string[] | null)[],
 *     releasedKeys: string[][],
 *     addJob: (id: string) => void,
 *     release: () => void,
 * }}
 */
function runnerWithHeldJobs(withKeys, {
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
        maxConcurrency: processConcurrency,
        defaultTimeoutMs: null,
    });
    const held = Promise.withResolvers();
    /** @type {string[]} */
    const started = [];
    /** @type {import('./types.js').SqlaneEvent[]} */
    const events = [];
    /** @type {number[]} */
    const lookupTimes = [];
    /** @type {(string[] | null)[]} The names of each probe */
    const probedNames = [];
    /** @type {string[][]} The keys of each lookup of the jobs that wait for released keys */
    const releasedKeys = [];
    const pending = Array.from({
        length: withKeys || sameNameFutureMs !== undefined || futureDelayMs !== undefined ? 2 : 1,
    }, (_, index) => ({
        id: `job-${index + 1}`,
        name: index > 0 && futureDelayMs !== undefined ? 'later' : 'ping',
        runAtMs: index > 0 ? Date.now() + (sameNameFutureMs ?? futureDelayMs ?? 0) : 0,
        mutexKeys: withKeys ? [`key-${index + 1}`] : [],
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
        probe: async (/** @type {string[] | null} */ names) => {
            lookupTimes.push(Date.now());
            probedNames.push(names);
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
        namesWaitingFor: async (/** @type {string[]} */ keys) => {
            lookupTimes.push(Date.now());
            releasedKeys.push(keys);

            const waiting = pending.filter(job => job.mutexKeys.some(key => keys.includes(key)));

            return [...new Set(waiting.map(job => job.name))];
        },
        claim: async () => pending.splice(0, 1),
        readPayloads: async (/** @type {string[]} */ ids) => new Map(ids.map(id => [id, null])),
        completeJobs: async (/** @type {unknown[]} */ jobs) => completeCount ?? jobs.length,
        renewLeases: async (/** @type {import('./store/store.js').OwnedJob[]} */ jobs) => (
            new Set(jobs.map(job => job.id))
        ),
        releaseJob: async () => true,
        findStaleJobs: async () => [],
    }));
    const definition = withKeys ? defineJob({ name: 'ping', mutexKeys: () => ['key'], timeout: '1m' }) : 'ping';
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

    registry.handle(definition, handler, { maxConcurrency: laneConcurrency });
    registry.handle('later', handler);

    return {
        runner: createRunner({
            store,
            registry,
            maxConcurrency: processConcurrency,
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
        probedNames,
        releasedKeys,
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

test('dispatch: a partial claim of jobs with mutex keys refills spare slots before a handler completes', async () => {
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
    { reason: 'a full process', withKeys: false, options: { processConcurrency: 1, laneConcurrency: 1 } },
    { reason: 'a name at its maxConcurrency', withKeys: false, options: { laneConcurrency: 1 } },
    { reason: 'an unconfirmed completion', withKeys: false, options: { completeCount: 0 } },
    { reason: 'mutex keys', withKeys: true, options: {} },
])('dispatch: completion still wakes for $reason', async ({ withKeys, options }) => {
    const { runner, lookups, started, events, release } = runnerWithHeldJobs(withKeys, options);

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

test('dispatch: a completion with mutex keys looks up the jobs that wait for its keys, not all names', async () => {
    const { runner, started, events, probedNames, releasedKeys, release } = runnerWithHeldJobs(true);

    try {
        await runner.start();
        await waitFor(() => started.length === 2, 1000);
        await sleep(50);
        const fullProbes = probedNames.filter(names => names === null).length;

        release();
        await waitFor(() => events.filter(event => event.type === 'completed').length === 2, 1000);
        await waitFor(() => releasedKeys.length > 0, 1000);

        expect(releasedKeys.flat().toSorted()).toStrictEqual(['key-1', 'key-2']);
        expect(probedNames.filter(names => names === null)).toHaveLength(fullProbes);
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
        maxConcurrency: 10,
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
        maxConcurrency: 10,
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
        maxConcurrency: 10,
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
        maxConcurrency: 10,
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
        maxConcurrency: 10,
        defaultTimeoutMs: null,
    });
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({ probe: async () => [] }));
    registry.handle('ping', () => {});

    const runner = createRunner({
        store,
        registry,
        maxConcurrency: 10,
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

/**
 * @param {string} name
 * @returns {import('./store/store.js').StartableJob} A due job of the name.
 */
function dueJobOf(name) {
    return {
        id: name,
        name,
        mutexKeys: [],
        attempts: 0,
        maxAttempts: 1,
        stalls: 0,
        maxStalls: 2,
        failureJob: null,
        enqueuedAt: new Date(),
        waitedMs: 0,
        lockToken: `token-${name}`,
        payload: { found: true, payload: null },
    };
}

/**
 * A store with one due job per name. A claim takes the jobs of the requested names up to the free process slots; a
 * full claim does not read the next due times, as the real ones.
 * @param {string[]} names
 * @returns {{ store: import('./store/store.js').Store, requestSizes: number[] }}
 */
function storeOfDueNames(names) {
    const pending = new Set(names);
    /** @type {number[]} */
    const requestSizes = [];
    /**
     * @param {import('./store/store.js').DueRequest[]} requests
     * @returns {import('./store/store.js').ProbeRow[]} The requested names that still have a due job.
     */
    const stillDue = requests => requests
        .filter(request => pending.has(request.name))
        .map(request => ({ name: request.name, delayMs: -1 }));
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async () => [...pending].map(name => ({ name, delayMs: -1 })),
        claimDue: async (/** @type {import('./store/store.js').ClaimDueParams} */ { requests, free: processMax }) => {
            requestSizes.push(requests.length);

            const jobs = stillDue(requests).slice(0, processMax).map(row => dueJobOf(row.name));

            for (const job of jobs) {
                pending.delete(job.name);
            }

            return { jobs, next: jobs.length >= processMax ? null : stillDue(requests) };
        },
        completeJobs: async (/** @type {unknown[]} */ jobs) => jobs.length,
        renewLeases: async (/** @type {import('./store/store.js').OwnedJob[]} */ jobs) => (
            new Set(jobs.map(job => job.id))
        ),
        findStaleJobs: async () => [],
    }));

    return { store, requestSizes };
}

test('dispatch: many due names take turns, a claim requests at most 4 names per free slot', async () => {
    const registry = createRegistry({
        jobsByName: new Map(),
        maxConcurrency: 2,
        defaultTimeoutMs: null,
    });
    const names = Array.from({ length: 50 }, (_, index) => `name_${index}`);
    const { store, requestSizes } = storeOfDueNames(names);
    /** @type {string[]} */
    const ran = [];

    for (const name of names) {
        registry.handle(name, () => {
            ran.push(name);
        });
    }

    const runner = createRunner({
        store,
        registry,
        maxConcurrency: 2,
        defaults: resolveDefaults(),
        cleanup: false,
        logger: undefined,
        onEvent: undefined,
        hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
        hintsAfterCommit: false,
        timings: { pollIntervalMs: 60_000 },
    });

    try {
        await runner.start();
        await waitFor(() => ran.length === names.length, 3000);

        expect(ran.toSorted()).toStrictEqual(names.toSorted());
        expect(Math.max(...requestSizes)).toBeLessThanOrEqual(8);
    } finally {
        await runner.close({ deadline: 0 });
    }
});

test('the handler gets the slot of a job of a schedule as job.scheduledAt; null for other jobs', async () => {
    const registry = createRegistry({
        jobsByName: new Map(),
        maxConcurrency: 2,
        defaultTimeoutMs: null,
    });
    const ids = { report: 'report:schedule:tenant:42:2026-11-11T02:00:00.000Z', ping: 'ping:my-id' };
    const { store } = storeOfDueNames(['report', 'ping']);
    const claimDue = store.claimDue;
    /** @type {Record<string, Date | null>} */
    const seen = {};

    store.claimDue = async (params) => {
        const result = await claimDue(params);

        for (const job of result.jobs) {
            job.id = ids[/** @type {'report' | 'ping'} */ (job.name)];
        }

        return result;
    };

    for (const name of ['report', 'ping']) {
        registry.handle(name, ({ job }) => {
            seen[job.name] = job.scheduledAt;
        });
    }

    const runner = createRunner({
        store,
        registry,
        maxConcurrency: 2,
        defaults: resolveDefaults(),
        cleanup: false,
        logger: undefined,
        onEvent: undefined,
        hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
        hintsAfterCommit: false,
        timings: { pollIntervalMs: 60_000 },
    });

    try {
        await runner.start();
        await waitFor(() => Object.keys(seen).length === 2, 3000);

        expect(seen).toStrictEqual({ report: new Date('2026-11-11T02:00:00.000Z'), ping: null });
    } finally {
        await runner.close({ deadline: 0 });
    }
});

/**
 * A runner over a store that records its calls: one plain name and one name with mutex keys, each with due jobs.
 * @param {{ maxConcurrency?: number, names?: number, pointer?: number }} [options] `pointer`: where the ties start.
 * @returns {{ runner: import('./runner.js').Runner, calls: string[], requested: string[][] }}
 */
function recordingRunner({ maxConcurrency = 4, names = 2, pointer = 0 } = {}) {
    const registry = createRegistry({ jobsByName: new Map(), maxConcurrency, defaultTimeoutMs: null });
    /** @type {string[]} */
    const calls = [];
    /** @type {string[][]} */
    const requested = [];
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async (/** @type {string[] | null} */ probed) => {
            calls.push('probe');

            return (probed ?? registry.entries().map(entry => entry.name)).map(name => ({ name, delayMs: -1 }));
        },
        findCandidates: async () => {
            calls.push('findCandidates');

            return [{ id: 'keyed-1', name: 'keyed', runAtMs: 0 }];
        },
        claimDue: async (/** @type {import('./store/store.js').ClaimDueParams} */ { requests }) => {
            calls.push('claimDue');
            requested.push(requests.map(request => request.name));

            return { jobs: [], next: [] };
        },
        claim: async () => {
            calls.push('claim');

            return [];
        },
        findStaleJobs: async () => [],
        renewLeases: async () => new Set(),
    }));

    registry.handle(defineJob({ name: 'keyed', mutexKeys: () => ['k'], timeout: '1m' }), () => {});

    for (let index = 0; index < names - 1; index++) {
        registry.handle(`plain_${index}`, () => {});
    }

    const runner = createRunner({
        store,
        registry,
        maxConcurrency,
        defaults: resolveDefaults(),
        cleanup: false,
        logger: undefined,
        onEvent: undefined,
        hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
        hintsAfterCommit: false,
        timings: { pollIntervalMs: 60_000 },
        random: () => pointer / names,
    });

    return { runner, calls, requested };
}

test('fair share: findCandidates runs once per dispatch, before the claim of the plain names', async () => {
    const { runner, calls } = recordingRunner();

    try {
        await runner.start();
        await waitFor(() => calls.includes('claim'), 1000);

        expect(calls.slice(0, 4)).toStrictEqual(['probe', 'findCandidates', 'claimDue', 'claim']);
    } finally {
        await runner.close({ deadline: 0 });
    }
});

test('fair share: a claim requests at most 4 names per free slot, the furthest under their share first', async () => {
    // The ties start at plain_4: the plan gives the slot to the plain names
    const { runner, requested } = recordingRunner({ maxConcurrency: 1, names: 10, pointer: 5 });

    try {
        await runner.start();
        await waitFor(() => requested.length > 0, 1000);

        // 1 free slot: 4 names, from the pointer; the keyed one is claimed apart
        expect(requested[0]).toStrictEqual(['plain_4', 'plain_5', 'plain_6', 'plain_7']);
    } finally {
        await runner.close({ deadline: 0 });
    }
});

/**
 * A started runner over a store whose due jobs never run out: the test's handlers hold them. A plain name and a name
 * with mutex keys in one group, and an ungrouped name.
 * @param {{ maxConcurrency?: number, random?: () => number, groupCap?: number }} [options]
 * @returns {{ runner: import('./runner.js').Runner, registry: import('./registry.js').Registry,
 *     claims: import('./store/store.js').ClaimDueParams[], release: () => void }}
 */
function groupRunner({ maxConcurrency = 4, random = () => 0, groupCap = 2 } = {}) {
    const registry = createRegistry({ jobsByName: new Map(), maxConcurrency, defaultTimeoutMs: null });
    const pair = defineConcurrencyGroup({ name: 'pair', maxConcurrency: groupCap });
    /** @type {import('./store/store.js').ClaimDueParams[]} */
    const claims = [];
    /** @type {(() => void)[]} */
    const held = [];
    let id = 0;
    /**
     * @param {string} name
     * @returns {import('./store/store.js').StartableJob}
     */
    const jobOf = (name) => {
        id++;

        return {
            id: `${name}-${id}`, name, attempts: 0, maxAttempts: 1, stalls: 0, maxStalls: 1, failureJob: null,
            enqueuedAt: new Date(0), waitedMs: 0, mutexKeys: name === 'keyed' ? [`k${id}`] : [], lockToken: 't',
            payload: { found: true, payload: {} },
        };
    };
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async (/** @type {string[] | null} */ names) => (names ?? registry.entries().map(entry => entry.name))
            .map(name => ({ name, delayMs: -1 })),
        findCandidates: async (/** @type {Map<string, number>} */ limits) => Array.from(
            { length: limits.get('keyed') ?? 0 },
            (_, index) => ({ id: `c${index}`, name: 'keyed', runAtMs: 0 }),
        ),
        claimDue: async (/** @type {import('./store/store.js').ClaimDueParams} */ params) => {
            const { choose: _choose, ...copied } = params;

            claims.push(/** @type {import('./store/store.js').ClaimDueParams} */ (structuredClone(copied)));

            // As PostgreSQL: one row per request, in the order of the ties, within the rooms
            const jobs = params.requests.toSorted((a, b) => a.tie - b.tie).slice(0, params.free)
                .filter((request) => {
                    if (request.group === null) {
                        return true;
                    }

                    return params.groupRooms[request.group]-- > 0;
                })
                .map(request => jobOf(request.name));

            return { jobs, next: [], unpicked: [] };
        },
        claim: async (/** @type {import('./store/store.js').ClaimParams} */ { candidateIds, pick }) => pick(
            candidateIds.map(() => jobOf('keyed')),
            new Set(),
        ),
        readPayloads: async (/** @type {string[]} */ ids) => new Map(ids.map(jobId => [jobId, {}])),
        completeJobs: async (/** @type {unknown[]} */ jobs) => jobs.length,
        findStaleJobs: async () => [],
        renewLeases: async () => new Set(),
        namesWaitingFor: async () => [],
    }));
    const hold = () => new Promise((resolve) => {
        held.push(() => resolve(undefined));
    });

    registry.handle('plain', hold, { concurrencyGroup: pair });
    registry.handle(defineJob({ name: 'keyed', mutexKeys: () => ['k'], timeout: '1m' }), hold, {
        concurrencyGroup: pair,
    });
    registry.handle('free', hold);

    const runner = createRunner({
        store,
        registry,
        maxConcurrency,
        defaults: resolveDefaults(),
        cleanup: false,
        logger: undefined,
        onEvent: undefined,
        hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
        hintsAfterCommit: true,
        timings: { pollIntervalMs: 60_000 },
        random,
    });

    return {
        runner,
        registry,
        claims,
        release: () => {
            for (const resolve of held.splice(0)) {
                resolve();
            }
        },
    };
}

test('fair share: the plain claim leaves the share of the names with mutex keys in their group', async () => {
    const { runner, registry, claims, release } = groupRunner({ maxConcurrency: 4, groupCap: 2 });

    try {
        await runner.start();
        await waitFor(() => claims.length > 0, 1000);

        // The plan: plain, keyed, free, then free or plain... The group's 2 slots: 1 for keyed, 1 for plain
        const request = claims[0].requests.find(({ name }) => name === 'plain');

        expect(request?.maxJobs).toBe(1);
        expect(claims[0].groupRooms).toStrictEqual([1]);
        await waitFor(() => registry.getEntry('keyed')?.running === 1, 1000);
        expect(registry.getEntry('plain')?.running).toBe(1);
    } finally {
        release();
        await runner.close({ deadline: 0 });
    }
});

test('canStartNow: false for a name whose group is full, true for the others', async () => {
    const { runner, registry, release } = groupRunner({ maxConcurrency: 4, groupCap: 2 });

    try {
        expect(runner.canStartNow('free')).toBe(false);
        await runner.start();
        await waitFor(() => registry.getEntry('keyed')?.running === 1, 1000);

        expect(runner.canStartNow('plain')).toBe(false);
        expect(runner.canStartNow('keyed')).toBe(false);
        expect(runner.canStartNow('free')).toBe(true);
        expect(runner.canStartNow('unknown')).toBe(false);
    } finally {
        release();
        await runner.close({ deadline: 0 });
    }
});

test.each([
    { random: 0, ties: { plain: 0, keyed: 1, free: 2 } },
    { random: 0.5, ties: { plain: 2, keyed: 0, free: 1 } },
    { random: 0.99, ties: { plain: 1, keyed: 2, free: 0 } },
])('fair share: the tie pointer starts at floor(random() × names): $random', async ({ random, ties }) => {
    const { runner, claims, release } = groupRunner({ maxConcurrency: 10, groupCap: 10, random: () => random });

    try {
        await runner.start();
        await waitFor(() => claims.length > 0, 1000);

        // The plain names of the first claim: their tie order is (index − pointer) mod 3
        expect(Object.fromEntries(claims[0].requests.map(request => [request.name, request.tie])))
            .toStrictEqual({ plain: ties.plain, free: ties.free });
    } finally {
        release();
        await runner.close({ deadline: 0 });
    }
});

test('close(): the running counts of the names and of the groups go back to 0', async () => {
    const { runner, registry, release } = groupRunner({ maxConcurrency: 4, groupCap: 2 });

    await runner.start();
    // The store gives one job per requested name
    await waitFor(() => registry.entries().every(entry => entry.running === 1), 1000);
    expect(registry.getEntry('plain')?.group?.running).toBe(2);

    const closed = runner.close({ deadline: 1000 });

    release();
    await closed;

    expect(registry.entries().map(entry => entry.running)).toStrictEqual([0, 0, 0]);
    expect(registry.getEntry('plain')?.group?.running).toBe(0);
});

/**
 * A started runner of the name `ping`, always due, whose claims fail as given, then succeed. `trace` records, in order,
 * each claim (`claim`, `claim:ok` for a success), each retry at once (`retry`, its debug log) and each error event
 * (`error`): the tests check its exact prefix, not wall times, so a slow machine cannot change what they see.
 * @param {(Error | null)[]} errors The error of each claim, one after the other (null: it succeeds); the claims after
 *     them succeed.
 * @returns {Promise<{ runner: import('./runner.js').Runner, events: import('./types.js').SqlaneEvent[],
 *     claimTimes: number[], trace: string[],
 *     logger: Record<'debug' | 'info' | 'warn' | 'error', import('vitest').Mock> }>}
 */
async function runnerWithClaims(errors) {
    const registry = createRegistry({
        jobsByName: new Map(),
        maxConcurrency: 10,
        defaultTimeoutMs: null,
    });
    /** @type {import('./types.js').SqlaneEvent[]} */
    const events = [];
    /** @type {number[]} */
    const claimTimes = [];
    /** @type {string[]} */
    const trace = [];
    const logger = { debug: vi.fn(() => trace.push('retry')), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async () => [{ name: 'ping', delayMs: 0 }],
        claimDue: async () => {
            const error = errors[claimTimes.length] ?? null;

            claimTimes.push(Date.now());
            trace.push(error ? 'claim' : 'claim:ok');

            if (error) {
                throw error;
            }

            // Due again at the next full probe
            return { jobs: [], next: [{ name: 'ping', delayMs: 60_000 }] };
        },
    }));

    registry.handle('ping', () => {});

    const runner = createRunner({
        store,
        registry,
        maxConcurrency: 10,
        defaults: resolveDefaults(),
        cleanup: false,
        logger,
        onEvent: (event) => {
            events.push(event);

            if (event.type === 'error') {
                trace.push('error');
            }
        },
        hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
        hintsAfterCommit: false,
        timings: { pollIntervalMs: 300 },
    });

    await runner.start();

    return { runner, events, claimTimes, trace, logger };
}

/**
 * Waits for the n-th successful claim.
 * @param {string[]} trace
 * @param {number} count
 * @returns {Promise<void>}
 */
async function successfulClaims(trace, count) {
    await waitFor(() => trace.filter(entry => entry === 'claim:ok').length >= count, 10_000);
}

const checkRead = () => Object.assign(new Error('Record has changed since last read'), {
    code: 'ER_CHECKREAD',
    errno: 1020,
});
const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock'), { errno: 1213 });
/** Three transient errors and a retry at once after each, then the claim that succeeds */
const RETRIED_THREE_TIMES = ['claim', 'retry', 'claim', 'retry', 'claim', 'retry'];

test('dispatch: a transient error is retried at once, logged at debug, with no error event', async () => {
    const { runner, events, trace, logger } = await runnerWithClaims([checkRead(), deadlock(), checkRead()]);

    try {
        await successfulClaims(trace, 1);

        // Three retries, no error event (a back-off comes only after one)
        expect(trace.slice(0, 7)).toStrictEqual([...RETRIED_THREE_TIMES, 'claim:ok']);
        expect(events.filter(event => event.type === 'error')).toStrictEqual([]);
        expect(logger.debug).toHaveBeenCalledTimes(3);
        expect(logger.debug).toHaveBeenLastCalledWith(
            expect.objectContaining({ operation: 'dispatch', retry: 3 }),
            expect.any(String),
        );
        expect(logger.error).not.toHaveBeenCalled();
    } finally {
        await runner.close({ deadline: 0 });
    }
});

test('dispatch: a transient error after 3 retries is reported and backed off, then retried again', async () => {
    const { runner, events, claimTimes, trace } = await runnerWithClaims(Array.from({ length: 8 }, checkRead));

    try {
        await successfulClaims(trace, 1);

        // 1 + 3 retries, the error, the back-off, 1 + 3 retries, the error, the back-off, the claim
        expect(trace.slice(0, 17)).toStrictEqual([
            ...RETRIED_THREE_TIMES, 'claim', 'error',
            ...RETRIED_THREE_TIMES, 'claim', 'error',
            'claim:ok',
        ]);
        // The back-off: min(the poll interval, 1 s); a slow machine only makes it longer
        expect(claimTimes[4] - claimTimes[3]).toBeGreaterThanOrEqual(250);
        expect(claimTimes[8] - claimTimes[7]).toBeGreaterThanOrEqual(250);
        expect(events.filter(event => event.type === 'error')).toMatchObject([
            { operation: 'dispatch', error: { errno: 1020 } },
            { operation: 'dispatch', error: { errno: 1020 } },
        ]);
    } finally {
        await runner.close({ deadline: 0 });
    }
});

test('dispatch: the retries start again after a turn that succeeds', async () => {
    // Three errors, a success, three errors, a success: never four in a row
    const errors = [deadlock(), deadlock(), deadlock()];
    const { runner, events, trace } = await runnerWithClaims([...errors, null, ...errors]);

    try {
        await successfulClaims(trace, 2);

        expect(trace.slice(0, 14)).toStrictEqual([
            ...RETRIED_THREE_TIMES, 'claim:ok',
            ...RETRIED_THREE_TIMES, 'claim:ok',
        ]);
        expect(events.filter(event => event.type === 'error')).toStrictEqual([]);
    } finally {
        await runner.close({ deadline: 0 });
    }
});

test.each([
    ['another error', new Error('syntax error')],
    ['a lock wait timeout', Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), {
        code: 'ER_LOCK_WAIT_TIMEOUT',
        errno: 1205,
    })],
])('dispatch: %s is not retried at once: reported and backed off', async (_, error) => {
    const { runner, events, claimTimes, trace, logger } = await runnerWithClaims([error]);

    try {
        await successfulClaims(trace, 1);

        expect(trace.slice(0, 3)).toStrictEqual(['claim', 'error', 'claim:ok']);
        expect(claimTimes[1] - claimTimes[0]).toBeGreaterThanOrEqual(250);
        expect(events.filter(event => event.type === 'error')).toMatchObject([{ operation: 'dispatch', error }]);
        expect(logger.debug).not.toHaveBeenCalled();
    } finally {
        await runner.close({ deadline: 0 });
    }
});
