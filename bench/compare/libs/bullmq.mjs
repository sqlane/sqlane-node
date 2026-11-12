/* oxlint-disable no-await-in-loop -- the setup stores the schedulers one after the other */
// BullMQ: one queue for all the job names, as BullMQ models them (a job has a name), and one worker. On Redis (a
// redis:// URL, with ioredis) or on its PostgreSQL backend.
//
// Settings: its defaults, with the worker's `concurrency` of the run. A worker blocks on Redis for the next job, so it
// needs no poll; jobs stay after they complete (`removeOnComplete`, default: kept).
//
// Schedules: a job scheduler per schedule (`upsertJobScheduler`), stored by the setup. A scheduler keeps one delayed
// job, `repeat:<id>:<slot ms>`, and the worker that takes it adds the next: the job id makes a slot one job.
import { readFileSync } from 'node:fs';
import { createPostgresBackend, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { queryRows, scheduleKeys, UnsupportedError } from './common.mjs';

const { version } = JSON.parse(readFileSync(new URL('../node_modules/bullmq/package.json', import.meta.url), 'utf8'));
const QUEUE = 'bench';

/** @type {import('./common.mjs').Adapter} */
export const adapter = {
    version,
    // No API takes the caller's transaction: the performance runs enqueue after the COMMIT
    transactional: false,
    databases: ['redis', 'postgres'],
    // The jobs of the schedulers: `repeat:<schedule key>:<slot ms>`, in Redis or in its table
    scheduledJobs: async (url) => {
        /** @type {string[]} */
        let ids = [];

        if (url.startsWith('redis:')) {
            const redis = new Redis(url);

            try {
                ids = (await redis.keys(`bull:${QUEUE}:repeat:*:*`)).map(key => key.slice(`bull:${QUEUE}:`.length));
            } finally {
                redis.disconnect();
            }
        } else {
            ids = (await queryRows(url, `SELECT id FROM bullmq.job WHERE queue = '${QUEUE}' AND id LIKE 'repeat:%'`))
                .map(row => row.id);
        }

        return {
            jobs: ids.map(id => id.split(':')).filter(parts => parts.length === 3)
                .map(([, key, slot]) => [key, new Date(Number(slot)).toISOString()]),
        };
    },
    async open({ url, names, handler, concurrency = 4, stall = false, role, schedules }) {
        /** @type {string[]} */
        const notes = [];

        for (const spec of Object.values(names)) {
            if (spec.exclusive) {
                throw new UnsupportedError('no exclusion of jobs by resource (group concurrency is BullMQ Pro)');
            }

            if (spec.timeoutMs && !stall) {
                throw new UnsupportedError('no job timeout');
            }
        }

        const redis = url.startsWith('redis:');
        const { hostname, port } = new URL(url);
        // Redis: ioredis needs no retry limit per request for a worker. PostgreSQL: a config, not a pool: BullMQ then
        // sets the search_path of its schema, and migrates
        const options = redis
            ? { connection: { host: hostname, port: Number(port), maxRetriesPerRequest: null } }
            // No idle timeout: a closed connection takes its CPU counters with it (see docs/cpu-cost.md, pitfall 5)
            : { connection: { connectionString: url, max: 5, idleTimeoutMillis: 0, migrate: true } };
        const queue = redis ? new Queue(QUEUE, options) : new Queue(QUEUE, options, createPostgresBackend);
        /** @type {import('bullmq').Processor} */
        // A job of a scheduler: its slot in `prevMillis`
        const processor = (job, _token, signal) => handler(
            job.name, job.data, signal, job.repeatJobKey ? Number(job.opts.prevMillis) : undefined,
        );
        const workerOptions = {
            ...options,
            concurrency,
            autorun: false,
            ...stall && { lockDuration: 2000, stalledInterval: 1000 },
        };
        /** @type {Worker<any, any, string, any, any, any> | null} A producer and the setup only add jobs */
        let worker = null;

        if (role !== 'producer' && role !== 'setup') {
            worker = redis
                ? new Worker(QUEUE, processor, workerOptions)
                : new Worker(QUEUE, processor, workerOptions, createPostgresBackend);
        }

        worker?.on('error', () => {});

        if (stall) {
            notes.push('`lockDuration: 2 s`, `stalledInterval: 1 s` (default: 30 s each)');
        }

        // The queue exists once it is ready: the setup migrates the PostgreSQL backend
        await queue.waitUntilReady();

        // The schedulers live in Redis or in its tables: the setup stores them
        if (schedules && role === 'setup') {
            const [name] = Object.keys(names);

            for (const key of scheduleKeys(schedules.count)) {
                await queue.upsertJobScheduler(key, { pattern: schedules.cron, tz: 'UTC' }, { name, data: { s: key } });
            }
        }

        return {
            notes,
            enqueue: async (name, payload, { delayMs, priority, client } = {}) => {
                const spec = names[name];

                if (client && !notes.includes('enqueue on its own connection: no API takes the caller\'s')) {
                    notes.push('enqueue on its own connection: no API takes the caller\'s');
                }

                await queue.add(name, payload, {
                    attempts: spec.maxAttempts ?? 1,
                    ...spec.backoffMs !== undefined && { backoff: { type: 'fixed', delay: spec.backoffMs } },
                    ...delayMs && { delay: delayMs },
                    // 1 is the highest
                    ...priority && { priority: priority === 'high' ? 1 : 10 },
                });
            },
            start: async () => {
                // Resolves when the worker stops
                void worker?.run();
            },
            stop: async () => {
                await worker?.close(true);
                await queue.close();
            },
        };
    },
};
