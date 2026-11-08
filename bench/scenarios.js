// The benchmark scenarios. Each one runs on tables of its own (a table prefix), with pools of its own.
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSqlane } from '../src/index.js';
import { createStore } from '../src/store/store.js';
import { createBenchPool } from './bench_database.js';

/**
 * @typedef {object} BenchContext
 * @property {'mysql' | 'postgres'} dialect
 * @property {string} url
 * @property {() => string} nextPrefix A table prefix not used yet.
 * @property {boolean} quick Fewer samples and rows.
 */

/** @typedef {import('../src/types.js').Sqlane<any, any>} Sqlane */

/**
 * @typedef {object} Percentiles
 * @property {number} p50
 * @property {number} p95
 * @property {number} p99
 * @property {number} max
 */

/**
 * @param {number[]} values
 * @returns {Percentiles}
 */
export function percentiles(values) {
    const sorted = values.toSorted((a, b) => a - b);
    /**
     * @param {number} p
     * @returns {number}
     */
    const at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? Number.NaN;

    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? Number.NaN };
}

/**
 * Runs func on each item, at most `limit` at a time.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<unknown>} func
 * @returns {Promise<void>}
 */
async function inParallel(items, limit, func) {
    let next = 0;

    async function work() {
        while (next < items.length) {
            const item = items[next];

            next++;
            // oxlint-disable-next-line no-await-in-loop -- one item after the other in each worker
            await func(item);
        }
    }

    await Promise.all(Array.from({ length: limit }, work));
}

/**
 * @param {number} count
 * @returns {string[]} `job_0000`, `job_0001`, …
 */
function jobNames(count) {
    return Array.from({ length: count }, (_, index) => `job_${String(index).padStart(4, '0')}`);
}

/**
 * @param {Sqlane} sqlane
 * @param {any} pool
 * @param {string} name
 * @param {{ count: number, delay?: string }} options
 * @returns {Promise<void>}
 */
async function enqueueJobs(sqlane, pool, name, { count, delay }) {
    const BATCH = 500;
    const batches = Array.from({ length: Math.ceil(count / BATCH) }, (_, index) => {
        return Math.min(BATCH, count - (index * BATCH));
    });

    await inParallel(batches, 4, size => sqlane.enqueueMany(pool, name, Array.from({ length: size }, () => ({
        payload: {},
        options: delay ? { delay } : {},
    }))));
}

/**
 * @param {import('./bench_database.js').BenchPool} pool
 * @param {string} p
 * @returns {Promise<void>}
 */
async function analyze(pool, p) {
    await pool.execute(pool.dialect === 'mysql' ? `ANALYZE TABLE ${p}jobs` : `ANALYZE ${p}jobs`);
}

/**
 * @param {() => Promise<unknown>} func
 * @param {number} samples
 * @returns {Promise<Percentiles>} Of the run time, in ms.
 */
async function time(func, samples) {
    /** @type {number[]} */
    const times = [];

    for (let index = 0; index < samples + 10; index++) {
        const startedAt = performance.now();

        // oxlint-disable-next-line no-await-in-loop -- one run after the other
        await func();

        // The first 10: warm-up
        if (index >= 10) {
            times.push(performance.now() - startedAt);
        }
    }

    return percentiles(times);
}

/**
 * @typedef {object} ProbeResult
 * @property {number} pendingNames The names with pending jobs.
 * @property {Percentiles} probe The probe of sqlane.
 * @property {Percentiles} union One `MIN(run_at)` per name, in a `UNION ALL`: a probe that grows with all names.
 */

/**
 * The probe of 1000 handled names, against a table with completed jobs in all of them, and pending jobs in some.
 * @param {BenchContext} context
 * @returns {Promise<{ historyRows: number, rows: ProbeResult[] }>}
 */
