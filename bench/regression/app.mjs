// One process of the A/B benchmark (ab.mjs), forked with an IPC channel: `--role setup`, `producer`, `worker` or
// `scheduler`. It loads sqlane from `--src`, a source tree: the working tree, or a baseline that ab.mjs extracts from
// a git ref, with the drivers of this checkout. Only the public API that the baselines have too.
//
// Messages from ab.mjs: `pause` (a producer finishes its operation and starts no other one), `collect` (a scavenge),
// `resume`, `counts`, `runs` and `stop`; each gets a reply with the same `id` and the counts of this process since its
// start. It sends `ready` once it runs.
//
// `--trace <profile>`: the contention scenarios. The producer replays the trace of trace.mjs (`--seed`,
// `--trace-seconds`), each job at its time from the start; the workers run its jobs, each for its duration and with its
// outcome. With `--trace-limits`, the names have the limits of the profile; without, none. A worker keeps, in memory,
// a histogram of the latencies from the enqueue to the first start (in its counts: `latency_<bucket>`), and the job,
// the start and the end of each run, which `runs` returns once, after the window: no message per job.
import { createSocket } from 'node:dgram';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { generateTrace, keyValueOf, latencyBucket, OUTCOME, RETRY_AFTER_MS, RETRY_DELAY_MS, TRACE_SEED } from './trace.mjs';

