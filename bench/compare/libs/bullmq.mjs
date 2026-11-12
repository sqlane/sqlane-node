// BullMQ on its PostgreSQL backend: a queue and a worker per job name.
import { readFileSync } from 'node:fs';
import { createPostgresBackend, Queue, Worker } from 'bullmq';
import { UnsupportedError } from './common.mjs';

const { version } = JSON.parse(readFileSync(new URL('../node_modules/bullmq/package.json', import.meta.url), 'utf8'));

/** @type {import('./common.mjs').Adapter} */
export const adapter = {
    version,
    // No API takes the caller's transaction: the performance runs enqueue after the COMMIT
    transactional: false,
    databases: [],
    async open({ url, names, handler, concurrency = 4, stall = false }) {
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

        // A config, not a pool: BullMQ then sets the search_path of its schema, and migrates
        const connection = { connection: { connectionString: url, max: 5, migrate: true } };
        const queues = new Map(Object.keys(names).map(
            name => [name, new Queue(name, connection, createPostgresBackend)],
        ));
        const workers = Object.keys(names).map(name => new Worker(
            name,
            (job, _token, signal) => handler(name, job.data, signal),
            {
                ...connection,
                concurrency,
                autorun: false,
                ...stall && { lockDuration: 2000, stalledInterval: 1000 },
            },
            createPostgresBackend,
        ));

        for (const worker of workers) {
            worker.on('error', () => {});
        }

        if (stall) {
            notes.push('`lockDuration: 2 s`, `stalledInterval: 1 s` (default: 30 s each)');
        }

        return {
            notes,
            enqueue: async (name, payload, { delayMs, priority, client } = {}) => {
                const spec = names[name];

                if (client && !notes.includes('enqueue on its own connection: no API takes the caller\'s')) {
                    notes.push('enqueue on its own connection: no API takes the caller\'s');
                }

                const queue = queues.get(name);

                if (!queue) {
                    throw new Error(`no queue ${name}`);
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
                for (const worker of workers) {
                    // Resolves when the worker stops
                    void worker.run();
                }
            },
            stop: async () => {
                await Promise.all(workers.map(worker => worker.close(true)));
                await Promise.all([...queues.values()].map(queue => queue.close()));
            },
        };
    },
};
