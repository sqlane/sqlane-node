// Sidequest: its engine in this process, the inline runner, the PostgreSQL backend.
import { readFileSync } from 'node:fs';
import { Sidequest } from 'sidequest';
import { UnsupportedError } from './common.mjs';
import * as jobs from './sidequest_jobs.mjs';

/** @type {Map<string, any>} The job classes, by job name */
const JOB_CLASSES = new Map(Object.entries(jobs));

const { version } = JSON.parse(readFileSync(new URL('../node_modules/sidequest/package.json', import.meta.url), 'utf8'));

/** @type {import('./common.mjs').Adapter} */
export const adapter = {
    version,
    // No API takes the caller's transaction: the performance runs enqueue after the COMMIT
    transactional: false,
    async open({ url, names, handler, concurrency = 4, stall = false }) {
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

        /** @type {import('sidequest').SidequestConfig<'@sidequest/postgres-backend'>} */
        const config = {
            backend: { driver: '@sidequest/postgres-backend', config: url },
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
