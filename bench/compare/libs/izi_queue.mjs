// Izi Queue: one queue, a worker per job name, on PostgreSQL (a pg pool) or MySQL (a mysql2 pool); MariaDB is not
// supported (no SKIP LOCKED, says its README). Its insert takes the caller's pg client or mysql2 connection (`tx`).
//
// Settings: `pollInterval: 100 ms` (default 1 s), a public option of its config: a queue fetches up to its free slots
// once per poll, so with the default it starts at most `concurrency` jobs a second when they queue up; as River's
// `fetchCooldown`. On PostgreSQL an insert also NOTIFYs the workers, but only from a started IziQueue: the producer
// starts one without queues, as an app that inserts would.
import { readFileSync } from 'node:fs';
import { createMySQLAdapter, createPostgresAdapter, defineWorker, IziQueue, LifelinePlugin, WorkerResults } from 'izi-queue';
import { createPool } from 'mysql2/promise';
import { Pool } from 'pg';
import { UnsupportedError } from './common.mjs';

/** Its logs go nowhere: the checks report the outcome */
const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const { version } = JSON.parse(readFileSync(new URL('../node_modules/izi-queue/package.json', import.meta.url), 'utf8'));

/** @type {Record<string, number>} Lower runs first */
const PRIORITIES = { high: 0, low: 10 };

/** @type {import('./common.mjs').Adapter} */
export const adapter = {
    version,
    transactional: true,
    databases: ['postgres', 'mysql'],
    async open({ url, names, handler, concurrency = 4, stall = false, role }) {
        /** @type {string[]} */
        const notes = [];

        if (Object.values(names).some(spec => spec.exclusive)) {
            throw new UnsupportedError('no exclusion of jobs by resource');
        }

        const mysql = url.startsWith('mysql:');
        // No idle timeout: a closed connection takes its CPU counters with it (see docs/cpu-cost.md, pitfall 5)
        const mysqlPool = mysql ? createPool({ uri: url, connectionLimit: 5 }) : null;
        const pgPool = mysql ? null : new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 0 });

        pgPool?.on('error', () => {});

        const queue = new IziQueue({
            database: mysqlPool
                ? createMySQLAdapter(mysqlPool, SILENT)
                : createPostgresAdapter(/** @type {Pool} */ (pgPool), SILENT),
            logger: SILENT,
            // A producer runs no jobs: no queue
            queues: role === 'producer' ? {} : { default: concurrency },
            pollInterval: 100,
            // A dead node is presumed after 4 missed heartbeats, 60 s at least
            ...stall && { heartbeatInterval: 1000, plugins: [new LifelinePlugin({ interval: 1000, rescueAfter: 10 })] },
        });

        if (stall) {
            notes.push('`heartbeatInterval: 1 s`, Lifeline every 1 s, `rescueAfter: 10 s` (its minimum; a node is dead after 60 s at least)');
        }

        for (const [name, spec] of Object.entries(names)) {
            const { backoffMs } = spec;

            queue.register(defineWorker(name, async (job, context) => {
                await handler(name, job.args, context?.signal);

                return WorkerResults.ok();
            }, {
                maxAttempts: spec.maxAttempts ?? 1,
                // Seconds
                ...backoffMs !== undefined && { backoff: () => backoffMs / 1000 },
                ...spec.timeoutMs && { timeout: spec.timeoutMs },
            }));
        }

        if (role === undefined || role === 'setup') {
            await queue.migrate();
        }

        let started = false;

        // A producer: started, so its inserts NOTIFY the workers
        if (role === 'producer') {
            await queue.start();
            started = true;
        }

        return {
            notes,
            enqueue: async (name, payload, { delayMs, priority, client } = {}) => {
                await queue.insert(name, {
                    args: payload,
                    maxAttempts: names[name].maxAttempts ?? 1,
                    ...delayMs && { scheduledAt: new Date(Date.now() + delayMs) },
                    ...priority && { priority: PRIORITIES[priority] },
                    ...client && { tx: client },
                });
            },
            start: async () => {
                await queue.start();
                started = true;
            },
            stop: async () => {
                // Stops, and closes the adapter's connections: its listening client too, which pool.end() waits for
                if (started) {
                    await queue.shutdown();
                } else {
                    await pgPool?.end();
                    await mysqlPool?.end();
                }
            },
        };
    },
};
