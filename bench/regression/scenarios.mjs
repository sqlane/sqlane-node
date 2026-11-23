// The hot paths of sqlane, as deterministic scenarios: each runs a fixed sequence of public calls on an empty
// database, and the database's statement statistics count what it cost. No timers decide the work, so the counts are
// the same on every run; bench:statements keeps them in snapshot.json. A scenario gets sqlane's module, so a run can
// load another source tree.
/* oxlint-disable no-await-in-loop -- the steps of a scenario go one after the other */
import { setTimeout as sleep } from 'node:timers/promises';

/** @typedef {import('../lib/db_stats.mjs').StatementStats} StatementStats */

/**
 * @typedef {object} Context
 * @property {any} lib The module of sqlane: `createSqlane`, `defineLane`.
 * @property {(options?: Record<string, unknown>) => any} create A sqlane instance on the scenario's database, with
 *     these options on top of its adapter.
 * @property {any} pool The pool of the scenario's database, for `enqueue`.
 * @property {(func: () => Promise<void>) => Promise<StatementStats>} measure Clears the statistics, runs `func`, and
 *     reads them.
 */

/**
 * @typedef {object} Scenario
 * @property {string} name
 * @property {string} unit What one operation is: the counts are per operation.
 * @property {RegExp} [timing] The statements whose count depends on timing, left out of the counts: the rounds of a
 *     drain that look for due jobs. The faster the machine, the fewer rounds; `idle` counts them exactly.
 * @property {(context: Context) => Promise<{ operations: number, stats: StatementStats }>} run
 */

const NAMES = 1000;
/** The statement that looks for the lanes with due jobs: the same `delay_ms` column in every dialect */
const ROUNDS = /\bdelay_ms\b/;
const JOBS = 200;

/**
 * @param {any} lib
 * @param {number} count
 * @param {Record<string, unknown>} [options]
 * @returns {any[]} Definitions `job_0000`…, with these options.
 */
function definitions(lib, count, options = {}) {
    return Array.from({ length: count }, (_, index) => lib.defineLane({
        name: `job_${String(index).padStart(4, '0')}`,
        ...options,
    }));
}

/**
 * @param {any} sqlane
 * @param {any[]} jobs
 */
function handleAll(sqlane, jobs) {
    for (const job of jobs) {
        sqlane.lanes.add(job, async () => {});
    }
}

/**
 * @param {() => boolean} done
 * @param {number} timeoutMs
 * @param {() => string} message
 */
async function waitUntil(done, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;

    while (!done()) {
        if (Date.now() > deadline) {
            throw new Error(message());
        }

        await sleep(50);
    }
}

