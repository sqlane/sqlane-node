// One process of the performance comparison (see run.mjs): `--role setup`, `worker` or `producer`.
//
//   node perf.mjs --role worker --library sqlane --url <url> --names 1000 --out <dir> [--warmup 5 --measure 15]
//       [--tuned]
//
// The worker and the producer write their numbers to `<out>/<role>.json`. The worker runs empty handlers; the
// producer enqueues `--rate` jobs per second, each in a transaction with a business INSERT.
/* oxlint-disable no-await-in-loop -- a fixture, and a producer: one step after the other */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createPool } from 'mysql2/promise';
import { Pool } from 'pg';

const { values: args } = parseArgs({
    options: {
        role: { type: 'string' },
        library: { type: 'string' },
        url: { type: 'string' },
        dialect: { type: 'string', default: 'mysql' },
        names: { type: 'string', default: '1000' },
        rate: { type: 'string', default: '20' },
        backlog: { type: 'string', default: '0' },
        warmup: { type: 'string', default: '5' },
        measure: { type: 'string', default: '15' },
        out: { type: 'string', default: '.' },
        tuned: { type: 'boolean', default: false },
    },
});
const url = String(args.url);
const mysql = url.startsWith('mysql:');
const role = /** @type {'setup' | 'worker' | 'producer'} */ (args.role);
const names = Array.from({ length: Number(args.names) }, (_, index) => `job_${String(index).padStart(4, '0')}`);
const { adapter } = await import(`./libs/${String(args.library).replaceAll('-', '_')}.mjs`);
/** Each library's own wakes run, plus a poll of 5 s */
const POLL_INTERVAL_MS = 5000;
/** The worker and the producer outlive the window: run.mjs reads their counters at its end */
const LINGER_MS = 3000;
const CONCURRENCY = 8;

/**
 * Most jobs go to 10 hot names, every 10th to one of the others: as bench:cpu.
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
const queue = await adapter.open({
    url,
    dialect: args.dialect,
    names: Object.fromEntries(names.map(name => [name, {}])),
    concurrency: CONCURRENCY,
    pollIntervalMs: POLL_INTERVAL_MS,
    role,
    tuned: args.tuned,
    handler: async (/** @type {string} */ _name, /** @type {{ t?: number }} */ payload) => {
        if (inWindow && payload.t) {
            latencies.push(Date.now() - payload.t);
        }

        completed++;
    },
});

if (role === 'setup') {
    const backlog = Number(args.backlog);

    // A business table for the producer's transactions
    if (mysql) {
        const pool = createPool({ uri: url });

        await pool.query('CREATE TABLE IF NOT EXISTS orders (id BIGINT PRIMARY KEY)');
        await pool.end();
    } else {
        const pool = new Pool({ connectionString: url });

        await pool.query('CREATE TABLE IF NOT EXISTS orders (id bigint PRIMARY KEY)');
        await pool.end();
    }

    // Due jobs for the drain: spread over the names, 8 enqueues at a time
    for (let start = 0; start < backlog; start += 8) {
        await Promise.all(Array.from({ length: Math.min(8, backlog - start) }, (_, offset) => (
            queue.enqueue(names[(start + offset) % names.length], { index: start + offset })
        )));
    }

    await queue.stop();
} else if (role === 'worker') {
    const warmupMs = Number(args.warmup) * 1000;
    const measureMs = Number(args.measure) * 1000;
    const backlog = Number(args.backlog);
    const startedAt = Date.now();

    await queue.start();
    // run.mjs starts the producer and the window once the worker is ready
    writeFileSync(join(String(args.out), 'ready'), '');

    if (backlog) {
        // The drain: until the backlog is done (the handler counts)
        // oxlint-disable-next-line no-unmodified-loop-condition -- the handlers change completed
        while (completed < backlog) {
            await sleep(10);
        }

        write({ completed, drainMs: Date.now() - startedAt });
    } else {
        await sleep(warmupMs);

        const before = completed;

        inWindow = true;
        await sleep(measureMs);
        inWindow = false;
        write({
            completed: completed - before,
            latencyP50Ms: percentile(latencies, 0.5),
            latencyP99Ms: percentile(latencies, 0.99),
        });
    }

    await sleep(LINGER_MS);
    await queue.stop();
} else {
    // The producer: each job in a transaction with an INSERT into orders, at a steady rate
    const rate = Number(args.rate);
    const endAt = Date.now() + ((Number(args.warmup) + Number(args.measure)) * 1000);
    const pgPool = mysql ? null : new Pool({ connectionString: url, max: 2 });
    const mysqlPool = mysql ? createPool({ uri: url, connectionLimit: 2 }) : null;
    let index = Number(process.pid) * 1_000_000;

    for (let next = Date.now(); Date.now() < endAt; next += 1000 / rate) {
        await sleep(Math.max(0, next - Date.now()));
        index++;

        const name = nameOf(index);

        if (pgPool) {
            const client = await pgPool.connect();

            try {
                await client.query('BEGIN');
                await client.query('INSERT INTO orders (id) VALUES ($1)', [index]);
                await queue.enqueue(name, { index, t: Date.now() }, { client });
                await client.query('COMMIT');
            } finally {
                client.release();
            }
        } else if (mysqlPool) {
            const connection = await mysqlPool.getConnection();

            try {
                await connection.beginTransaction();
                await connection.query('INSERT INTO orders (id) VALUES (?)', [index]);
                await queue.enqueue(name, { index, t: Date.now() }, { client: connection });
                await connection.commit();
            } finally {
                connection.release();
            }
        }
    }

    write({ enqueued: index - (Number(process.pid) * 1_000_000) });
    await sleep(LINGER_MS);
    await queue.stop();
    await pgPool?.end();
    await mysqlPool?.end();
}

// The libraries can leave timers and sockets behind
// oxlint-disable-next-line unicorn/no-process-exit -- a script
process.exit(0);
