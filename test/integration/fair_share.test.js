import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { ConfigError, createSqlane, defineConcurrencyGroup, defineJob } from '../../src/index.js';
import { createStore } from '../../src/store/store.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @typedef {import('../../src/types.js').Sqlane<any>} Sqlane */

const TIMINGS = { leaseMs: 5000, renewIntervalMs: 500, recoveryIntervalMs: 500 };

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
let prefixCount = 0;
/** @type {Sqlane[]} */
let instances = [];

beforeAll(async () => {
    database = await connectTestDatabase();
    testAdapter = createTestAdapter();
});

afterEach(async () => {
    await Promise.all(instances.map(sqlane => sqlane.close({ deadline: 0, mode: 'abandon' })));
    instances = [];
});

afterAll(async () => {
    await testAdapter?.close();
    await database?.close();
});

/** @returns {string} A table prefix of its own. */
function nextPrefix() {
    prefixCount++;

    return `${database.tablePrefix}${prefixCount}_`;
}

/**
 * An instance whose tie pointer starts at the first handled name.
 * @param {string} p
 * @param {Record<string, unknown>} [options]
 * @returns {Sqlane}
 */
function instanceOn(p, options = {}) {
    const { timings, ...rest } = /** @type {{ timings?: object }} */ (options);
    const sqlane = createSqlane(/** @type {any} */ ({
        adapter: testAdapter.adapter,
        tablePrefix: p,
        pollInterval: '100ms',
        timings: { ...TIMINGS, random: () => 0, ...timings },
        ...rest,
    }));

    instances.push(sqlane);

    return sqlane;
}

/**
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{ sqlane: Sqlane, p: string }>} Migrated.
 */
async function freshSqlane(options = {}) {
    const p = nextPrefix();
    const sqlane = instanceOn(p, options);

    await sqlane.migrate();

    return { sqlane, p };
}

/**
 * @param {() => boolean | Promise<boolean>} condition
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitFor(condition, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;

    // oxlint-disable-next-line no-await-in-loop -- polls
    while (!await condition()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor: timed out');
        }

        // oxlint-disable-next-line no-await-in-loop -- polls
        await sleep(10);
    }
}

/**
 * Handlers that hold their jobs until the test releases them, and count the running jobs of each name.
 * @returns {{
 *     handler: (name: string) => import('../../src/types.js').Handler,
 *     running: Record<string, number>,
 *     started: string[],
 *     release: (name: string, count?: number) => void,
 *     releaseAll: () => void,
 *     samples: Record<string, number>[],
 * }}
 */
function holdingHandlers() {
    /** @type {{ name: string, release: () => void }[]} */
    const held = [];
    /** @type {Record<string, number>} */
    const running = {};
    /** @type {string[]} */
    const started = [];
    /** @type {Record<string, number>[]} */
    const samples = [];

    return {
        running,
        started,
        samples,
        handler: name => async () => {
            const { promise, resolve } = Promise.withResolvers();

            running[name] = (running[name] ?? 0) + 1;
            started.push(name);
            samples.push({ ...running });
            held.push({ name, release: () => resolve(undefined) });
            await promise;
            running[name]--;
        },
        release: (name, count = 1) => {
            for (let index = 0; index < count; index++) {
                const at = held.findIndex(job => job.name === name);

                held.splice(at, 1)[0]?.release();
            }
        },
        releaseAll: () => {
            for (const job of held.splice(0)) {
                job.release();
            }
        },
    };
}

/**
 * @param {Sqlane} sqlane
 * @param {string} name
 * @param {number} count
 * @returns {Promise<void>}
 */
async function enqueue(sqlane, name, count) {
    await sqlane.enqueueMany(testAdapter.pool, name, Array.from({ length: count }, () => ({ payload: {} })));
}

/**
 * @param {Record<string, number>[]} samples The running counts at each start.
 * @param {string[]} names
 * @returns {number} The most jobs of the names that ran at once.
 */
function maxRunning(samples, names) {
    let most = 0;

    for (const sample of samples) {
        let sum = 0;

        for (const name of names) {
            sum += sample[name] ?? 0;
        }

        most = Math.max(most, sum);
    }

    return most;
}

/**
 * Releases one held job of the name, and waits for the next start.
 * @param {ReturnType<typeof holdingHandlers>} jobs
 * @param {string} name
 * @returns {Promise<string | undefined>} The name that started.
 */
async function releaseOne(jobs, name) {
    const count = jobs.started.length;

    jobs.release(name);
    await waitFor(() => jobs.started.length === count + 1);

    return jobs.started.at(-1);
}