const { values: args } = parseArgs({
    options: {
        'role': { type: 'string' },
        'src': { type: 'string' },
        'dialect': { type: 'string', default: 'postgres' },
        'url': { type: 'string' },
        'names': { type: 'string', default: '1000' },
        'limit-keys': { type: 'string', default: '0' },
        'rate-limit-keys': { type: 'string', default: '0' },
        // producer
        'op': { type: 'string', default: 'enqueue' },
        'rate': { type: 'string', default: '20' },
        'batch': { type: 'string', default: '100' },
        // scheduler
        'every': { type: 'string', default: '10s' },
        'hint-port': { type: 'string', default: '41234' },
        'cap': { type: 'string', default: '8' },
        'pool': { type: 'string', default: '8' },
        // The contention scenarios
        'trace': { type: 'string' },
        'trace-limits': { type: 'boolean', default: false },
        'seed': { type: 'string', default: String(TRACE_SEED) },
        'trace-seconds': { type: 'string', default: '120' },
        // The workers of a lane, each with its port of the hints of MySQL and MariaDB: `--hint-port` + 10 × its index
        'workers': { type: 'string', default: '1' },
        'worker-index': { type: 'string', default: '0' },
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
const limitKeyCount = Number(args['limit-keys']);
const rateLimitKeyCount = Number(args['rate-limit-keys']);
// The drivers of this checkout, sqlane of the source tree
const require = createRequire(join(src, 'package.json'));
const {
    createSqlane, defineConcurrencyLimit, defineJob, defineRateLimit, RateLimitedError, RetryJobError,
} = await import(join(src, 'src/index.js'));
const names = Array.from({ length: Number(args.names) }, (_, index) => `job_${String(index).padStart(4, '0')}`);
const trace = args.trace
    ? generateTrace({ profile: args.trace, seed: Number(args.seed), seconds: Number(args['trace-seconds']) })
    : null;
/** The ports of the hints: one per worker of the lane */
const hintPorts = Array.from({ length: Number(args.workers) }, (_, index) => hintPort + (10 * index));

/**
 * The pool and the adapter. MySQL and MariaDB have no NOTIFY: a hint over UDP on localhost stands in for Redis.
 * @returns {Promise<{ pool: any, adapter: any, hint: any }>}
 */
async function connect() {
    if (dialect === 'postgres') {
        const { Pool } = require('pg');
        const { pgAdapter } = await import(join(src, 'src/adapters/pg.js'));
        // No idle timeout: the server processes of the connections live through the window
        const pool = new Pool({ connectionString: args.url, max: Number(args.pool), idleTimeoutMillis: 0 });

        return { pool, adapter: pgAdapter(pool, { notify: true }), hint: null };
    }

    const mysql = require('mysql2/promise');
    const { mysql2Adapter } = await import(join(src, 'src/adapters/mysql2.js'));
    const pool = mysql.createPool({ uri: args.url, connectionLimit: Number(args.pool), maxIdle: Number(args.pool) });

    return {
        pool,
        adapter: mysql2Adapter(pool, { dialect }),
        hint: {
            publish: async (/** @type {string} */ channel, /** @type {string} */ message) => {
                const socket = createSocket('udp4');

                for (const port of hintPorts) {
                    // oxlint-disable-next-line no-await-in-loop -- a port per worker: 2 in the contention scenarios
                    await new Promise((resolve) => {
                        socket.send(`${channel}\n${message}`, port, '127.0.0.1', () => resolve(undefined));
                    });
                }

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
                    socket.bind(hintPorts[Number(args['worker-index'])], '127.0.0.1', () => resolve(undefined));
                });

                return async () => {
                    socket.close();
                };
            },
        },
    };
}

const { pool, adapter, hint } = await connect();
// With --limit-keys: one key of a global limit of 1 per job, `account:<index mod limit-keys>`; a mutex key before 6.0
const account = defineConcurrencyLimit?.({ name: 'account', max: 1 });
/**
 * @param {number} index
 * @returns {string} The key of the job.
 */
const keyOf = index => String(index % limitKeyCount);
/**
 * @param {{ payload: { index: number } }} context
 * @returns {unknown} The key of the global limit of the job.
 */
const limitKeyOf = ({ payload }) => account.key(keyOf(payload.index));
/** @type {Record<string, unknown>} */
const limits = account
    ? { globalConcurrencyLimits: (/** @type {{ payload: { index: number } }} */ context) => [limitKeyOf(context)] }
    : { mutexKeys: (/** @type {{ index: number }} */ payload) => [`account:${keyOf(payload.index)}`] };

if (rateLimitKeyCount > 0 && !defineRateLimit) {
    throw new Error(`--rate-limit-keys: the sqlane of ${src} has no defineRateLimit`);
}

// With --rate-limit-keys: one key of a global rate limit of 1/s per job, `<index mod rate-limit-keys>`
const api = rateLimitKeyCount > 0 ? defineRateLimit({ name: 'api', max: 1, per: '1s' }) : null;
/** @type {Record<string, unknown>} */
const rateLimits = {
    globalRateLimits: (/** @type {{ payload: { index: number } }} */ { payload }) => [
        api.key(String(payload.index % rateLimitKeyCount)),
    ],
};
/** @type {any[]} */
let definitions;

if (trace) {
    definitions = traceDefinitions(trace);
} else {
    definitions = names.map(name => defineJob({
        name,
        ...limitKeyCount > 0 && { ...limits, timeout: '1m' },
        ...rateLimitKeyCount > 0 && { ...rateLimits, timeout: '1m' },
    }));
}

/** @type {Record<string, number>} */
const counts = { ops: 0, jobs: 0, completed: 0, fired: 0, errors: 0, ...trace && { retried: 0, rateLimited: 0 } };

/**
 * @param {any} limit
 * @param {import('./trace.mjs').Limit} settings
 * @param {import('./trace.mjs').Payload} payload
 * @returns {unknown} The limit, or its key of the job.
 */
function keyed(limit, settings, payload) {
    const value = keyValueOf(settings, payload);

    return value === null ? limit : limit.key(value);
}

/**
 * The definitions of the names of the trace: all with a timeout and a short fixed backoff; with `--trace-limits`, with
 * their limits, keyed by the payload.
 * @param {import('./trace.mjs').Trace} traced
 * @returns {any[]}
 */
function traceDefinitions(traced) {
    if (args['trace-limits'] && !defineRateLimit) {
        throw new Error(`--trace-limits: the sqlane of ${src} has no defineRateLimit`);
    }

    const concurrency = traced.limits.concurrency.map(({ name, max }) => defineConcurrencyLimit({ name, max }));
    const rate = traced.limits.rate.map(({ name, max, perMs, burst }) => defineRateLimit({
        name, max, per: perMs, burst,
    }));
    return traced.names.map(({ name, concurrency: concurrencyOf, rate: rateOf }) => defineJob({
        name,
        timeout: '1m',
        backoff: { type: 'fixed', delay: RETRY_DELAY_MS, jitter: 0 },
        ...args['trace-limits'] && concurrencyOf.length > 0 && {
            globalConcurrencyLimits: (/** @type {{ payload: any }} */ { payload }) => concurrencyOf.map(index => keyed(
                concurrency[index], traced.limits.concurrency[index], payload,
            )),
        },
        ...args['trace-limits'] && rateOf.length > 0 && {
            globalRateLimits: (/** @type {{ payload: any }} */ { payload }) => rateOf.map(index => keyed(
                rate[index], traced.limits.rate[index], payload,
            )),
        },
    }));
}

/**
 * The instance, with its cap as the version of `--src` names it: `localMaxConcurrency` from 6.0, `maxConcurrency` in
 * 5.x, `concurrency` before.
 * @param {Record<string, unknown>} options
 * @returns {any}
 */
function createInstance(options) {
    const max = Number(args.cap);

    for (const cap of ['localMaxConcurrency', 'maxConcurrency']) {
        try {
            return createSqlane({ ...options, [cap]: max });
        } catch {
            // An older version: the next name
        }
    }

    return createSqlane({ ...options, concurrency: max });
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
        } else if (trace && event.type === 'retried') {
            counts.retried++;
        } else if (trace && event.type === 'rate_limited') {
            counts.rateLimited++;
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
const fixedProducer = {
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

/**
 * The producer of `--trace`: each job of the trace at its time from the start, without waiting for the jobs before it
 * (at most `--pool` at once). A pause moves the times that follow by its length. A trace that ends before `stop` is an
 * error: it must outlast the window.
 */
const replayProducer = {
    stopped: false,
    /** @type {PromiseWithResolvers<void> | null} */
    paused: null,
    /** @type {Set<Promise<void>>} */
    inFlight: new Set(),
    /** @returns {Promise<unknown>} The enqueues in flight */
    get current() {
        return Promise.all(this.inFlight);
    },
    async run() {
        const jobs = /** @type {import('./trace.mjs').Trace} */ (trace).jobs;
        const maxInFlight = Number(args.pool);
        let startedAt = Date.now();

        for (let index = 0; !this.stopped; index++) {
            if (index === jobs.length) {
                counts.errors++;
                console.error(`The trace ended after ${jobs.length} jobs: --trace-seconds is too short`);
                break;
            }

            // oxlint-disable-next-line no-await-in-loop -- the jobs at their times
            await sleep(Math.max(0, startedAt + jobs[index].at - Date.now()));

            if (this.paused) {
                const pausedAt = Date.now();

                // oxlint-disable-next-line no-await-in-loop -- waits for `resume`
                await this.paused.promise;
                startedAt += Date.now() - pausedAt;
                index--;
                continue;
            }

            if (this.stopped) {
                break;
            }

            const job = jobs[index];
            const enqueue = (async () => {
                try {
                    await sqlane.enqueue(pool, definitions[job.name], job.payload);
                    counts.jobs++;
                    counts.ops++;
                } catch (error) {
                    counts.errors++;
                    console.error(error);
                }
            })();

            this.inFlight.add(enqueue);
            // oxlint-disable-next-line promise/prefer-await-to-then -- not awaited: the next job does not wait for it
            void enqueue.finally(() => this.inFlight.delete(enqueue));

            if (this.inFlight.size >= maxInFlight) {
                // oxlint-disable-next-line no-await-in-loop -- at most `--pool` at once
                await Promise.race(this.inFlight);
            }
        }

        await this.current;
    },
};
const producer = trace ? replayProducer : fixedProducer;
/** The runs of the trace's jobs in a worker, one per attempt; `end` 0 while it runs */
const runs = { index: /** @type {number[]} */ ([]), start: /** @type {number[]} */ ([]),
    end: /** @type {number[]} */ ([]), enqueuedAt: /** @type {number[]} */ ([]) };
/** @type {Map<number, number>} The latencies from the enqueue to the first start: bucket → jobs */
const latencies = new Map();

/**
 * The handler of a job of the trace: it runs for the job's duration, then completes or throws, as its outcome says.
 * A job that throws once fails its first attempt. A rate-limited job throws a RateLimitedError (on its rate limits:
 * with `--trace-limits`, it waits without using an attempt; without, it is retried after it, with an attempt) when it
 * starts within RETRY_AFTER_MS of its enqueue: so once, wherever it runs again.
 * @param {{ payload: import('./trace.mjs').Payload, job: { attempt: number, enqueuedAt?: Date } }} context
 * @returns {Promise<void>}
 */
async function runTraceJob({ payload, job }) {
    const startedAt = Date.now();
    const traced = /** @type {import('./trace.mjs').Trace} */ (trace).jobs[payload.i];
    const enqueuedAt = job.enqueuedAt?.getTime() ?? Number.NaN;
    const sinceEnqueue = startedAt - enqueuedAt;
    const rerun = traced.outcome === OUTCOME.rateLimited && sinceEnqueue >= RETRY_AFTER_MS;
    const run = runs.index.push(payload.i) - 1;

    runs.start.push(startedAt);
    runs.end.push(0);
    runs.enqueuedAt.push(enqueuedAt);

    if (job.attempt === 1 && !rerun) {
        const bucket = latencyBucket(Math.max(0, sinceEnqueue));

        latencies.set(bucket, (latencies.get(bucket) ?? 0) + 1);
    }

    try {
        await sleep(traced.durationMs);
    } finally {
        runs.end[run] = Date.now();
    }

    if (traced.outcome === OUTCOME.failsOnce && job.attempt === 1) {
        throw new Error('The trace: this job fails once');
    }

    if (traced.outcome === OUTCOME.rateLimited && !rerun) {
        if (RateLimitedError) {
            throw new RateLimitedError({ retryAfter: RETRY_AFTER_MS });
        }

        throw RetryJobError ? new RetryJobError('The trace: rate limited', { delay: RETRY_AFTER_MS }) : new Error('429');
    }
}

/**
 * @returns {Record<string, number>} The counts, with the histogram of the latencies.
 */
function countsWithLatencies() {
    if (!trace) {
        return counts;
    }

    return { ...counts, ...Object.fromEntries([...latencies].map(([bucket, jobs]) => [`latency_${bucket}`, jobs])) };
}

/** @type {Promise<void> | null} */
let producerDone = null;

if (role === 'setup') {
    await sqlane.migrate();
} else if (role === 'worker') {
    for (const definition of definitions) {
        sqlane.handle(definition, trace ? runTraceJob : async () => {});
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
        } else if (message.type === 'collect') {
            // A scavenge before the window (--expose-gc)
            globalThis.gc?.({ type: 'minor' });
        } else if (message.type === 'resume') {
            producer.paused?.resolve();
            producer.paused = null;
        } else if (message.type === 'stop') {
            await stop();
        }

        process.send?.({ id: message.id, counts: countsWithLatencies(), ...message.type === 'runs' && { runs } });

        if (message.type === 'stop') {
            process.disconnect();
        }
    });
    process.send?.({ type: 'ready' });
}
