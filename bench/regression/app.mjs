// One process of the A/B benchmark (ab.mjs), forked with an IPC channel: `--role setup`, `producer`, `worker` or
// `scheduler`. It loads sqlane from `--src`, a source tree: the working tree, or a baseline that ab.mjs extracts from
// a git ref, with the drivers of this checkout. Only the public API that the baselines have too.
//
// Messages from ab.mjs: `pause` (a producer finishes its operation and starts no other one), `resume`, `counts`, and
// `stop`; each gets a reply with the same `id` and the counts of this process since its start. It sends `ready` once
// it runs.
import { createSocket } from 'node:dgram';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
    options: {
        'role': { type: 'string' },
        'src': { type: 'string' },
        'dialect': { type: 'string', default: 'postgres' },
        'url': { type: 'string' },
        'names': { type: 'string', default: '1000' },
        'mutex-keys': { type: 'string', default: '0' },
        // producer
        'op': { type: 'string', default: 'enqueue' },
        'rate': { type: 'string', default: '20' },
        'batch': { type: 'string', default: '100' },
        // scheduler
        'every': { type: 'string', default: '10s' },
        'hint-port': { type: 'string', default: '41234' },
    },
});

/**
 * The runner starts its periodic tasks (stale-job recovery every 30 s, cleanup every 5 min) at a random time of their
 * first interval: with values from 0.95 to 1, they come after the measured windows of the steady scenarios, in both
 * variants. The other random delays (contention back-off, lease renewal) do not decide the work of the scenarios.
 * ULIDs take crypto's randomness.
 */
let seed = 1;

Math.random = () => {
    // A linear congruential generator: the same values in each run
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;

    return 0.95 + ((seed / 4_294_967_296) * 0.05);
};

const src = String(args.src);
const dialect = String(args.dialect);
const role = String(args.role);
const hintPort = Number(args['hint-port']);
const mutexKeyCount = Number(args['mutex-keys']);
// The drivers of this checkout, sqlane of the source tree
const require = createRequire(join(src, 'package.json'));
const { createSqlane, defineJob } = await import(join(src, 'src/index.js'));
const names = Array.from({ length: Number(args.names) }, (_, index) => `job_${String(index).padStart(4, '0')}`);

/**
 * The pool and the adapter. MySQL and MariaDB have no NOTIFY: a hint over UDP on localhost stands in for Redis.
 * @returns {Promise<{ pool: any, adapter: any, hint: any }>}
 */
async function connect() {
    if (dialect === 'postgres') {
        const { Pool } = require('pg');
        const { pgAdapter } = await import(join(src, 'src/adapters/pg.js'));
        // No idle timeout: the server processes of the connections live through the window
        const pool = new Pool({ connectionString: args.url, max: 8, idleTimeoutMillis: 0 });

        return { pool, adapter: pgAdapter(pool, { notify: true }), hint: null };
    }

    const mysql = require('mysql2/promise');
    const { mysql2Adapter } = await import(join(src, 'src/adapters/mysql2.js'));
    const pool = mysql.createPool({ uri: args.url, connectionLimit: 8, maxIdle: 8 });

    return {
        pool,
        adapter: mysql2Adapter(pool, { dialect }),
        hint: {
            publish: async (/** @type {string} */ channel, /** @type {string} */ message) => {
                const socket = createSocket('udp4');

                await new Promise((resolve) => {
                    socket.send(`${channel}\n${message}`, hintPort, '127.0.0.1', () => resolve(undefined));
                });
                socket.close();
            },
            subscribe: async (/** @type {string} */ channel, /** @type {(message: string) => void} */ onMessage) => {
                const socket = createSocket('udp4');

                socket.on('message', (buffer) => {
                    const [messageChannel, message] = buffer.toString().split('\n');

                    if (messageChannel === channel) {
                        onMessage(message);
                    }
                });
                await new Promise((resolve) => {
                    socket.bind(hintPort, '127.0.0.1', () => resolve(undefined));
                });

                return async () => {
                    socket.close();
                };
            },
        },
    };
}

const { pool, adapter, hint } = await connect();
// With --mutex-keys: one mutex key per job, `account:<index mod mutex-keys>`
const definitions = names.map(name => defineJob({
    name,
    ...mutexKeyCount > 0 && {
        mutexKeys: (/** @type {{ index: number }} */ payload) => [`account:${payload.index % mutexKeyCount}`],
        timeout: '1m',
    },
}));
const counts = { ops: 0, jobs: 0, completed: 0, fired: 0, errors: 0 };

/**
 * The instance, with its cap as the version of `--src` names it: `localMaxConcurrency` from 6.0, `maxConcurrency` in
 * 5.x, `concurrency` before.
 * @param {Record<string, unknown>} options
 * @returns {any}
 */
