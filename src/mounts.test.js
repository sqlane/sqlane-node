import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveDefaults } from './defaults.js';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
import { defineHandler } from './define_handler.js';
import { defineLane } from './define_lane.js';
import { defineSchedule } from './define_schedule.js';
import { ConfigError } from './errors.js';
import { createHintChannel } from './hint_channel.js';
import { createMounts } from './mounts.js';
import { createRegistry } from './registry.js';
import { createRunner } from './runner.js';
import { createScheduler } from './scheduler.js';

/** A stall recovery that finds no work */
const NO_RECOVERY_WORK = { stale: [], lingers: false, orphans: false, blocked: false, idleRateKeys: false };

/**
 * @typedef {import('./store/store.js').ClaimedJob & { payload: { found: boolean, payload: unknown } }} FakeJob
 */

/**
 * @typedef {object} Harness
 * @property {import('./runner.js').Runner} runner
 * @property {import('./registry.js').Registry} registry
 * @property {import('./scheduler.js').Scheduler} scheduler
 * @property {import('./mounts.js').Mounts} mounts
 * @property {(lane: string, options?: { limits?: { key: string, max: number }[], delayMs?: number }) => void} addJob
 *     `delayMs`: due after it.
 * @property {import('./store/store.js').DueRequest[][]} claims The requests of each plain claim.
 * @property {(string[] | null)[]} probes The lanes of each probe.
 * @property {string[]} fires The schedule ids of each fire.
 * @property {{ claimDue: Promise<void> | null, findCandidates: Promise<void> | null, probe: Promise<void> | null }}
 *     holds Held awaits of the store.
 * @property {{ onProbe: ((lanes: string[] | null) => void) | null }} hooks Called by the store.
 * @property {() => number} turns The full turns of the dispatcher so far: its reads of the handled lanes.
 */

/** @type {Harness[]} */
let harnesses = [];

afterEach(async () => {
    await Promise.all(harnesses.flatMap(({ runner, scheduler }) => [runner.close({ deadline: 0 }), scheduler.stop()]));
    harnesses = [];
});

/**
 * A runner, a scheduler and their mounts over a store of jobs in memory.
 * @param {{ localMaxConcurrency?: number, random?: () => number }} [options]
 * @returns {Harness}
 */