describe('the worked examples', () => {
    test('weights 3:1 on 8 slots: 6 and 2 running; a release goes back to its name', async () => {
        const { sqlane } = await freshSqlane({ maxConcurrency: 8 });
        const jobs = holdingHandlers();

        sqlane.handle('a', jobs.handler('a'), { fairShareWeight: 3 });
        sqlane.handle('b', jobs.handler('b'));
        await enqueue(sqlane, 'a', 20);
        await enqueue(sqlane, 'b', 20);
        await sqlane.start();
        await waitFor(() => jobs.started.length === 8);
        expect(jobs.running).toStrictEqual({ a: 6, b: 2 });

        jobs.release('a');
        await waitFor(() => jobs.started.length === 9);
        expect(jobs.running).toStrictEqual({ a: 6, b: 2 });
        jobs.release('b');
        await waitFor(() => jobs.started.length === 10);
        expect(jobs.running).toStrictEqual({ a: 6, b: 2 });
        jobs.releaseAll();
    });

    test('A\'s 10 jobs then B\'s 3, maxConcurrency 4, one completion at a time: B takes the next two slots', async () => {
        const { sqlane } = await freshSqlane({ maxConcurrency: 4 });
        const jobs = holdingHandlers();

        sqlane.handle('a', jobs.handler('a'));
        sqlane.handle('b', jobs.handler('b'));
        await enqueue(sqlane, 'a', 10);
        await sqlane.start();
        await waitFor(() => jobs.started.length === 4);
        await enqueue(sqlane, 'b', 3);

        for (let index = 0; index < 4; index++) {
            jobs.release(/** @type {string} */ (jobs.started[index]));
            // oxlint-disable-next-line no-await-in-loop -- one completion at a time
            await waitFor(() => jobs.started.length === 5 + index);
        }

        jobs.releaseAll();

        expect(jobs.started.slice(4, 8)).toStrictEqual(['b', 'b', 'a', 'a']);
    });

    test('the claim sets when the slots free together: {A, B, A, B}, then {B, A, A, A}', async () => {
        const p = nextPrefix();
        const sqlane = instanceOn(p);
        const store = createStore(testAdapter.adapter, p);

        await sqlane.migrate();
        await enqueue(sqlane, 'a', 10);
        await enqueue(sqlane, 'b', 3);

        const claim = (/** @type {number} */ tieOfA, /** @type {string} */ token) => store.claimDue({
            requests: [
                { name: 'a', maxJobs: 4, running: 0, weight: 1, group: null, tie: tieOfA },
                { name: 'b', maxJobs: 4, running: 0, weight: 1, group: null, tie: 1 - tieOfA },
            ],
            groupRooms: [],
            free: 4,
            lockToken: token,
            lockedBy: `test:${token}`,
            leaseMs: 60_000,
            choose: locked => chooseByShare(locked, tieOfA),
        });
        // The pointer at A: the ties go to A, and then to B
        expect(counts((await claim(0, 'T1')).jobs)).toStrictEqual({ a: 2, b: 2 });
        expect(counts((await claim(1, 'T2')).jobs)).toStrictEqual({ a: 3, b: 1 });
    });

    test('long and short jobs, equal weights, 4 slots: 2 running of each; a short one that ends gives its slot back', async () => {
        const { sqlane } = await freshSqlane({ maxConcurrency: 4 });
        const jobs = holdingHandlers();

        sqlane.handle('long', jobs.handler('long'));
        sqlane.handle('short', jobs.handler('short'));
        await enqueue(sqlane, 'long', 10);
        await enqueue(sqlane, 'short', 20);
        await sqlane.start();
        await waitFor(() => jobs.started.length === 4);
        expect(jobs.running).toStrictEqual({ long: 2, short: 2 });

        // The short jobs end, one at a time, while the long ones run: each slot goes back to short
        for (const name of ['short', 'short', 'short', 'long', 'short', 'long']) {
            // oxlint-disable-next-line no-await-in-loop -- one completion at a time
            await expect(releaseOne(jobs, name)).resolves.toBe(name);
            expect(jobs.running).toStrictEqual({ long: 2, short: 2 });
        }

        expect(maxRunning(jobs.samples, ['long'])).toBe(2);
        expect(maxRunning(jobs.samples, ['short'])).toBe(2);
        jobs.releaseAll();
    });

    test('groups: never above a cap, and the steady state 1 / 1 / 8', async () => {
        const heavy = defineConcurrencyGroup({ name: 'heavy', maxConcurrency: 2 });
        const { sqlane } = await freshSqlane({ maxConcurrency: 10 });
        const jobs = holdingHandlers();

        sqlane.handle('t', jobs.handler('t'), { fairShareWeight: 2, maxConcurrency: 1, concurrencyGroup: heavy });
        sqlane.handle('r', jobs.handler('r'), { concurrencyGroup: heavy });
        sqlane.handle('e', jobs.handler('e'), { fairShareWeight: 3 });

        for (const name of ['t', 'r', 'e']) {
            // oxlint-disable-next-line no-await-in-loop -- a few enqueues
            await enqueue(sqlane, name, 20);
        }

        await sqlane.start();
        await waitFor(() => jobs.started.length === 10);
        expect(jobs.running).toStrictEqual({ t: 1, r: 1, e: 8 });

        // A freed slot goes back to its name: the caps leave no other choice, or the shares do
        for (const name of ['r', 't', 'e', 'r', 'e', 't']) {
            // oxlint-disable-next-line no-await-in-loop -- one completion at a time
            await expect(releaseOne(jobs, name)).resolves.toBe(name);
            expect(jobs.running).toStrictEqual({ t: 1, r: 1, e: 8 });
        }

        expect(maxRunning(jobs.samples, ['t'])).toBe(1);
        expect(maxRunning(jobs.samples, ['t', 'r'])).toBe(2);

        jobs.releaseAll();
    });

    test('a group of 1, two equal names, a roomy instance: they take turns', async () => {
        const one = defineConcurrencyGroup({ name: 'one', maxConcurrency: 1 });
        const { sqlane } = await freshSqlane({ maxConcurrency: 5 });
        const jobs = holdingHandlers();

        for (const name of ['a', 'b']) {
            sqlane.handle(name, jobs.handler(name), { concurrencyGroup: one });
            // oxlint-disable-next-line no-await-in-loop -- a few enqueues
            await enqueue(sqlane, name, 5);
        }

        await sqlane.start();

        for (let count = 1; count <= 6; count++) {
            // oxlint-disable-next-line no-await-in-loop -- one start at a time
            await waitFor(() => jobs.started.length === count);
            jobs.releaseAll();
        }

        expect(jobs.started.join('')).toBe('ababab');
    });

    test('a group with a plain name and a name with mutex keys: they share it', async () => {
        const pair = defineConcurrencyGroup({ name: 'pair', maxConcurrency: 2 });
        const keyed = defineJob({ name: 'k', timeout: '10s', mutexKeys: payload => [String(payload.n)] });
        const { sqlane } = await freshSqlane({ maxConcurrency: 10 });
        const jobs = holdingHandlers();

        sqlane.handle('p', jobs.handler('p'), { concurrencyGroup: pair });
        sqlane.handle(keyed, jobs.handler('k'), { concurrencyGroup: pair });
        await enqueue(sqlane, 'p', 20);
        await sqlane.enqueueMany(testAdapter.pool, keyed, Array.from({ length: 10 }, (_, n) => ({ payload: { n } })));
        await sqlane.start();
        await waitFor(() => jobs.started.length === 2);
        expect(jobs.running).toStrictEqual({ p: 1, k: 1 });

        // A freed slot goes back to its name: the other one runs already
        for (const name of ['p', 'k', 'k', 'p']) {
            const count = jobs.started.length;

            jobs.release(name);
            // oxlint-disable-next-line no-await-in-loop -- one start at a time
            await waitFor(() => jobs.started.length === count + 1);
        }

        expect(jobs.started.slice(2)).toStrictEqual(['p', 'k', 'k', 'p']);
        jobs.releaseAll();
    });
});

