// pg-boss: a queue per job name, with the queue's retry and expiry options.
/* oxlint-disable no-await-in-loop -- queues and workers are created one after the other */
import { readFileSync } from 'node:fs';
import { PgBoss } from 'pg-boss';

const { version } = JSON.parse(readFileSync(new URL('../node_modules/pg-boss/package.json', import.meta.url), 'utf8'));
/** All the job names of an exclusion check share it: pg-boss groups jobs within a queue */
const SHARED_QUEUE = 'shared';

/** @type {import('./common.mjs').Adapter} */
export const adapter = {
    version,
    async open({ url, names, handler, concurrency = 4, stall = false }) {
        /** @type {string[]} */
        const notes = [];
        /** @type {string[]} */
        const limits = [];
        const boss = new PgBoss({
            connectionString: url,
            max: 5,
            ...stall && { monitorIntervalSeconds: 1, superviseIntervalSeconds: 1, maintenanceIntervalSeconds: 1 },
        });

        boss.on('error', () => {});
        await boss.start();

        const exclusive = Object.values(names).some(spec => spec.exclusive);
        /**
         * @param {string} name
         * @returns {string}
         */
        const queueOf = name => (exclusive ? SHARED_QUEUE : name);

        if (exclusive) {
            limits.push('both job names in one queue, the handler dispatches by name; `groupConcurrency: 1`');
            await boss.createQueue(SHARED_QUEUE);
        }

        for (const [name, spec] of Object.entries(names)) {
            if (exclusive) {
                continue;
            }

            const expireInSeconds = spec.timeoutMs ? Math.max(1, Math.round(spec.timeoutMs / 1000)) : undefined;

            await boss.createQueue(name, {
                retryLimit: (spec.maxAttempts ?? 1) - 1,
                ...spec.backoffMs !== undefined && { retryDelay: spec.backoffMs / 1000 },
                ...expireInSeconds && { expireInSeconds },
            });

            if (stall) {
                notes.push(`expireInSeconds: ${expireInSeconds}, monitor and maintenance every 1 s`);
            }
        }

        /** @type {string[]} */
        const workers = [];

        return {
            notes,
            limits,
            enqueue: async (name, payload, { delayMs, priority, client } = {}) => {
                const groupId = payload.resources?.[0];

                if (payload.resources?.length > 1 && !limits.some(limit => limit.startsWith('a job has one group'))) {
                    limits.push('a job has one group: the first of its resources');
                }

                await boss.send(queueOf(name), { ...payload, name }, {
                    ...delayMs && { startAfter: delayMs / 1000 },
                    ...priority && { priority: priority === 'high' ? 10 : 0 },
                    ...groupId && { group: { id: groupId } },
                    // The caller's transaction: pg-boss runs its INSERT through this
                    ...client && { db: { executeSql: (text, values) => client.query(text, values) } },
                });
            },
            start: async () => {
                for (const queue of exclusive ? [SHARED_QUEUE] : Object.keys(names)) {
                    workers.push(await boss.work(queue, {
                        localConcurrency: concurrency,
                        pollingIntervalSeconds: 0.5,
                        ...exclusive && { groupConcurrency: 1 },
                    }, async ([job]) => {
                        await handler(job.data.name, job.data, job.signal);
                    }));
                }
            },
            stop: () => boss.stop({ graceful: false, close: true, timeout: 1000 }),
        };
    },
};
