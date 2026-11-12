/* oxlint-disable no-await-in-loop -- the schedules are registered one after the other */
// Sidequest: its engine in this process, the inline runner, its PostgreSQL or MySQL backend. A job class per job name
// (sidequest_jobs.mjs).
//
// Settings: its defaults: a poll every 100 ms (`jobPollingInterval`), its only wake; `maxConcurrentJobs` of the run.
//
// Schedules: `schedule()`, node-cron in the process that registers them, not stored: each such process enqueues each
// slot. Worker 0 registers them, the documentation's "restrict scheduling to a single node" (no failover); all the
// workers run the jobs. Its other option, `unique({ period: 'minute' })`, fails with `schedule()`: the job and its
// unique key are computed once, at registration, so every later run collides with the first job's row.
import { readFileSync } from 'node:fs';
import { Sidequest } from 'sidequest';
import { queryRows, scheduleKeys, UnsupportedError } from './common.mjs';
import * as jobs from './sidequest_jobs.mjs';

/** @type {Map<string, any>} The job classes, by job name */
const JOB_CLASSES = new Map(Object.entries(jobs));

const { version } = JSON.parse(readFileSync(new URL('../node_modules/sidequest/package.json', import.meta.url), 'utf8'));

/** @type {import('./common.mjs').Adapter} */
export const adapter = {
    version,
    // No API takes the caller's transaction: the performance runs enqueue after the COMMIT
    transactional: false,
    databases: ['postgres', 'mysql'],
    // A slot of a schedule: the minute of the job's insert
    scheduledJobs: async url => ({
        jobs: (await queryRows(url, 'SELECT args, inserted_at FROM sidequest_jobs WHERE class = \'job_0000\''))
            .map((row) => {
                const [payload] = typeof row.args === 'string' ? JSON.parse(row.args) : row.args;
                const slot = Math.floor(new Date(row.inserted_at).getTime() / 60_000) * 60_000;

                return [payload.s, new Date(slot).toISOString()];
            }),
    }),
    async open({ url, names, handler, concurrency = 4, stall = false, role, schedules }) {
        /** @type {string[]} */
        const notes = ['engine in this process, `runner: "inline"`'];
        /** @type {string[]} */
        const limits = [];

        if (Object.values(names).some(spec => spec.exclusive)) {
            throw new UnsupportedError('no exclusion of jobs by resource');
        }

        if (stall) {
            notes.push('`releaseStaleJobsIntervalMin: 1` (its minimum: a cron of minutes), `releaseStaleJobsMaxStaleMs: 2000` (default: every 60 min, stale after 10 min)');
        }

        jobs.setHandler(handler);

        const driver = url.startsWith('mysql:') ? '@sidequest/mysql-backend' : '@sidequest/postgres-backend';
        /** @type {import('sidequest').SidequestConfig<any>} */
        const config = {
            backend: { driver, config: url },
            queues: [
                { name: 'default', concurrency },
                // Sidequest has priorities of queues, not of jobs
                { name: 'high', concurrency, priority: 10 },
                { name: 'low', concurrency, priority: 0 },
            ],
            maxConcurrentJobs: concurrency,
            fork: false,
            runner: 'inline',
            jobPollingInterval: 100,
            gracefulShutdown: false,
            logger: { level: 'error' },
            dashboard: { enabled: false },
            ...stall && { releaseStaleJobsIntervalMin: 1, releaseStaleJobsMaxStaleMs: 2000 },
        };
        let started = false;

        // Configures and migrates; start() begins the processing
        await Sidequest.configure(config);

        // Schedules in worker 0, in memory
        if (schedules && role === 'worker' && !schedules.index) {
            const [name] = Object.keys(names);

            for (const key of scheduleKeys(schedules.count)) {
                await Sidequest.build(JOB_CLASSES.get(name)).queue('default').schedule(schedules.cron, { s: key });
            }
        }

        return {
            notes,
            limits,
            enqueue: async (name, payload, { delayMs, priority, client } = {}) => {
                const spec = names[name];

                if (client && !notes.includes('enqueue on its own connection: no API takes the caller\'s')) {
                    notes.push('enqueue on its own connection: no API takes the caller\'s');
                }

                if (priority && !limits.length) {
                    limits.push('a queue per priority: Sidequest has priorities of queues, not of jobs');
                }

                let builder = Sidequest.build(JOB_CLASSES.get(name))
                    .queue(priority ?? 'default')
                    .maxAttempts(spec.maxAttempts ?? 1);

                if (spec.timeoutMs) {
                    builder = builder.timeout(spec.timeoutMs);
                }

                if (spec.backoffMs !== undefined) {
                    builder = builder.retryDelay(spec.backoffMs).backoffStrategy('fixed');
                }

                if (delayMs) {
                    builder = builder.availableAt(new Date(Date.now() + delayMs));
                }

                await builder.enqueue(payload);
            },
            start: async () => {
                await Sidequest.start(config);
                started = true;
            },
            stop: async () => {
                if (started) {
                    await Sidequest.stop();
                }
            },
        };
    },
};