export async function benchProbe({ dialect, url, nextPrefix, quick }) {
    const p = nextPrefix();
    const pool = createBenchPool(dialect, url, 8);
    const sqlane = createSqlane({ adapter: pool.adapter(), tablePrefix: p });
    const store = createStore(pool.adapter(), p);
    const names = jobNames(1000);
    const historyPerName = quick ? 10 : 100;
    const samples = quick ? 50 : 300;
    /** @type {ProbeResult[]} */
    const rows = [];

    try {
        await sqlane.migrate();
        await inParallel(names, 8, name => enqueueJobs(sqlane, pool.raw, name, {
            count: historyPerName,
        }));
        await pool.execute(`UPDATE ${p}jobs SET status = 'completed', finished_at = run_at`);

        const quote = dialect === 'mysql' ? '`' : '"';
        const union = names
            .map(name => `(SELECT MIN(run_at) AS ${quote}min${quote} FROM ${p}jobs
                WHERE status = 'pending' AND job_name = '${name}')`)
            .join(' UNION ALL ');
        let pendingNames = 0;

        for (const target of [0, 1, 10, 100, 1000]) {
            // oxlint-disable-next-line no-await-in-loop -- one step after the other
            await inParallel(names.slice(pendingNames, target), 8, name => enqueueJobs(sqlane, pool.raw, name, {
                count: 10,
                delay: '1h',
            }));
            pendingNames = target;
            // oxlint-disable-next-line no-await-in-loop -- one step after the other
            await analyze(pool, p);
            rows.push({
                pendingNames,
                // oxlint-disable-next-line no-await-in-loop -- one step after the other
                probe: await time(() => store.probe(), samples),
                // oxlint-disable-next-line no-await-in-loop -- one step after the other
                union: await time(() => pool.execute(union), Math.ceil(samples / 5)),
            });
        }
    } finally {
        await sqlane.close();
        await pool.end();
    }

    return { historyRows: names.length * historyPerName, rows };
}

/**
 * A pub/sub in memory, between the instances of this process: Redis without its network hop.
 * @returns {import('../src/types.js').Hint}
 */
function memoryHint() {
    const bus = new EventEmitter();

    return {
        publish: async (channel, message) => {
            bus.emit(channel, message);
        },
        subscribe: async (channel, onMessage) => {
            bus.on(channel, onMessage);

            return async () => {
                bus.off(channel, onMessage);
            };
        },
    };
}

/**
 * @typedef {object} LatencyMode
 * @property {string} label
 * @property {'same' | 'hint' | 'notify'} wake `same`: the producer is the worker (re-probe). `hint`: another
 *     instance, woken by a hint in memory. `notify`: another instance, woken by PostgreSQL NOTIFY.
 * @property {[number, number]} gapMs The pause between two enqueues: random, in this range.
 */

/**
 * @typedef {object} LatencyResult
 * @property {string} label
 * @property {Percentiles} latency From the return of COMMIT to the start of the handler, in ms.
 */

/**
 * The latency from the commit of an enqueue to the start of its handler, one job at a time.
 * @param {BenchContext} context
 * @param {LatencyMode} mode
 * @returns {Promise<LatencyResult>}
 */
export async function benchLatency({ dialect, url, nextPrefix, quick }, { label, wake, gapMs }) {
    const p = nextPrefix();
    const notify = wake === 'notify';
    const hint = wake === 'hint' ? memoryHint() : null;
    const producerPool = createBenchPool(dialect, url, 4);
    const workerPool = wake === 'same' ? producerPool : createBenchPool(dialect, url, 4);
    const producer = createSqlane({ adapter: producerPool.adapter({ notify }), tablePrefix: p, hint });
    const worker = wake === 'same'
        ? producer
        : createSqlane({ adapter: workerPool.adapter({ notify }), tablePrefix: p, hint });
    /** @type {Map<string, (startedAt: number) => void>} */
    const waiters = new Map();
    const samples = quick ? 50 : 300;
    /** @type {number[]} */
    const latencies = [];

    try {
        await producer.migrate();
        worker.handle('ping', ({ job }) => {
            waiters.get(job.id)?.(performance.now());
        });
        await worker.start();
        await sleep(500);

        for (let index = 0; index < samples + 10; index++) {
            /** @type {Promise<number> | null} */
            let started = null;
            /** @type {string} */
            let id = '';

            // oxlint-disable-next-line no-await-in-loop -- one job after the other
            await producerPool.transaction(async (connection) => {
                ({ id } = await producer.enqueue(connection, 'ping', {}));
                started = new Promise((resolve) => {
                    waiters.set(id, resolve);
                });
            });

            const committedAt = performance.now();
            // oxlint-disable-next-line no-await-in-loop -- one job after the other
            const startedAt = await /** @type {Promise<number>} */ (/** @type {unknown} */ (started));

            waiters.delete(id);

            // The first 10: warm-up
            if (index >= 10) {
                latencies.push(startedAt - committedAt);
            }

            // oxlint-disable-next-line no-await-in-loop -- one job after the other
            await sleep(gapMs[0] + (Math.random() * (gapMs[1] - gapMs[0])));
        }
    } finally {
        await Promise.all([producer.close(), worker.close()]);
        await Promise.all([producerPool.end(), workerPool === producerPool ? null : workerPool.end()]);
    }

    return { label, latency: percentiles(latencies) };
}

