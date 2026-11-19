// One process of the performance comparison (see run.mjs): `--role setup`, `worker` or `producer`.
//
//   node perf.mjs --role worker --library sqlane --url <url> --names 1000 --out <dir> [--warmup 5 --measure 15]
//       [--schedules 1000 --cron '* * * * *' --index 0] [--backlog 20000]
//
// The worker and the producer write their numbers to `<out>/<role>.json`. The worker runs empty handlers, and notes the
// peak of its RSS in the window; the producer enqueues `--rate` jobs per second, each in a transaction with a business
// INSERT, and notes how long each enqueue call takes after the warm-up.
//
// With `--backlog`, the throughput: the setup also enqueues that many jobs of the first name, outside a business
// transaction, and writes how long it took to `<out>/setup.json`. The worker then counts its completions from the
// first one, for `--measure` seconds or until the backlog is empty, writes them to `<out>/worker.json`, and on SIGUSR2
// exits.
//
// With `--schedules`, the worker (one of several: `--index`) runs the schedules of the first job name, notes the
// slot and the start of each scheduled job, and on SIGUSR2 writes them to `<out>/worker-<index>.json` and exits.
/* oxlint-disable no-await-in-loop -- a fixture, and a producer: one step after the other */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createPool } from 'mysql2/promise';
import { Pool } from 'pg';

const { values: args } = parseArgs({
    options: {
        'role': { type: 'string' },
        'library': { type: 'string' },
        'url': { type: 'string' },
        // The database of the business table: the queue's, unless the queue is on Redis
        'business-url': { type: 'string' },
        'dialect': { type: 'string', default: 'mysql' },
        'names': { type: 'string', default: '1000' },
        'rate': { type: 'string', default: '20' },
        'warmup': { type: 'string', default: '5' },
        'measure': { type: 'string', default: '15' },
        'out': { type: 'string', default: '.' },
        'schedules': { type: 'string', default: '0' },
        'cron': { type: 'string', default: '* * * * *' },
        'index': { type: 'string', default: '0' },
        'backlog': { type: 'string', default: '0' },
    },
});
const url = String(args.url);
const businessUrl = args['business-url'] ?? url;
const mysql = businessUrl.startsWith('mysql:');
const role = /** @type {'setup' | 'worker' | 'producer'} */ (args.role);
const names = Array.from({ length: Number(args.names) }, (_, index) => `job_${String(index).padStart(4, '0')}`);
const { adapter } = await import(`./libs/${String(args.library).replaceAll('-', '_')}.mjs`);
/** Each library's own wakes run, plus a poll of 5 s */
const POLL_INTERVAL_MS = 5000;
/** The worker and the producer outlive the window: run.mjs reads their counters at its end */
const LINGER_MS = 3000;
const CONCURRENCY = 8;
/** The worker reads its RSS this often in the window, for the peak: a few µs a reading */
const RSS_INTERVAL_MS = 200;
const MB = 2 ** 20;
/** The backlog of the throughput: in batches of the library's bulk enqueue, or single enqueues this many at once */
const FILL_BATCH = 1000;
const FILL_CONCURRENCY = 50;

/**
 * Most jobs go to 10 hot names, every 10th to one of the others: as `pnpm bench:regression`.
 * @param {number} index
 * @returns {string}
 */
function nameOf(index) {
    const hot = Math.min(10, names.length);

    return index % 10 === 9 && names.length > hot
        ? names[hot + (Math.floor(index / 10) % (names.length - hot))]
        : names[(index - Math.floor(index / 10)) % hot];
}

/**
 * @param {number[]} values
 * @param {number} fraction
 * @returns {number | null}
 */
function percentile(values, fraction) {
    const sorted = values.toSorted((a, b) => a - b);

    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] : null;
}

/** @param {object} data */
function write(data) {
    writeFileSync(join(String(args.out), `${role}.json`), JSON.stringify(data));
}

