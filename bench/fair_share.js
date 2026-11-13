// The benchmarks of the fair share of free slots (5.0): `node bench/fair_share.js --scenario <name> [--db <name>]
// [--src <tree>] [--seconds <n>] [--only <label part>]`. Starts the database of `--db` in Docker (data on tmpfs), and
// prints JSON lines.
//
//   low-backlog  2–20 names with 0–3 due jobs each, refilled at random, 2 and 4 processes, maxConcurrency 4 and 16:
//                the claim statements per started job. `--src` runs another source tree (main, for the baseline).
//   fairness     the slot time of each name against its weight: 3:1 on 8 slots; 2:1:1 with jobs of 200, 20 and 50
//                ms on 1 and 2 processes; 1 s against 100 ms jobs at 3 slots.
//   chooser      the time of the choice of one dispatch over 1000 names, 100 of them due (no database).
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { TEST_DATABASES } from '../test/support/databases.js';
import { percentiles } from './scenarios.js';

const { values: args } = parseArgs({
    options: {
        scenario: { type: 'string', default: 'fairness' },
        db: { type: 'string', default: 'postgres-18' },
        src: { type: 'string', default: resolve(import.meta.dirname, '..') },
        seconds: { type: 'string', default: '60' },
        only: { type: 'string', default: '' },
    },
});
const src = String(args.src);
const { createSqlane } = await import(join(src, 'src/index.js'));
const { mysql2Adapter } = await import(join(src, 'src/adapters/mysql2.js'));
const { pgAdapter } = await import(join(src, 'src/adapters/pg.js'));
const seconds = Number(args.seconds);

/**
 * An instance, with its cap as the version of `--src` names it: `maxConcurrency` from 5.0, `concurrency` before.
 * @param {Record<string, unknown>} options
 * @param {number} maxConcurrency
 * @returns {any}
 */
function instance(options, maxConcurrency) {
    try {
        return createSqlane({ ...options, maxConcurrency });
    } catch (error) {
        // Only the unknown option of 4.x: a real setup error is thrown
        if (!isOptionUnknownTo4x(error, 'maxConcurrency')) {
            throw error;
        }

        return createSqlane({ ...options, concurrency: maxConcurrency });
    }
}

/**
 * @param {unknown} error
 * @param {string} option
 * @returns {boolean} The ConfigError of a source before 5.0, for an option of 5.0.
 */
function isOptionUnknownTo4x(error, option) {
    return error instanceof Error && error.name === 'ConfigError' && error.message.includes(option);
}

/**
 * A pool of the database and an adapter that counts the statements of the queue: the claims (the statements that lock
 * due jobs with SKIP LOCKED) and the others.
 * @param {{ dialect: string, url: string }} database
 * @returns {Promise<{ adapter: any, pool: any, counts: { claims: number, statements: number },
 *     end: () => Promise<void> }>}
 */
async function countingPool({ dialect, url }) {
    const counts = { claims: 0, statements: 0 };
    /** @param {string} sql */
    const count = (sql) => {
        counts.statements++;
        counts.claims += Number(sql.includes('SKIP LOCKED') && !sql.includes('mutexes'));
    };
    let pool;
    let adapter;

    if (dialect === 'postgres') {
        const { Pool } = await import('pg');

        pool = new Pool({ connectionString: url, max: 4 });
        adapter = pgAdapter(pool, { notify: true });
    } else {
        const mysql = await import('mysql2/promise');

        pool = mysql.createPool({ uri: url, connectionLimit: 4 });
        adapter = mysql2Adapter(pool, { dialect });
    }

    /**
     * @param {any} executor
     * @returns {any}
     */
    const counting = executor => ({
        ...executor,
        query: (/** @type {string} */ sql, /** @type {unknown[]} */ params) => {
            count(sql);

            return executor.query(sql, params);
        },
        run: (/** @type {string} */ sql, /** @type {unknown[]} */ params) => {
            count(sql);

            return executor.run(sql, params);
        },
    });

    return {
        counts,
        pool,
        adapter: {
            ...adapter,
            queue: counting(adapter.queue),
            queueTransaction: (/** @type {any} */ func) => adapter.queueTransaction(
                (/** @type {any} */ executor) => func(counting(executor)),
            ),
            withConnection: (/** @type {any} */ func) => adapter.withConnection(
                (/** @type {any} */ executor) => func(counting(executor)),
            ),
        },
        end: () => pool.end(),
    };
}

/**
 * Low backlog: names with a few due jobs at a time. The claim statements per started job, against the baseline.
 * @param {{ name: string, dialect: string, url: string }} database
 * @param {{ names: number, processes: number, maxConcurrency: number }} mode
 * @returns {Promise<object>}
 */