/**
 * @typedef {object} EnqueueResult
 * @property {string} label
 * @property {number} jobsPerSecond
 */

/**
 * Enqueue throughput: 8 producers, each enqueue in a transaction of its own.
 * @param {BenchContext} context
 * @param {{ label: string, batch: number }} mode `batch`: the jobs of one `enqueueMany`, or 1: `enqueue`.
 * @returns {Promise<EnqueueResult>}
 */
export async function benchEnqueue({ dialect, url, nextPrefix, quick }, { label, batch }) {
    const p = nextPrefix();
    const pool = createBenchPool(dialect, url, 8);
    const sqlane = createSqlane({ adapter: pool.adapter(), tablePrefix: p });
    const total = (quick ? 2000 : 10_000) * (batch > 1 ? 10 : 1);
    const calls = Array.from({ length: total / batch }, (_, index) => index);

    try {
        await sqlane.migrate();

        const startedAt = performance.now();

        await inParallel(calls, 8, index => pool.transaction(async (connection) => {
            await (batch > 1
                ? sqlane.enqueueMany(connection, 'job', Array.from({ length: batch }, () => ({ payload: { index } })))
                : sqlane.enqueue(connection, 'job', { index }));
        }));

        return { label, jobsPerSecond: total / ((performance.now() - startedAt) / 1000) };
    } finally {
        await sqlane.close();
        await pool.end();
    }
}

/**
 * @typedef {object} ProcessResult
 * @property {string} label
 * @property {number} jobsPerSecond
 */

/**
 * Processing throughput: due jobs with an empty handler, run by `instances` workers of `concurrency` each.
 * @param {BenchContext} context
 * @param {{ label: string, instances: number, concurrency: number }} mode
 * @returns {Promise<ProcessResult>}
 */
export async function benchProcess({ dialect, url, nextPrefix, quick }, { label, instances, concurrency }) {
    const p = nextPrefix();
    const total = quick ? 2000 : 20_000;
    const producerPool = createBenchPool(dialect, url, 8);
    const producer = createSqlane({ adapter: producerPool.adapter(), tablePrefix: p });
    /** @type {import('./bench_database.js').BenchPool[]} */
    const pools = [];
    /** @type {Sqlane[]} */
    const workers = [];
    let completed = 0;
    const done = Promise.withResolvers();
    /** @param {import('../src/types.js').SqlaneEvent} event */
    const onEvent = (event) => {
        if (event.type === 'completed') {
            completed++;

            if (completed === total) {
                done.resolve(undefined);
            }
        }
    };

    try {
        await producer.migrate();
        await enqueueJobs(producer, producerPool.raw, 'job', { count: total });

        for (let index = 0; index < instances; index++) {
            // The README's sizing: a few connections for the queue of each process
            const pool = createBenchPool(dialect, url, 5);
            const worker = createSqlane({
                adapter: pool.adapter(),
                tablePrefix: p,
                concurrency,
                onEvent,
            });

            worker.handle('job', () => {});
            pools.push(pool);
            workers.push(worker);
        }

        const startedAt = performance.now();

        await Promise.all(workers.map(worker => worker.start()));
        await done.promise;

        return { label, jobsPerSecond: total / ((performance.now() - startedAt) / 1000) };
    } finally {
        await Promise.all([producer, ...workers].map(sqlane => sqlane.close()));
        await Promise.all([producerPool, ...pools].map(pool => pool.end()));
    }
}