/**
 * @param {{ name: string }[]} claimed
 * @returns {{ a: number, b: number }} The claimed jobs of each name.
 */
function counts(claimed) {
    return { a: claimed.filter(job => job.name === 'a').length, b: claimed.filter(job => job.name === 'b').length };
}

/**
 * Counts the claim statements of an adapter: the statements that lock due jobs with SKIP LOCKED.
 * @returns {{ adapter: import('../../src/types.js').Adapter<any>, counter: { claims: number } }}
 */
function countingClaims() {
    const counter = { claims: 0 };
    const { adapter } = testAdapter;
    /** @param {string} sql */
    const count = (sql) => {
        counter.claims += Number(sql.includes('SKIP LOCKED') && !sql.includes('mutexes'));
    };

    return {
        counter,
        adapter: {
            ...adapter,
            queue: {
                ...adapter.queue,
                query: (sql, params) => {
                    count(sql);

                    return adapter.queue.query(sql, params);
                },
            },
            queueTransaction: func => adapter.queueTransaction(executor => func({
                ...executor,
                query: (sql, params) => {
                    count(sql);

                    return executor.query(sql, params);
                },
            })),
        },
    };
}

/**
 * The choice of the runner over locked rows: names a and b, equal weights, nothing running.
 * @param {import('../../src/store/store.js').StartableJob[]} locked
 * @param {number} tieOfA
 * @returns {import('../../src/store/store.js').StartableJob[]}
 */
