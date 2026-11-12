// Graphile Worker: one runner, a task per job name; jobs added with graphile_worker.add_job(), in SQL.
import { readFileSync } from 'node:fs';
import { Logger, parseCronItems, run, runMigrations } from 'graphile-worker';
import { Pool } from 'pg';
import { queryRows, scheduleKeys, UnsupportedError } from './common.mjs';

/** @type {Record<string, number>} Lower runs first */
const PRIORITIES = { high: -10, low: 10 };
const { version } = JSON.parse(readFileSync(new URL('../node_modules/graphile-worker/package.json', import.meta.url), 'utf8'));

/** @type {import('./common.mjs').Adapter} */
export const adapter = {
    version,
    transactional: true,
    databases: ['postgres'],
    // A completed job is deleted: the jobs left are those that did not run
    scheduledJobs: async url => ({
        deletesCompleted: true,
        jobs: (await queryRows(url, `
            SELECT payload->>'s' AS key, payload->'_cron'->>'ts' AS slot FROM graphile_worker._private_jobs
            WHERE payload->>'s' IS NOT NULL
        `)).map(row => [row.key, row.slot && new Date(row.slot).toISOString()]),
    }),
    async open({ url, names, handler, concurrency = 4, stall = false, pollIntervalMs = 500, schedules }) {
        /** @type {string[]} */
        const notes = [];
        /** @type {string[]} */
        const limits = [];
        // No idle timeout: a closed connection takes its CPU counters with it (see docs/cpu-cost.md, pitfall 5)
        const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 0 });

        pool.on('error', () => {});

        await runMigrations({ pgPool: pool, logger: silentLogger() });

        for (const spec of Object.values(names)) {
            if (spec.timeoutMs && !stall) {
                throw new UnsupportedError('no job timeout');
            }

            if (spec.backoffMs !== undefined && !limits.length) {
                limits.push('the backoff is not configurable: e^attempts seconds');
            }
        }

        if (stall) {
            notes.push('a job locked by a dead worker is unlocked after 4 hours, not configurable');
        }

        if (Object.values(names).some(spec => spec.exclusive)) {
            notes.push('`queue_name`: one named queue per resource, its jobs run one at a time across task identifiers');
        }

        /** @type {import('graphile-worker').Runner | null} */
        let runner = null;

        return {
            notes,
            limits,
            enqueue: async (name, payload, { delayMs, priority, client } = {}) => {
                const { resources } = /** @type {{ resources?: string[] }} */ (payload);

                if (resources && resources.length > 1 && !limits.length) {
                    limits.push('a job has one `queue_name`: the first of its resources');
                }

                await (client ?? pool).query(`
                    SELECT graphile_worker.add_job(
                        $1, $2::json,
                        queue_name => $3,
                        run_at => now() + $4 * interval '1 millisecond',
                        max_attempts => $5,
                        priority => $6
                    )
                `, [
                    name,
                    JSON.stringify(payload),
                    resources?.[0] ?? null,
                    delayMs ?? 0,
                    names[name].maxAttempts ?? 1,
                    PRIORITIES[priority ?? ''] ?? 0,
                ]);
            },
            start: async () => {
                // Schedules in code: a crontab item per schedule, its key as the identifier, no backfill (the default)
                const [cronTask] = Object.keys(names);
                const parsedCronItems = schedules && parseCronItems(scheduleKeys(schedules.count).map(key => ({
                    task: cronTask,
                    match: schedules.cron,
                    identifier: key,
                    payload: { s: key },
                })));

                runner = await run({
                    pgPool: pool,
                    concurrency,
                    pollInterval: pollIntervalMs,
                    noHandleSignals: true,
                    logger: silentLogger(),
                    ...parsedCronItems && { parsedCronItems },
                    taskList: Object.fromEntries(Object.keys(names).map(name => [
                        name,
                        // A crontab job carries its slot in `_cron.ts`
                        (payload, helpers) => handler(name, payload, helpers.abortSignal, cronSlot(payload)),
                    ])),
                });
            },
            stop: async () => {
                await runner?.stop();
                await pool.end();
            },
        };
    },
};

/**
 * @param {unknown} payload
 * @returns {number | undefined}
 */
function cronSlot(payload) {
    const ts = /** @type {Record<string, { ts: string } | undefined>} */ (payload)?.['_cron']?.ts;

    return ts ? Date.parse(ts) : undefined;
}

/** @returns {Logger} A logger that drops everything: the checks report the outcome. */
function silentLogger() {
    return new Logger(() => () => {});
}