function harness({ localMaxConcurrency = 10, random = () => 0 } = {}) {
    const registry = createRegistry({ lanesByName: new Map(), defaultTimeoutMs: null });
    /** @type {FakeJob[]} */
    const pending = [];
    /** @type {import('./store/store.js').DueRequest[][]} */
    const claims = [];
    /** @type {(string[] | null)[]} */
    const probes = [];
    /** @type {string[]} */
    const fires = [];
    /** @type {Harness['holds']} */
    const holds = { claimDue: null, findCandidates: null, probe: null };
    /** @type {Harness['hooks']} */
    const hooks = { onProbe: null };
    let ids = 0;
    let turns = 0;
    const readEntries = registry.entries;

    registry.entries = () => {
        turns++;

        return readEntries();
    };
    const store = /** @type {import('./store/store.js').Store} */ (/** @type {unknown} */ ({
        probe: async (/** @type {string[] | null} */ lanes) => {
            probes.push(lanes);
            await holds.probe;
            hooks.onProbe?.(lanes);

            /** @type {Map<string, number>} The earliest due time of each lane */
            const dueAt = new Map();

            for (const job of pending.filter(each => lanes === null || lanes.includes(each.lane))) {
                dueAt.set(job.lane, Math.min(dueAt.get(job.lane) ?? Infinity, job.runAt.getTime()));
            }

            return [...dueAt].map(([name, at]) => ({ name, delayMs: Math.max(0, at - Date.now()) }));
        },
        claimDue: async (/** @type {import('./store/store.js').ClaimDueParams} */ { requests }) => {
            claims.push(requests);
            await holds.claimDue;

            /** @type {FakeJob[]} */
            const jobs = [];

            for (const request of requests) {
                const due = pending.filter(job => job.lane === request.name && job.runAt.getTime() <= Date.now())
                    .slice(0, request.maxJobs);

                for (const job of due) {
                    pending.splice(pending.indexOf(job), 1);
                }

                jobs.push(...due);
            }

            return { jobs, next: [], limited: [] };
        },
        findCandidates: async (/** @type {Map<string, number>} */ limits) => {
            await holds.findCandidates;

            return {
                startable: pending.filter(job => limits.has(job.lane))
                    .map(job => ({ id: job.id, lane: job.lane, runAtMs: 0 })),
                full: [],
            };
        },
        claim: async (/** @type {import('./store/store.js').ClaimParams} */ { candidateIds, pick }) => {
            const locked = pending.filter(job => candidateIds.includes(job.id));
            const picked = pick(locked, new Map(), new Map());

            for (const job of picked) {
                pending.splice(pending.indexOf(/** @type {FakeJob} */ (job)), 1);
            }

            return { jobs: picked, blockedKeys: [], blockedLanes: [], rateWaits: [] };
        },
        readPayloads: async (/** @type {string[]} */ jobIds) => new Map(jobIds.map(id => [id, null])),
        completeJobs: async (/** @type {unknown[]} */ jobs) => jobs.length,
        renewLeases: async (/** @type {{ id: string }[]} */ jobs) => new Set(jobs.map(job => job.id)),
        releaseJob: async () => true,
        unblock: async () => [],
        findRecoveryWork: async () => NO_RECOVERY_WORK,
        registerSchedules: async (/** @type {{ id: string, lane: string, spec: string }[]} */ entries) => ({
            clock: { dbNowMs: Date.now(), sentAt: Date.now(), receivedAt: Date.now() },
            rows: entries.map(({ id, lane, spec }) => ({ id, lane, spec, lastSlotMs: Date.now(), lastJobId: null })),
        }),
        fireSlots: async (/** @type {import('./store/fire_slots.js').FireParams} */ { candidates, buildJob }) => {
            fires.push(...candidates.map(({ id }) => id));

            return {
                clock: { dbNowMs: Date.now(), sentAt: Date.now(), receivedAt: Date.now() },
                decided: candidates.map(candidate => ({
                    id: candidate.id,
                    lane: candidate.lane,
                    slot: candidate.slot,
                    late: false,
                    outcome: /** @type {const} */ ('enqueued'),
                    jobId: buildJob(candidate, false).id,
                    created: true,
                })),
                busy: [],
                deferred: [],
            };
        },
    }));
    const runner = createRunner({
        store,
        registry,
        localMaxConcurrency,
        defaults: resolveDefaults(),
        cleanup: false,
        logger: undefined,
        onEvent: undefined,
        hintChannel: createHintChannel({ hint: null, channel: 'c', reportError: () => {} }),
        hintsAfterCommit: false,
        timings: { pollIntervalMs: 60_000 },
        random,
    });
    const scheduler = createScheduler({
        store,
        defaults: resolveDefaults(),
        maxPayloadBytes: 1024,
        findDefinition: registry.findDefinition,
        unknownLanes: 'allow',
        notifyChannel: null,
        onCreated: () => {},
        emit: () => {},
        logger: undefined,
    });
    const mounts = createMounts({ registry, scheduler, runner });
    /** @type {Harness} */
    const made = {
        runner,
        registry,
        scheduler,
        mounts,
        claims,
        probes,
        fires,
        holds,
        hooks,
        turns: () => turns,
        addJob: (lane, { limits = [], delayMs = 0 } = {}) => {
            ids++;
            pending.push({
                id: `job-${ids}`,
                lane,
                limits,
                rateLimits: [],
                attempts: 0,
                maxAttempts: 3,
                stalls: 0,
                maxStalls: 2,
                enqueuedAt: new Date(),
                runAt: new Date(delayMs ? Date.now() + delayMs : 0),
                startedAt: new Date(0),
                waitedMs: 0,
                lockToken: `token-${ids}`,
                payload: { found: true, payload: null },
            });
        },
    };

    harnesses.push(made);

    return made;
}

/**
 * @param {() => boolean} condition
 * @returns {Promise<void>}
 */