let completed = 0;
/** @type {number[]} The time from enqueue to handler start of the jobs of the window */
const latencies = [];
let inWindow = false;
const scheduleCount = Number(args.schedules);
/** @type {[key: string, slotMs: number | null, startMs: number][]} The scheduled jobs that this worker started */
const scheduled = [];
const backlog = Number(args.backlog);
/** @type {PromiseWithResolvers<void>} The throughput's window starts at the first completion */
const firstDone = Promise.withResolvers();
/** @type {PromiseWithResolvers<boolean>} and ends at the last of the backlog, if it comes before the end */
const drained = Promise.withResolvers();
let firstAt = 0;
let lastAt = 0;
const queue = await adapter.open({
    url,
    dialect: args.dialect,
    names: Object.fromEntries(names.map(name => [name, {}])),
    concurrency: CONCURRENCY,
    pollIntervalMs: POLL_INTERVAL_MS,
    role,
    ...scheduleCount && { schedules: { count: scheduleCount, cron: String(args.cron), index: Number(args.index) } },
    /**
     * @param {string} _name
     * @param {{ t?: number, s?: string }} payload
     * @param {AbortSignal} [_signal]
     * @param {number} [slotMs]
     */
    handler: async (_name, payload, _signal, slotMs) => {
        if (payload.s) {
            scheduled.push([payload.s, slotMs ?? null, Date.now()]);
        }

        if (inWindow && payload.t) {
            latencies.push(Date.now() - payload.t);
        }

        completed++;

        if (backlog) {
            lastAt = performance.now();

            if (completed === 1) {
                firstAt = lastAt;
                firstDone.resolve();
            }

            if (completed === backlog) {
                drained.resolve(true);
            }
        }
    },
});

