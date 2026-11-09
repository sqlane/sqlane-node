// The quickstart on PostgreSQL: `docker compose up -d --wait postgres`, then `npm run postgres`.
// 1. A job commits with the business data, and runs right after the commit.
// 2. A rollback removes the business data and the job.
// 3. Jobs with a common mutex key run one at a time; other keys run alongside.
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { createSqlane, defineJob } from '@sqlane/core';
import { pgAdapter } from '@sqlane/core/adapter-pg';

const url = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:15432/app';
const appPool = new Pool({ connectionString: url }); // the app's: business transactions
const queuePool = new Pool({ connectionString: url, max: 3 }); // the queue's own: claims, leases, results

// The job definitions: producers and workers import them
const sendReceipt = defineJob({ name: 'send_receipt' });
const syncOrder = defineJob({
    name: 'sync_order',
    mutexKeys: payload => [`order:${payload.orderId}`], // one sync per order at a time, in the whole cluster
    timeout: '1m',
});

const events = new EventEmitter();
const sqlane = createSqlane({
    adapter: pgAdapter(queuePool, { notify: true }), // NOTIFY wakes the workers of other processes at the commit
    jobs: [sendReceipt, syncOrder],
    onEvent: event => events.emit(event.type, event),
});

await sqlane.migrate(); // creates the sqlane_* tables
await appPool.query('DROP TABLE IF EXISTS orders');
await appPool.query('CREATE TABLE orders (id INT PRIMARY KEY)');

// The worker: in this process here, usually in other processes too
let committedAt = 0;
const timeline = [];
const startedAt = performance.now();

sqlane.handle(sendReceipt, ({ payload }) => {
    console.log(`   send_receipt of order ${payload.orderId} ran ${ms(performance.now() - committedAt)} after the commit`);
});
sqlane.handle(syncOrder, async ({ payload, signal }) => {
    timeline.push({ order: payload.orderId, event: 'start', at: performance.now() - startedAt });
    await sleep(200, undefined, { signal }); // the work: stops when sqlane aborts the signal
    timeline.push({ order: payload.orderId, event: 'end', at: performance.now() - startedAt });
}, { concurrency: 4 });
await sqlane.start();

console.log('1. Commit: order 1 and its job');
let done = completions(1);

await transaction(async (client) => {
    await client.query('INSERT INTO orders (id) VALUES ($1)', [1]);
    await sqlane.enqueue(client, sendReceipt, { orderId: 1 });
});
committedAt = performance.now();
await done;

console.log('2. Rollback: order 2 and its job');
await transaction(async (client) => {
    await client.query('INSERT INTO orders (id) VALUES ($1)', [2]);
    await sqlane.enqueue(client, sendReceipt, { orderId: 2 }, { jobId: 'order-2' });
    throw new Error('payment declined');
}).catch(error => console.log(`   rolled back: ${error.message}`));

const { rows: [orders] } = await appPool.query('SELECT COUNT(*)::int AS n FROM orders WHERE id = 2');
const { rows: [jobs] } = await appPool.query('SELECT COUNT(*)::int AS n FROM sqlane_jobs WHERE id = $1', ['send_receipt:order-2']);

console.log(`   order 2: ${orders.n} rows in orders, ${jobs.n} jobs`);

console.log('3. Mutex keys: 3 syncs of order 1, 1 sync of order 3');
done = completions(4);
await sqlane.enqueueMany(appPool, syncOrder, [1, 1, 1, 3].map(orderId => ({ payload: { orderId } })));
await done;
printTimeline();

await sqlane.close();
await appPool.end();
await queuePool.end();

/**
 * Runs func in a transaction of the app: commits when it returns, rolls back when it throws.
 * @param {(client: import('pg').PoolClient) => Promise<void>} func
 */
async function transaction(func) {
    const client = await appPool.connect();

    try {
        await client.query('BEGIN');
        await func(client);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/**
 * @param {number} count
 * @returns {Promise<void>} Resolves when count more jobs have completed.
 */
function completions(count) {
    let left = count;

    return new Promise((resolve) => {
        events.on('completed', function onCompleted() {
            if (--left === 0) {
                events.off('completed', onCompleted);
                resolve();
            }
        });
    });
}

function printTimeline() {
    const origin = timeline[0].at;
    const running = { 1: 0, 3: 0 }; // the syncs running, by order
    let maxOrder1 = 0;
    let overlap = false;

    for (const { order, event, at } of timeline.toSorted((a, b) => a.at - b.at)) {
        running[order] += event === 'start' ? 1 : -1;
        maxOrder1 = Math.max(maxOrder1, running[1]);
        overlap ||= running[1] > 0 && running[3] > 0;
        console.log(`   ${ms(at - origin).padStart(6)}  sync of order ${order} ${event}s`);
    }

    console.log(`   order 1: at most ${maxOrder1} sync at a time; order 3 ran alongside: ${overlap ? 'yes' : 'no'}`);
}

/**
 * @param {number} value
 * @returns {string}
 */
function ms(value) {
    return `${Math.round(value)} ms`;
}