function createInstance(options) {
    for (const cap of ['localMaxConcurrency', 'maxConcurrency']) {
        try {
            return createSqlane({ ...options, [cap]: 8 });
        } catch {
            // An older version: the next name
        }
    }

    return createSqlane({ ...options, concurrency: 8 });
}

const sqlane = createInstance({
    adapter,
    hint,
    jobs: definitions,
    onEvent: (/** @type {{ type: string }} */ event) => {
        if (event.type === 'completed') {
            counts.completed++;
        } else if (event.type === 'schedule_fired') {
            counts.fired++;
        } else if (event.type === 'error' || event.type === 'failed') {
            counts.errors++;
            console.error(event);
        }
    },
});

/**
 * Most jobs go to the 10 hot names, every 10th to one of the others.
 * @param {number} index
 * @returns {any} The definition.
 */
function definitionOf(index) {
    const hot = Math.min(10, names.length);
    const nameIndex = index % 10 === 9 && names.length > hot
        ? hot + (Math.floor(index / 10) % (names.length - hot))
        : (index - Math.floor(index / 10)) % hot;

    return definitions[nameIndex];
}

/**
 * One operation of the producer, counted.
 * @param {number} index
 * @param {number} batch
 * @returns {Promise<void>}
 */
async function operation(index, batch) {
    const definition = definitionOf(index);

    try {
        if (args.op === 'enqueue_many') {
            const items = Array.from({ length: batch }, (_, offset) => ({
                payload: { index: (index * batch) + offset },
            }));

            await sqlane.enqueueMany(pool, definition, items);
            counts.jobs += batch;
        } else {
            await sqlane.enqueue(pool, definition, { index });
            counts.jobs++;
        }

        counts.ops++;
    } catch (error) {
        counts.errors++;
        console.error(error);
    }
}

/**
 * The producer: one operation every 1/rate s, one after the other. `enqueue`: a job, in a transaction of its own (a
 * pool: sqlane opens it). `enqueue_many`: `--batch` jobs of one name.
 */
const producer = {
    stopped: false,
    /** @type {PromiseWithResolvers<void> | null} A pause: resolved by `resume` */
    paused: null,
    /** @type {Promise<void>} The operation in flight */
    current: Promise.resolve(),
    async run() {
        const intervalMs = 1000 / Number(args.rate);
        const batch = Number(args.batch);
        let startedAt = Date.now();

        for (let index = 0; !this.stopped; index++) {
            // oxlint-disable-next-line no-await-in-loop -- a fixed schedule: one operation after the other
            await sleep(startedAt + (index * intervalMs) - Date.now());

            if (this.paused) {
                const pausedAt = Date.now();

                // oxlint-disable-next-line no-await-in-loop -- waits for `resume`
                await this.paused.promise;
                // The schedule moves by the pause: no burst to catch up
                startedAt += Date.now() - pausedAt;
                index--;
                continue;
            }

            if (this.stopped) {
                break;
            }

            this.current = operation(index, batch);
            // oxlint-disable-next-line no-await-in-loop -- one operation after the other
            await this.current;
        }
    },
};

/** @type {Promise<void> | null} */
let producerDone = null;

if (role === 'setup') {
    await sqlane.migrate();
} else if (role === 'worker') {
    for (const definition of definitions) {
        sqlane.handle(definition, async () => {});
    }

    await sqlane.start();
} else if (role === 'scheduler') {
    // The schedules of all names, no handler
    for (const definition of definitions) {
        sqlane.schedule(definition, { every: String(args.every) });
    }

    await sqlane.start();
} else if (role === 'producer') {
    producerDone = producer.run();
} else {
    throw new Error(`--role ${role}: setup, worker, scheduler or producer`);
}

/**
 * @returns {Promise<void>}
 */
async function stop() {
    producer.stopped = true;
    producer.paused?.resolve();
    await producerDone;
    await sqlane.close({ deadline: '5s' });
    await pool.end();
}

if (role === 'setup') {
    await stop();
    process.disconnect?.();
} else {
    process.on('message', async (/** @type {{ id: number, type: string }} */ message) => {
        if (message.type === 'pause' && !producer.paused) {
            producer.paused = Promise.withResolvers();
            await producer.current;
        } else if (message.type === 'resume') {
            producer.paused?.resolve();
            producer.paused = null;
        } else if (message.type === 'stop') {
            await stop();
        }

        process.send?.({ id: message.id, counts });

        if (message.type === 'stop') {
            process.disconnect();
        }
    });
    process.send?.({ type: 'ready' });
}