async function lowBacklog(database, { names, processes, maxConcurrency }) {
    const p = `lb${names}_${processes}_${maxConcurrency}_`;
    const jobNames = Array.from({ length: names }, (_, index) => `n${String(index).padStart(2, '0')}`);
    const pools = await Promise.all(Array.from({ length: processes + 1 }, () => countingPool(database)));
    const [producerPool, ...workerPools] = pools;
    const producer = instance({ adapter: producerPool.adapter, tablePrefix: p }, 1);
    /** @type {Set<string> | null} The jobs started in the window: a job claimed again (its payload was not seen yet,
     * or its lease ended) counts once */
    let startedIds = null;
    let claimedEvents = 0;
    const workers = workerPools.map(pool => instance({
        adapter: pool.adapter,
        tablePrefix: p,
        pollInterval: 1000,
        onEvent: (/** @type {any} */ event) => {
            if (event.type === 'claimed' && startedIds) {
                startedIds.add(event.jobId);
                claimedEvents++;
            }
        },
    }, maxConcurrency));
    let seed = 3;
    const random = () => {
        seed = ((seed * 1_103_515_245) + 12_345) % (2 ** 31);

        return seed / (2 ** 31);
    };

    await producer.migrate();

    for (const worker of workers) {
        for (const name of jobNames) {
            worker.handle(name, () => sleep(5));
        }
    }

    await Promise.all(workers.map(worker => worker.start()));

    const before = workerPools.map(pool => ({ ...pool.counts }));
    startedIds = new Set();
    const end = Date.now() + (seconds * 1000);
    let enqueued = 0;

    while (Date.now() < end) {
        const name = jobNames[Math.floor(random() * names)];
        const count = Math.floor(random() * 4);

        if (count) {
            // oxlint-disable-next-line no-await-in-loop -- a steady refill
            await producer.enqueueMany(producerPool.pool, name, Array.from({ length: count }, () => ({ payload: {} })));
            enqueued += count;
        }

        // oxlint-disable-next-line no-await-in-loop -- a steady refill
        await sleep(20);
    }

    await sleep(1000);

    let claims = 0;
    let statements = 0;

    for (const [index, pool] of workerPools.entries()) {
        claims += pool.counts.claims - before[index].claims;
        statements += pool.counts.statements - before[index].statements;
    }

    const jobs = startedIds.size;

    await Promise.all([producer, ...workers].map(sqlane => sqlane.close()));
    await Promise.all(pools.map(pool => pool.end()));

    return {
        names,
        processes,
        maxConcurrency,
        enqueued,
        started: jobs,
        claimedEvents,
        claimsPerJob: claims / jobs,
        jobsPerClaim: jobs / claims,
        statementsPerJob: statements / jobs,
    };
}

/**
 * Fairness: the time-averaged running count of each name in each process, from the claimed and completed events.
 * @param {{ name: string, dialect: string, url: string }} database
 * @param {{ label: string, maxConcurrency: number, processes: number,
 *     names: { name: string, weight: number, durationMs: number }[] }} mode
 * @returns {Promise<object>}
 */
async function fairness(database, { label, maxConcurrency, processes, names }) {
    // One set of tables per mode
    const p = `fs${processes}_${maxConcurrency}_${names.map(({ name }) => name).join('')}_`;
    const pools = await Promise.all(Array.from({ length: processes + 1 }, () => countingPool(database)));
    const [producerPool, ...workerPools] = pools;
    const producer = instance({ adapter: producerPool.adapter, tablePrefix: p }, 1);
    // Set at the start of the workers: 5 s of warm-up, then the window
    let windowStart = Infinity;
    let windowEnd = Infinity;
    /** @type {Map<string, number>[]} The slot time of each name in each process, in the window */
    const slotTime = workerPools.map(() => new Map(names.map(({ name }) => [name, 0])));
    /** @type {Map<string, number>[]} */
    const startedAt = workerPools.map(() => new Map());
    const clip = (/** @type {number} */ at) => Math.min(Math.max(at, windowStart), windowEnd);
    const workers = workerPools.map((pool, index) => instance({
        adapter: pool.adapter,
        tablePrefix: p,
        onEvent: (/** @type {any} */ event) => {
            if (event.type === 'claimed') {
                startedAt[index].set(event.jobId, Date.now());
            } else if (event.type === 'completed') {
                const from = startedAt[index].get(event.jobId);

                if (from !== undefined) {
                    const time = slotTime[index];

                    const ms = clip(Date.now()) - clip(from);

                    time.set(event.jobName, /** @type {number} */ (time.get(event.jobName)) + ms);
                }
            }
        },
    }, maxConcurrency));

    await producer.migrate();

    for (const { name, weight, durationMs } of names) {
        for (const worker of workers) {
            try {
                worker.handle(name, () => sleep(durationMs), { fairShareWeight: weight });
            } catch (error) {
                if (!isOptionUnknownTo4x(error, 'fairShareWeight')) {
                    throw error;
                }

                // Before 5.0 (`--src`): no weights, for the occupancy of the slots only
                worker.handle(name, () => sleep(durationMs));
            }
        }

        // A backlog larger than the run
        const count = Math.ceil((processes * maxConcurrency * (seconds + 40) * 1000) / durationMs);

        for (let offset = 0; offset < count; offset += 5000) {
            // oxlint-disable-next-line no-await-in-loop -- the backlog in batches
            await producer.enqueueMany(producerPool.pool, name, Array.from(
                { length: Math.min(5000, count - offset) },
                () => ({ payload: {} }),
            ));
        }
    }

    windowStart = Date.now() + 5000;
    windowEnd = windowStart + (seconds * 1000);
    await Promise.all(workers.map(worker => worker.start()));
    await sleep(Math.max(0, windowEnd - Date.now()) + 2000);
    await Promise.all([producer, ...workers].map(sqlane => sqlane.close({ deadline: '10s' })));
    await Promise.all(pools.map(pool => pool.end()));

    return {
        label,
        maxConcurrency,
        processes,
        weights: Object.fromEntries(names.map(({ name, weight }) => [name, weight])),
        // The running count of each name, averaged over the window, per process
        slots: slotTime.map(time => Object.fromEntries([...time].map(([name, ms]) => [
            name,
            Number((ms / (seconds * 1000)).toFixed(2)),
        ]))),
    };
}