async function waitFor(condition) {
    const deadline = Date.now() + 2000;

    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor: timed out');
        }

        // oxlint-disable-next-line no-await-in-loop -- polls
        await sleep(5);
    }
}

/**
 * A handler that records its calls and holds its jobs until `release()`.
 * @returns {{ handler: import('./types.js').Handler, calls: string[], release: () => void }}
 */
function heldHandler() {
    const held = Promise.withResolvers();
    /** @type {string[]} */
    const calls = [];

    return {
        handler: async ({ job }) => {
            calls.push(job.id);
            await held.promise;
        },
        calls,
        release: () => held.resolve(undefined),
    };
}

const ping = defineLane({ name: 'ping' });
const pong = defineLane({ name: 'pong' });

describe('mount and unmount', () => {
    test('a mount after start() claims its due jobs at once, before the next poll', async () => {
        const { runner, mounts, addJob } = harness();
        const { handler, calls, release } = heldHandler();

        await runner.start();
        addJob('ping');
        mounts.mount([defineHandler(ping, handler)]);
        await waitFor(() => calls.length === 1);
        expect(calls).toStrictEqual(['job-1']);
        release();
    });

    test('an unmount during the plain claim: the claimed job runs with the handler of the claim', async () => {
        const { runner, mounts, addJob, holds, registry } = harness();
        const first = heldHandler();
        const second = heldHandler();
        const claimDue = Promise.withResolvers();

        holds.claimDue = claimDue.promise;
        addJob('ping');

        const mount = mounts.mount([defineHandler(ping, first.handler)]);

        await runner.start();
        await sleep(20);
        expect(registry.span()).toBe(1);
        mount.unmount();
        mounts.mount([defineHandler(ping, second.handler)]);
        claimDue.resolve(undefined);
        await waitFor(() => first.calls.length === 1);
        expect(second.calls).toStrictEqual([]);
        first.release();
        second.release();
    });

    test('an unmount between the awaits of the keyed claim: the claimed job runs with the handler of the claim',
        async () => {
            const keyed = defineLane({ name: 'keyed', timeout: '1m', globalConcurrencyLimits: () => [] });
            const { runner, mounts, addJob, holds } = harness();
            const first = heldHandler();
            const findCandidates = Promise.withResolvers();

            holds.findCandidates = findCandidates.promise;
            addJob('keyed', { limits: [{ key: 'k:1', max: 1 }] });

            const mount = mounts.mount([defineHandler(keyed, first.handler)]);

            await runner.start();
            await sleep(20);
            mount.unmount();
            findCandidates.resolve(undefined);
            await waitFor(() => first.calls.length === 1);
            expect(first.calls).toStrictEqual(['job-1']);
            first.release();
        });

    test('a remount while old jobs run: they count toward the new handler, its limits and its share', async () => {
        const heavy = defineConcurrencyLimit({ name: 'heavy', max: 2 });
        const { runner, mounts, addJob, registry, claims } = harness();
        const first = heldHandler();
        const second = heldHandler();

        addJob('ping');

        const mount = mounts.mount([defineHandler(ping, first.handler, { localConcurrencyLimits: [heavy] })]);

        await runner.start();
        await waitFor(() => first.calls.length === 1);
        mount.unmount();
        expect(registry.runningOf('ping')).toBe(1);

        mounts.mount([
            defineHandler(ping, second.handler, { localConcurrencyLimits: [heavy] }),
            defineHandler(pong, second.handler),
        ]);
        addJob('ping');
        addJob('ping');
        addJob('pong');
        runner.added([]);

        const entry = /** @type {import('./registry.js').HandlerEntry} */ (registry.getEntry('ping'));

        expect(entry.running).toBe(1);
        expect(entry.index).toBe(1);
        expect(registry.span()).toBe(3);
        // The old job holds one of the 2 slots of heavy: one more job of ping starts
        await waitFor(() => second.calls.length === 2);
        await sleep(20);
        expect(second.calls).toHaveLength(2);
        expect(entry.limits[0].running).toBe(2);
        // The ties of the requests: (index − pointer) mod the span, over the indexes given so far
        const last = /** @type {import('./store/store.js').DueRequest[]} */ (claims.at(-1));

        expect(last.map(({ name, tie, running }) => ({ name, tie, running }))).toStrictEqual(
            expect.arrayContaining([{ name: 'ping', tie: expect.any(Number), running: 1 }]),
        );

        for (const request of last) {
            expect(request.tie).toBeLessThan(3);
        }

        first.release();
        second.release();
        await waitFor(() => registry.runningOf('ping') === 0);
        expect(entry.limits[0].running).toBe(0);
    });

    test('a schedule mounted without the handler of its lane fires; its unmount stops it', async () => {
        const { scheduler, mounts, fires, registry } = harness();
        const tick = defineSchedule(ping, { key: 'tick', every: '1s' });

        scheduler.start(null);

        const mount = mounts.mount([tick]);

        expect(registry.getEntry('ping')).toBeUndefined();
        await waitFor(() => fires.length > 0);
        mount.unmount();
        mount.unmount();
        expect(scheduler.has('ping:tick')).toBe(false);
        expect(mounts.hasSchedule('ping:tick')).toBe(false);
    });

    test('unmount() is idempotent; the lane can be mounted again at once, with another handler', () => {
        const { mounts, registry } = harness();
        const mount = mounts.mount([defineHandler(ping, () => {})]);

        mount.unmount();
        mount.unmount();
        expect(registry.getEntry('ping')).toBeUndefined();
        expect(() => mounts.mount([defineHandler(ping, () => {})])).not.toThrow();
    });
});