/** @type {Scenario[]} */
export const SCENARIOS = [
    {
        name: 'enqueue',
        unit: 'enqueue, in a transaction of its own',
        async run({ lib, create, pool, measure }) {
            const [job] = definitions(lib, 1);
            const sqlane = create({ lanes: [job] });

            await sqlane.schema.migrate();

            const stats = await measure(async () => {
                for (let index = 0; index < 100; index++) {
                    await sqlane.enqueue(pool, job, { index });
                }
            });

            await sqlane.close();

            return { operations: 100, stats };
        },
    },
    {
        name: 'enqueue_many',
        unit: '`enqueueMany` of 100 jobs',
        async run({ lib, create, pool, measure }) {
            const [job] = definitions(lib, 1);
            const sqlane = create({ lanes: [job] });

            await sqlane.schema.migrate();

            const stats = await measure(async () => {
                for (let batch = 0; batch < 10; batch++) {
                    const items = Array.from({ length: 100 }, (_, index) => ({ payload: { batch, index } }));

                    await sqlane.enqueueMany(pool, job, items);
                }
            });

            await sqlane.close();

            return { operations: 10, stats };
        },
    },
    {
        name: 'run',
        unit: 'job claimed, run and completed, over 1000 added lanes',
        timing: ROUNDS,
        async run({ lib, create, pool, measure }) {
            const jobs = definitions(lib, NAMES);
            const sqlane = create({ lanes: jobs, localMaxConcurrency: 1 });

            handleAll(sqlane, jobs);
            await sqlane.schema.migrate();

            for (let index = 0; index < JOBS; index++) {
                await sqlane.enqueue(pool, jobs[(index * 7) % NAMES], { index });
            }

            const stats = await measure(async () => {
                const { completed } = await sqlane.drain({ timeout: '60s' });

                if (completed !== JOBS) {
                    throw new Error(`run: ${completed} of ${JOBS} jobs completed`);
                }
            });

            await sqlane.close();

            return { operations: JOBS, stats };
        },
    },
    {
        name: 'idle',
        unit: '`drain()` of 1000 added lanes with no job: its rounds until it finds none',
        async run({ lib, create, measure }) {
            const jobs = definitions(lib, NAMES);
            const sqlane = create({ lanes: jobs });

            handleAll(sqlane, jobs);
            await sqlane.schema.migrate();

            const stats = await measure(async () => {
                await sqlane.drain();
            });

            await sqlane.close();

            return { operations: 1, stats };
        },
    },
    {
        name: 'global_limits',
        unit: 'job with 2 global limits (a key of 1 of 10, and one shared of 5), 100 jobs of 2 lanes',
        timing: ROUNDS,
        async run({ lib, create, pool, measure }) {
            const account = lib.defineConcurrencyLimit({ name: 'account', max: 1 });
            const accounts = lib.defineConcurrencyLimit({ name: 'accounts', max: 5 });
            const jobs = definitions(lib, 2, {
                globalConcurrencyLimits: (/** @type {{ payload: { key: number } }} */ { payload }) => [
                    accounts,
                    account.key(payload.key),
                ],
                timeout: '1m',
            });
            const sqlane = create({ lanes: jobs, localMaxConcurrency: 1 });

            handleAll(sqlane, jobs);
            await sqlane.schema.migrate();

            for (let index = 0; index < 100; index++) {
                await sqlane.enqueue(pool, jobs[index % 2], { key: index % 10 });
            }

            const stats = await measure(async () => {
                const { completed } = await sqlane.drain({ timeout: '60s' });

                if (completed !== 100) {
                    throw new Error(`global_limits: ${completed} of 100 jobs completed`);
                }
            });

            await sqlane.close();

            return { operations: 100, stats };
        },
    },
    {
        name: 'global_rate_limits',
        unit: 'job with a key of 1 of 10 of a global rate limit that none reaches, 100 jobs of 2 lanes',
        timing: ROUNDS,
        async run({ lib, create, pool, measure }) {
            // A burst of 1000 per key: the 10 starts of each key fit at once, so no job blocks and the counts are
            // the statements of the rate limit on each job, not of a timer
            const api = lib.defineRateLimit({ name: 'api', max: 1000, per: '1s', burst: 1000 });
            const jobs = definitions(lib, 2, {
                globalRateLimits: (/** @type {{ payload: { key: number } }} */ { payload }) => [api.key(payload.key)],
                timeout: '1m',
            });
            const sqlane = create({ lanes: jobs, localMaxConcurrency: 1 });

            handleAll(sqlane, jobs);
            await sqlane.schema.migrate();

            for (let index = 0; index < 100; index++) {
                await sqlane.enqueue(pool, jobs[index % 2], { key: index % 10 });
            }

            const stats = await measure(async () => {
                const { completed } = await sqlane.drain({ timeout: '60s' });

                if (completed !== 100) {
                    throw new Error(`global_rate_limits: ${completed} of 100 jobs completed`);
                }
            });

            await sqlane.close();

            return { operations: 100, stats };
        },
    },
    {
        name: 'schedule',
        unit: 'slot of 1000 `every: \'10s\'` schedules, in one process that adds none of their lanes',
        async run({ lib, create, measure }) {
            const jobs = definitions(lib, NAMES);
            let fired = 0;
            const sqlane = create({
                lanes: jobs,
                // The stall recovery and the cleanup run every 30 s and 5 minutes: off, so the window holds the
                // scheduler's work only (`timings` is undocumented, for the tests of sqlane). Their first run comes
                // at a random time within the interval: 3 weeks, not 1 h, where it fell in the window of 20 s about
                // once in 200 runs (under the 2^31 ms of setTimeout)
                timings: { recoveryIntervalMs: 2_000_000_000, cleanupIntervalMs: 2_000_000_000 },
                onEvent: (/** @type {{ type: string }} */ event) => {
                    if (event.type === 'schedule_fired') {
                        fired++;
                    }
                },
            });

            for (const job of jobs) {
                sqlane.schedule(job, { every: '10s' });
            }

            await sqlane.schema.migrate();
            await sqlane.start();

            // The first slot may come during the registration: measure the next one, from 2 s before it
            const slot = (Math.floor(Date.now() / 10_000) + 2) * 10_000;

            await sleep(slot - 2000 - Date.now());

            const stats = await measure(async () => {
                fired = 0;
                await waitUntil(() => fired >= NAMES, 20_000, () => `schedule: ${fired} of ${NAMES} slots fired`);

                // The statements of the last chunk have committed: its events come after the commit
            });

            await sqlane.close();

            return { operations: NAMES, stats };
        },
    },
];
