// Boring Node Queue (@boringnode/queue): its Knex adapter on PostgreSQL, MySQL or MariaDB, one queue, a job class per
// job name (Locator.register), one worker. Its enqueue takes a Knex transaction (`.with(knex(trx))`), so the
// business transaction is a Knex one: `transaction` below.
//
// Settings: its defaults: a poll every 2 s when idle (`idleDelay`), its only wake in 0.9.1 (0.10.0 adds LISTEN/NOTIFY
// on PostgreSQL, but is younger than the 7 days of the guardrails); `concurrency` of the run (default 1). Completed
// jobs are removed (`removeOnComplete`, default).
import { readFileSync } from 'node:fs';
import { fixedBackoff, Job, Locator, QueueManager, Worker } from '@boringnode/queue';
import { knex as knexAdapter, KnexQueueSchemaService } from '@boringnode/queue/drivers/knex_adapter';
import knex from 'knex';
import { UnsupportedError } from './common.mjs';

const { version } = JSON.parse(readFileSync(
    new URL('../node_modules/@boringnode/queue/package.json', import.meta.url),
    'utf8',
));

/** @type {Record<string, number>} Lower runs first (default 5) */
const PRIORITIES = { high: 1, low: 9 };

/** @type {import('./common.mjs').Adapter} */
export const adapter = {
    version,
    transactional: true,
    databases: ['postgres', 'mysql', 'mariadb'],
    async open({ url, names, handler, concurrency = 4, stall = false, role }) {
        /** @type {string[]} */
        const notes = [];

        if (Object.values(names).some(spec => spec.exclusive)) {
            throw new UnsupportedError('no exclusion of jobs by resource (job groups are for monitoring)');
        }

        const mysql = url.startsWith('mysql:');
        // No idle timeout: a closed connection takes its CPU counters with it (see docs/cpu-cost.md, pitfall 5)
        const db = knex({
            client: mysql ? 'mysql2' : 'pg',
            connection: url,
            pool: { min: 0, max: 5, idleTimeoutMillis: 2_147_483_647 },
        });

        // The setup; and the checks, where a second process can open the same database
        if ((role === undefined || role === 'setup') && !await db.schema.hasTable('queue_jobs')) {
            const schema = new KnexQueueSchemaService(db);

            await schema.createJobsTable();
            await schema.createSchedulesTable();
        }

        /** @type {Map<string, any>} */
        const classes = new Map();

        for (const [name, spec] of Object.entries(names)) {
            const JobClass = class extends Job {
                static options = {
                    name,
                    maxRetries: (spec.maxAttempts ?? 1) - 1,
                    ...spec.backoffMs !== undefined && { retry: { backoff: fixedBackoff(spec.backoffMs) } },
                    ...spec.timeoutMs && { timeout: spec.timeoutMs },
                };

                async execute() {
                    await handler(name, this.payload, this.signal);
                }
            };

            classes.set(name, JobClass);
            Locator.register(name, JobClass);
        }

        /** @type {import('@boringnode/queue/types').QueueManagerConfig} */
        const config = {
            default: 'knex',
            adapters: { knex: knexAdapter(db) },
            worker: {
                concurrency,
                gracefulShutdown: false,
                ...stall && { stalledThreshold: '2s', stalledInterval: '1s' },
            },
        };

        if (stall) {
            notes.push('`stalledThreshold: 2 s`, `stalledInterval: 1 s` (default: 30 s each)');
        }

        await QueueManager.init(config);

        /** @type {Worker | null} */
        let worker = null;

        return {
            notes,
            enqueue: async (name, payload, { delayMs, priority, client } = {}) => {
                let dispatch = classes.get(name).dispatch(payload);

                if (delayMs) {
                    dispatch = dispatch.in(delayMs);
                }

                if (priority) {
                    dispatch = dispatch.priority(PRIORITIES[priority]);
                }

                // A Knex transaction: the job commits or rolls back with it
                if (client) {
                    dispatch = dispatch.with(knexAdapter(client));
                }

                await dispatch.run();
            },
            transaction: async (work) => {
                await db.transaction(trx => work(trx, (sql, values) => trx.raw(sql, values)));
            },
            start: async () => {
                // init() in this process already: the worker reuses it
                await QueueManager.destroy();
                worker = new Worker(config);
                // It initializes QueueManager for the dispatches of this process too
                await worker.init();
                // Resolves when the worker stops
                void worker.start(['default']);
            },
            stop: async () => {
                await worker?.stop();
                await QueueManager.destroy();
                await db.destroy();
            },
        };
    },
};