describe('the checks of a mount: a ConfigError, and nothing is mounted', () => {
    const failed = defineLane({ name: 'failed' });
    const otherPing = defineLane({ name: 'ping', maxAttempts: 5 });
    const keyed = defineLane({ name: 'keyed', globalConcurrencyLimits: () => [] });
    const heavy2 = defineConcurrencyLimit({ name: 'heavy', max: 2 });
    const heavy3 = defineConcurrencyLimit({ name: 'heavy', max: 3 });

    const notParts = /** @type {any} */ (defineHandler(ping, () => {}));
    const notPart = /** @type {any} */ (ping);

    test.each([
        ['parts that are not an array', () => [notParts], 'the parts must be an array'],
        ['a part that is a lane', () => [[notPart]], 'a part must be a handler from defineHandler()'],
        ['a lane handled here already', () => [[defineHandler(ping, () => {})], [defineHandler(ping, () => {})]],
            'the lane "ping" is handled here already'],
        ['a lane twice in one mount', () => [[defineHandler(ping, () => {}), defineHandler(ping, () => {})]],
            'the lane "ping" is handled here already'],
        ['a schedule mounted here already', () => [
            [defineSchedule(ping, { key: 'a', every: '1m' })],
            [defineSchedule(ping, { key: 'a', every: '1h' })],
        ], 'the schedule "ping:a" is mounted here already'],
        ['two definitions of one lane, in a schedule and a handler', () => [
            [defineSchedule(ping, { key: 'a', every: '1m' })],
            [defineHandler(otherPing, () => {})],
        ], 'two different definitions of the lane "ping"'],
        ['two definitions of one lane, as a failure lane', () => [
            [defineHandler(failed, () => {})],
            [defineHandler(defineLane({ name: 'pang', failureLane: defineLane({ name: 'failed' }) }), () => {})],
        ], 'two different definitions of the lane "failed"'],
        ['a failure lane with a failure lane', () => [[
            defineHandler(defineLane({ name: 'pang', failureLane: defineLane({ name: 'f', failureLane: 'g' }) }), () => {}),
        ]], 'the failure lane "f" of "pang" has a failure lane of its own'],
        ['local settings in the definition and the handler', () => [[
            defineHandler(defineLane({ name: 'pang', fairShareWeight: 2 }), () => {}, { fairShareWeight: 3 }),
        ]], 'are in its definition and in its handler'],
        ['two maxes of one local limit', () => [
            [defineHandler(ping, () => {}, { localConcurrencyLimits: [heavy2] })],
            [defineHandler(pong, () => {}, { localConcurrencyLimits: [heavy3] })],
        ], 'the concurrency limit "heavy" has the max 3 here and 2 in another definition'],
        ['global limits without a timeout', () => [[defineHandler(keyed, () => {})]], 'needs a timeout'],
        ['a schedule whose job is too large', () => [[
            defineSchedule(ping, { key: 'big', every: '1m', payload: { text: 'x'.repeat(2000) } }),
        ]], 'the schedule "ping:big"'],
    ])('%s', (_, partsOf, message) => {
        const { mounts, registry, scheduler } = harness();
        const all = partsOf();
        const last = /** @type {unknown} */ (all.pop());
        const before = all.map(parts => mounts.mount(parts));
        const span = registry.span();

        expect(() => mounts.mount(last)).toThrow(ConfigError);
        expect(() => mounts.mount(last)).toThrow(message);
        expect(registry.span()).toBe(span);
        expect(registry.entries()).toHaveLength(before.flatMap(mount => mount.entries).length);
        expect(scheduler.size()).toBe(before.flatMap(mount => mount.schedules).length);
    });

    test('the same definition in several mounts is fine; a definition is free again after its last unmount', () => {
        const { mounts } = harness();
        const first = mounts.mount([defineHandler(ping, () => {})]);
        const second = mounts.mount([defineSchedule(ping, { key: 'a', every: '1m' })]);

        expect(() => mounts.mount([defineSchedule(otherPing, { key: 'b', every: '1m' })])).toThrow(ConfigError);
        first.unmount();
        expect(() => mounts.mount([defineSchedule(otherPing, { key: 'b', every: '1m' })])).toThrow(ConfigError);
        second.unmount();
        expect(() => mounts.mount([defineSchedule(otherPing, { key: 'b', every: '1m' })])).not.toThrow();
    });
});