/**
 * The choice of one dispatch over 1000 names with weights 1–5, 100 of them due, 10 free slots.
 * @returns {Promise<object>}
 */
async function chooser() {
    const { fill, rankNames } = await import(join(src, 'src/fair_share.js'));
    const times = [];
    let seed = 9;
    const random = () => {
        seed = ((seed * 1_103_515_245) + 12_345) % (2 ** 31);

        return seed / (2 ** 31);
    };

    for (let round = 0; round < 2000; round++) {
        const names = Array.from({ length: 100 }, (_, index) => ({
            name: `n${index}`,
            index: Math.floor(random() * 1000),
            weight: 1 + Math.floor(random() * 5),
            running: Math.floor(random() * 3),
            room: Infinity,
            group: null,
            available: Infinity,
        }));
        const startedAt = performance.now();
        const ranked = rankNames(names, round % 1000, 1000).slice(0, 40);

        fill({ names: ranked, free: 10, base: round % 1000, size: 1000, take: (/** @type {any} */ name) => name.name });
        times.push(performance.now() - startedAt);
    }

    return { scenario: 'chooser', ...percentiles(times.slice(200)) };
}

/**
 * @returns {Promise<void>}
 */
async function main() {
    if (args.scenario === 'chooser') {
        console.log(JSON.stringify(await chooser()));

        return;
    }

    const database = TEST_DATABASES.find(({ name }) => name === args.db);

    if (!database) {
        throw new Error(`Unknown database: ${args.db}`);
    }

    const container = await database.start();
    const url = container.getConnectionUri().replace(/^mariadb:/, 'mysql:');
    const context = { name: database.name, dialect: database.dialect, url };

    try {
        if (args.scenario === 'low-backlog') {
            for (const mode of [
                { names: 2, processes: 2, maxConcurrency: 4 },
                { names: 20, processes: 2, maxConcurrency: 4 },
                { names: 20, processes: 4, maxConcurrency: 16 },
                { names: 2, processes: 4, maxConcurrency: 16 },
            ]) {
                // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
                const result = await lowBacklog(context, mode);

                console.log(JSON.stringify({ db: database.name, scenario: 'low-backlog', ...result }));
            }
        } else {
            for (const mode of [
                { label: '3:1 on 8, 1 s jobs', maxConcurrency: 8, processes: 1, names: [
                    { name: 'a', weight: 3, durationMs: 1000 }, { name: 'b', weight: 1, durationMs: 1000 },
                ] },
                { label: '2:1:1, 200/20/50 ms, 1 process', maxConcurrency: 8, processes: 1, names: [
                    { name: 'a', weight: 2, durationMs: 200 }, { name: 'b', weight: 1, durationMs: 20 },
                    { name: 'c', weight: 1, durationMs: 50 },
                ] },
                { label: '2:1:1, 200/20/50 ms, 2 processes', maxConcurrency: 8, processes: 2, names: [
                    { name: 'a', weight: 2, durationMs: 200 }, { name: 'b', weight: 1, durationMs: 20 },
                    { name: 'c', weight: 1, durationMs: 50 },
                ] },
                { label: '1:1, 1 s against 100 ms, 3 slots', maxConcurrency: 3, processes: 1, names: [
                    { name: 'long', weight: 1, durationMs: 1000 }, { name: 'short', weight: 1, durationMs: 100 },
                ] },
            ].filter(({ label }) => label.includes(String(args.only)))) {
                // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
                console.log(JSON.stringify({ db: database.name, scenario: 'fairness', ...await fairness(context, mode) }));
            }
        }
    } finally {
        await container.stop();
    }
}

await main();