function chooseByShare(locked, tieOfA) {
    const rows = { a: locked.filter(job => job.name === 'a'), b: locked.filter(job => job.name === 'b') };
    const order = tieOfA === 0 ? ['a', 'b'] : ['b', 'a'];
    /** @type {import('../../src/store/store.js').StartableJob[]} */
    const chosen = [];

    // Equal shares at each step: alternate, from the name of the pointer
    for (let step = 0; chosen.length < 4 && (rows.a.length || rows.b.length); step++) {
        const next = rows[/** @type {'a' | 'b'} */ (order[step % 2])].shift();

        chosen.push(...next ? [next] : []);
    }

    return chosen;
}

describe('ties and processes', () => {
    test('round robin: 3 equal names, 1 slot: 30 starts, 10 each', async () => {
        const { sqlane } = await freshSqlane({ maxConcurrency: 1 });
        /** @type {string[]} */
        const started = [];

        for (const name of ['a', 'b', 'c']) {
            sqlane.handle(name, () => {
                started.push(name);
            });
            // oxlint-disable-next-line no-await-in-loop -- a few enqueues
            await enqueue(sqlane, name, 12);
        }

        await sqlane.start();
        await waitFor(() => started.length >= 30);

        const firstThirty = started.slice(0, 30);

        expect(['a', 'b', 'c'].map(name => firstThirty.filter(other => other === name).length))
            .toStrictEqual([10, 10, 10]);
    });

    test('two processes, a burst of 20 equal names with 1 job each: all 20 start', async () => {
        const p = nextPrefix();
        const { adapter: counting, counter } = countingClaims();
        const names = Array.from({ length: 20 }, (_, index) => `n${String(index).padStart(2, '0')}`);
        /** @type {string[]} */
        const started = [];
        const all = [0.1, 0.7].map(seed => instanceOn(p, {
            adapter: counting,
            maxConcurrency: 10,
            timings: { random: () => seed },
        }));

        await all[0].migrate();

        for (const sqlane of all) {
            for (const name of names) {
                sqlane.handle(name, () => {
                    started.push(name);
                });
            }
        }

        for (const name of names) {
            // oxlint-disable-next-line no-await-in-loop -- a few enqueues
            await enqueue(all[0], name, 1);
        }

        await Promise.all(all.map(sqlane => sqlane.start()));
        await waitFor(() => started.length === 20);

        expect(started.toSorted()).toStrictEqual(names);
        // A claim statement starts several jobs: fewer claims than jobs
        expect(counter.claims).toBeLessThan(20);
    });

    test('mutex keys: the slots of a blocked name go to the others; its jobs keep their FIFO per key', async () => {
        const keyed = defineJob({ name: 'keyed', timeout: '10s', mutexKeys: () => ['k'] });
        const { sqlane } = await freshSqlane({ maxConcurrency: 3 });
        const jobs = holdingHandlers();
        /** @type {unknown[]} */
        const keyedOrder = [];

        sqlane.handle(keyed, async (context) => {
            keyedOrder.push(context.payload.n);
            await jobs.handler('keyed')(context);
        });
        sqlane.handle('plain', jobs.handler('plain'));
        await sqlane.enqueueMany(testAdapter.pool, keyed, [1, 2, 3].map(n => ({ payload: { n } })));
        await enqueue(sqlane, 'plain', 10);
        await sqlane.start();
        // keyed 1 holds the key: the 2 other slots go to plain
        await waitFor(() => jobs.started.length === 3);
        expect(jobs.running).toStrictEqual({ keyed: 1, plain: 2 });

        jobs.release('keyed');
        await waitFor(() => keyedOrder.length === 2);
        jobs.release('keyed');
        await waitFor(() => keyedOrder.length === 3);
        jobs.releaseAll();

        expect(keyedOrder).toStrictEqual([1, 2, 3]);
    });
});

describe('drain(), start()', () => {
    test('drain() shares the free slots by weight', async () => {
        const { sqlane } = await freshSqlane({ maxConcurrency: 4 });
        /** @type {string[]} */
        const started = [];

        sqlane.handle('a', async () => {
            started.push('a');
            await sleep(50);
        }, { fairShareWeight: 3 });
        sqlane.handle('b', async () => {
            started.push('b');
            await sleep(50);
        });
        await enqueue(sqlane, 'a', 8);
        await enqueue(sqlane, 'b', 8);

        await expect(sqlane.drain()).resolves.toMatchObject({ completed: 16 });
        expect(started.slice(0, 4).toSorted()).toStrictEqual(['a', 'a', 'a', 'b']);
    });

    test('start() rejects a cap above the instance\'s', async () => {
        const { sqlane } = await freshSqlane({ maxConcurrency: 4 });

        sqlane.handle('wide', () => {}, { maxConcurrency: 5 });

        await expect(sqlane.start()).rejects.toThrow(ConfigError);
        await expect(sqlane.start())
            .rejects.toThrow('start(): the maxConcurrency of handle("wide") (5) is above the instance\'s maxConcurrency (4)');
    });
});