describe('no busy loop', () => {
    test('a lane whose due time comes while no slot is free waits for a free slot, not in a loop', async () => {
        const { runner, mounts, addJob } = harness({ localMaxConcurrency: 1 });
        const { handler, calls, release } = heldHandler();
        /** @type {string[]} */
        const later = [];

        mounts.mount([
            defineHandler(ping, handler),
            defineHandler(pong, ({ job }) => {
                later.push(job.id);
            }),
        ]);
        addJob('ping');
        addJob('pong', { delayMs: 30 });
        await runner.start();
        await waitFor(() => calls.length === 1);
        await sleep(50);

        // Each turn of the dispatcher reads the clock: the cap is full, pong waits for the end of ping
        const clock = vi.spyOn(Date, 'now');

        try {
            await sleep(200);
            expect(clock.mock.calls.length).toBeLessThan(20);
        } finally {
            clock.mockRestore();
        }

        release();
        await waitFor(() => later.length === 1);
        expect(later).toStrictEqual(['job-2']);
    });

    test('a runner started before its first mount sleeps until the poll; a mount wakes it', async () => {
        const { runner, mounts, addJob, turns } = harness();
        const { handler, calls, release } = heldHandler();

        await runner.start();
        await sleep(20);

        const before = turns();

        await sleep(100);
        expect(turns() - before).toBe(0);
        addJob('ping');
        mounts.mount([defineHandler(ping, handler)]);
        await waitFor(() => calls.length === 1);
        release();
    });

    test('a runner whose only lane is paused here sleeps until the poll', async () => {
        const { runner, mounts, turns, probes } = harness();

        runner.pauseLocally('ping');
        mounts.mount([defineHandler(ping, () => {})]);
        await runner.start();
        await sleep(20);

        const before = turns();

        await sleep(100);
        expect(turns() - before).toBe(0);
        // A full probe reads every lane: none while no lane can run here
        expect(probes).toStrictEqual([]);
    });
});

