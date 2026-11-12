// River for JavaScript: one client, the default queue, a job kind per job name.
import { readFileSync } from 'node:fs';
import { PgDriver } from '@riverqueue/driver-pg';
import { createMigrator } from '@riverqueue/migrate';
import { Pool } from 'pg';
import { Client, defineJob, Workers } from 'riverqueue';
import { UnsupportedError } from './common.mjs';

const { version } = JSON.parse(readFileSync(new URL('../node_modules/riverqueue/package.json', import.meta.url), 'utf8'));

/** @type {import('./common.mjs').Adapter} */
export const adapter = {
    version,
    async open({ url, names, handler, concurrency = 4, stall = false, pollIntervalMs = 500, role }) {
        /** @type {string[]} */
        const notes = [];

        if (Object.values(names).some(spec => spec.exclusive)) {
            throw new UnsupportedError('no exclusion of jobs by resource (concurrency limits by argument are River Pro, Go only)');
        }

        // No idle timeout: a closed connection takes its CPU counters with it (see docs/cpu-cost.md, pitfall 5)
        const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 0 });

        pool.on('error', () => {});

        const driver = new PgDriver(pool);

        await createMigrator(driver).migrateUp();

        const workers = new Workers();
        const definitions = new Map();

        for (const [name, spec] of Object.entries(names)) {
            const definition = defineJob()({ kind: name });

            definitions.set(name, definition);
            workers.add(definition, ({ job, signal }) => handler(name, job.args, signal), {
                ...spec.timeoutMs && { timeout: { milliseconds: spec.timeoutMs } },
                ...spec.backoffMs !== undefined && {
                    retryPolicy: (_job, now) => now.add({ milliseconds: spec.backoffMs }),
                },
            });
        }

        if (stall) {
            notes.push('job timeout 2 s, `rescueAfter: 3 s`, rescuer every 1 s (default: rescue after 1 hour)');
        }

        const workerOptions = {
            queues: {
                default: {
                    maxWorkers: concurrency,
                    pollInterval: { milliseconds: pollIntervalMs },
                },
            },
            workers,
        };
        // A producer: an insert-only client, without queues and workers
        const client = new Client(driver, {
            ...role !== 'producer' && workerOptions,
            logger: false,
            // Throughput: the shortest time between two claims that River allows, which also spaces the insert
            // notifications of a producer (default: 100 ms, so a worker claims at most its maxWorkers per 100 ms)
            fetchCooldown: { milliseconds: 1 },
            ...stall && { jobTimeout: { seconds: 2 } },
            maintenance: {
                // The checks: scheduled jobs and retries become available within 0.5 s (default: 1 s)
                ...role === undefined && { schedulerInterval: { milliseconds: 500 } },
                ...stall && { rescueAfter: { seconds: 3 }, rescuerInterval: { seconds: 1 } },
            },
        });
        /** @type {{ stop: (options?: object) => Promise<void> } | null} */
        let run = null;

        return {
            notes,
            enqueue: async (name, payload, { delayMs, priority, client: tx } = {}) => {
                await client.insert(definitions.get(name), payload, {
                    maxAttempts: names[name].maxAttempts ?? 1,
                    ...delayMs && { delay: { milliseconds: delayMs } },
                    // 1 is the highest
                    ...priority && { priority: priority === 'high' ? 1 : 4 },
                    ...tx && { tx },
                });
            },
            start: async () => {
                run = await client.start();
            },
            stop: async () => {
                await run?.stop({ mode: 'cancel', timeout: { seconds: 1 } });
                await pool.end();
            },
        };
    },
};
