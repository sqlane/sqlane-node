import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { resolveDefaults } from './defaults.js';
import { LeaseLostError, ShutdownError } from './errors.js';
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
        claimDue: async () => [],
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
 * @property {() => number} probes The probes so far.
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
    let probes = 0;
    /** @type {((message: string) => void) | null} */
    let deliver = null;
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async () => {
            probes++;

            return [];
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

    return { runner, probes: () => probes, deliver: name => deliver?.(name) };
}

test.each([
    { hint: 'NOTIFY, after the commit: probes at once', hintsAfterCommit: true, probes: 1 },
    { hint: 'other, before the commit: re-probes from 20 ms', hintsAfterCommit: false, probes: 0 },
])('a hint: $hint', async ({ hintsAfterCommit, probes: expected }) => {
    const { runner, probes, deliver } = await runnerWithHint(hintsAfterCommit);
    const before = probes();

    deliver('ping');
    await sleep(10);
    expect(probes() - before).toBe(expected);
    await runner.close({ deadline: 0 });
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

            return claimed;
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