describe('local pause', () => {
    test('before the mount, and across an unmount and a mount: no probe or claim of the lane', async () => {
        const { runner, mounts, addJob, claims, probes } = harness();
        const { handler, calls, release } = heldHandler();

        runner.pauseLocally('ping');
        addJob('ping');

        const mount = mounts.mount([defineHandler(ping, handler)]);

        await runner.start();
        await sleep(50);
        mount.unmount();
        mounts.mount([defineHandler(ping, handler)]);
        // The wakes: an enqueue of the lane that committed, a wake of all lanes
        runner.onCommitted(['ping']);
        runner.wake();
        await sleep(50);
        expect(calls).toStrictEqual([]);
        expect(claims.flat().filter(({ name }) => name === 'ping')).toStrictEqual([]);
        expect(probes).toStrictEqual([]);
        expect(runner.isPausedLocally('ping')).toBe(true);
        expect(runner.canStartNow('ping')).toBe(false);

        runner.resumeLocally('ping');
        await waitFor(() => calls.length === 1);
        release();
    });

    test('a wake of the lane by a job that frees a local limit that it shares: no probe of the paused lane', async () => {
        const one = defineConcurrencyLimit({ name: 'one', max: 1 });
        const { runner, mounts, addJob, probes } = harness();
        let done = 0;

        runner.pauseLocally('ping');
        mounts.mount([
            defineHandler(ping, () => {}, { localConcurrencyLimits: [one] }),
            defineHandler(pong, () => {
                done++;
            }, { localConcurrencyLimits: [one] }),
        ]);
        addJob('ping');
        addJob('pong');
        await runner.start();
        await waitFor(() => done === 1);
        await sleep(50);
        expect(probes.flat().filter(lane => lane === 'ping')).toStrictEqual([]);
    });

    test('an enqueue of a paused lane wakes nothing in this process', async () => {
        const { runner, mounts } = harness();

        mounts.mount([defineHandler(ping, () => {})]);
        await runner.start();
        await sleep(50);
        runner.pauseLocally('ping');

        // Each turn of the dispatcher reads the clock: an enqueue of a paused lane makes none
        const clock = vi.spyOn(Date, 'now');

        try {
            for (let index = 0; index < 5; index++) {
                runner.onCommitted(['ping']);
                // oxlint-disable-next-line no-await-in-loop -- one enqueue after the other
                await sleep(5);
            }

            expect(clock).not.toHaveBeenCalled();
        } finally {
            clock.mockRestore();
        }
    });

    test('a pause during the probe of a turn: the claim of the turn leaves the lane out', async () => {
        const { runner, mounts, addJob, claims, holds, hooks } = harness();
        const probe = Promise.withResolvers();

        mounts.mount([defineHandler(ping, () => {}), defineHandler(pong, () => {})]);
        addJob('ping');
        addJob('pong');
        holds.probe = probe.promise;
        hooks.onProbe = () => runner.pauseLocally('ping');
        await runner.start();
        await sleep(20);
        probe.resolve(undefined);
        await waitFor(() => claims.length > 0);
        expect(claims.flat().map(({ name }) => name)).toStrictEqual(['pong']);
    });

    test('drain(): a pause between the probe and the claim of a round leaves the lane out of the claim', async () => {
        const { runner, mounts, addJob, claims, hooks } = harness();

        mounts.mount([defineHandler(ping, () => {}), defineHandler(pong, () => {})]);
        addJob('ping');
        addJob('pong');
        hooks.onProbe = () => runner.pauseLocally('ping');
        await expect(runner.drain({ timeout: '2s' })).resolves.toMatchObject({ completed: 1 });
        expect(claims.flat().map(({ name }) => name)).toStrictEqual(['pong']);
    });

    test('drain(): a paused lane is left out; a pause during drain() holds from its next round', async () => {
        const { runner, mounts, addJob } = harness();
        /** @type {string[]} */
        const ran = [];

        mounts.mount([
            defineHandler(ping, ({ job }) => {
                ran.push(job.id);
                runner.pauseLocally('pong');
                addJob('pong');
            }),
            defineHandler(pong, ({ job }) => {
                ran.push(job.id);
            }),
        ]);
        addJob('ping');
        await expect(runner.drain({ timeout: '2s' })).resolves.toMatchObject({ completed: 1 });
        expect(ran).toStrictEqual(['job-1']);
        runner.resumeLocally('pong');
        await expect(runner.drain({ timeout: '2s' })).resolves.toMatchObject({ completed: 1 });
        expect(ran).toStrictEqual(['job-1', 'job-2']);
    });
});