if (role === 'setup') {
    // A business table for the producer's transactions
    if (mysql) {
        const pool = createPool({ uri: businessUrl });

        await pool.query('CREATE TABLE IF NOT EXISTS orders (id BIGINT PRIMARY KEY)');
        await pool.end();
    } else {
        const pool = new Pool({ connectionString: businessUrl });

        await pool.query('CREATE TABLE IF NOT EXISTS orders (id bigint PRIMARY KEY)');
        await pool.end();
    }

    if (backlog) {
        await fill();
    }

    await queue.stop();
} else if (role === 'worker' && backlog) {
    const done = new Promise((resolve) => {
        process.once('SIGUSR2', resolve);
    });

    await queue.start();
    await firstDone.promise;
    // run.mjs reads the counters from here
    writeFileSync(join(String(args.out), 'first'), '');

    const emptied = await Promise.race([drained.promise, sleep(Number(args.measure) * 1000, false)]);
    // The jobs after the first: in the window, or all of them up to the last
    const count = (emptied ? backlog : completed) - 1;
    const endAt = emptied ? lastAt : performance.now();

    write({ completed: count, seconds: (endAt - firstAt) / 1000, drained: emptied });
    // run.mjs reads the counters, then signals
    await done;
    await queue.stop();
} else if (role === 'worker' && scheduleCount) {
    const index = String(args.index);
    const done = new Promise((resolve) => {
        process.once('SIGUSR2', resolve);
    });

    await queue.start();
    writeFileSync(join(String(args.out), `ready-${index}`), '');
    // run.mjs reads the counters of the window, waits for the late jobs, then signals
    await done;

    writeFileSync(join(String(args.out), `worker-${index}.json`), JSON.stringify({ scheduled }));
    await queue.stop();
} else if (role === 'worker') {
    const warmupMs = Number(args.warmup) * 1000;
    const measureMs = Number(args.measure) * 1000;

    await queue.start();
    // run.mjs starts the producer and the window once the worker is ready
    writeFileSync(join(String(args.out), 'ready'), '');
    await sleep(warmupMs);

    const before = completed;
    let peakRss = process.memoryUsage.rss();
    const rss = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage.rss());
    }, RSS_INTERVAL_MS);

    inWindow = true;
    await sleep(measureMs);
    inWindow = false;
    clearInterval(rss);
    write({
        completed: completed - before,
        latencyP50Ms: percentile(latencies, 0.5),
        latencyP99Ms: percentile(latencies, 0.99),
        // The most of the readings in the window, and at its ends
        workerPeakRssMB: Math.max(peakRss, process.memoryUsage.rss()) / MB,
    });
    await sleep(LINGER_MS);
    await queue.stop();
} else {
    // The producer: each job in a transaction with an INSERT into orders, at a steady rate
    const rate = Number(args.rate);
    const endAt = Date.now() + ((Number(args.warmup) + Number(args.measure)) * 1000);
    const measureFrom = Date.now() + (Number(args.warmup) * 1000);
    /** @type {number[]} The time of each enqueue call after the warm-up, in or after the transaction */
    const enqueueMs = [];
    /**
     * @param {() => Promise<void>} enqueue
     * @returns {Promise<void>} the enqueue, its time noted after the warm-up
     */
    const timed = async (enqueue) => {
        const startedAt = performance.now();

        await enqueue();

        if (Date.now() >= measureFrom) {
            enqueueMs.push(performance.now() - startedAt);
        }
    };
    const pgPool = mysql ? null : new Pool({ connectionString: businessUrl, max: 2 });
    const mysqlPool = mysql ? createPool({ uri: businessUrl, connectionLimit: 2 }) : null;
    let index = Number(process.pid) * 1_000_000;

    for (let next = Date.now(); Date.now() < endAt; next += 1000 / rate) {
        await sleep(Math.max(0, next - Date.now()));
        index++;

        const name = nameOf(index);
        const id = index;
        /**
         * Enqueues in the business transaction, when the library can.
         * @param {any} client
         * @returns {Promise<void> | undefined}
         */
        const enqueueIn = client => (adapter.transactional
            ? timed(() => queue.enqueue(name, { index: id, t: Date.now() }, { client }))
            : undefined);

        if (queue.transaction) {
            // The library's own client: a Knex transaction
            /** @type {(client: any, query: (sql: string, values: any[]) => Promise<unknown>) => Promise<void>} */
            const work = async (client, query) => {
                await query('INSERT INTO orders (id) VALUES (?)', [id]);
                await enqueueIn(client);
            };

            await queue.transaction(work);
        } else if (pgPool) {
            const client = await pgPool.connect();

            try {
                await client.query('BEGIN');
                await client.query('INSERT INTO orders (id) VALUES ($1)', [index]);
                await enqueueIn(client);
                await client.query('COMMIT');
            } finally {
                client.release();
            }
        } else if (mysqlPool) {
            const connection = await mysqlPool.getConnection();

            try {
                await connection.beginTransaction();
                await connection.query('INSERT INTO orders (id) VALUES (?)', [index]);
                await enqueueIn(connection);
                await connection.commit();
            } finally {
                connection.release();
            }
        }

        // A library without transactional enqueue: after the COMMIT, on its own connection. A crash between the two
        // loses the job: not atomic
        if (!adapter.transactional) {
            await timed(() => queue.enqueue(name, { index: id, t: Date.now() }));
        }
    }

    write({
        enqueued: index - (Number(process.pid) * 1_000_000),
        enqueueP50Ms: percentile(enqueueMs, 0.5),
        enqueueP99Ms: percentile(enqueueMs, 0.99),
        // The connections of the business transactions (PostgreSQL), not the library's: run.mjs leaves them out
        businessConnections: pgPool?.totalCount ?? 0,
    });
    await sleep(LINGER_MS);
    await queue.stop();
    await pgPool?.end();
    await mysqlPool?.end();
}

/**
 * The backlog of the throughput: `backlog` jobs of the first name, with the library's bulk enqueue if it has one, in
 * batches; else single enqueues, FILL_CONCURRENCY at once. Not in a business transaction.
 * @returns {Promise<void>}
 */
async function fill() {
    const [name] = names;
    const payloads = Array.from({ length: backlog }, (_, index) => ({ index }));
    const startedAt = performance.now();

    if (queue.enqueueMany) {
        for (let first = 0; first < backlog; first += FILL_BATCH) {
            await queue.enqueueMany(name, payloads.slice(first, first + FILL_BATCH));
        }
    } else {
        let next = 0;

        await Promise.all(Array.from({ length: FILL_CONCURRENCY }, async () => {
            while (next < backlog) {
                await queue.enqueue(name, payloads[next++]);
            }
        }));
    }

    write({ enqueued: backlog, fillSeconds: (performance.now() - startedAt) / 1000, bulk: Boolean(queue.enqueueMany) });
}

// The libraries can leave timers and sockets behind
// oxlint-disable-next-line unicorn/no-process-exit -- a script
process.exit(0);
