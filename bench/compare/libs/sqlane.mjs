// sqlane, from this checkout: the pg adapter, LISTEN/NOTIFY wakes.
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { createPool } from 'mysql2/promise';
import { Pool } from 'pg';
import { mysql2Adapter } from '../../../src/adapters/mysql2.js';
import { pgAdapter } from '../../../src/adapters/pg.js';
import { createSqlane, defineJob } from '../../../src/index.js';
import { queryRows, scheduleKeys, UnsupportedError } from './common.mjs';

/**
 * Hints over UDP on localhost: they stand in for the Redis pub/sub that sqlane recommends on MySQL and MariaDB, which
 * have no NOTIFY (as bench/cpu/app.js). One port per database server, 10000 below its own: the lanes run in parallel.
 * @param {number} port
 * @returns {import('../../../src/types.js').Hint}
 */
function udpHint(port) {
    return {
        publish: async (channel, message) => {
            const socket = createSocket('udp4');

            await new Promise((resolve) => {
                socket.send(`${channel}\n${message}`, port, '127.0.0.1', () => resolve(undefined));
            });
            socket.close();
        },
        subscribe: async (channel, onMessage) => {
            const socket = createSocket('udp4');

            socket.on('message', (buffer) => {
                const [messageChannel, message] = buffer.toString().split('\n');

                if (messageChannel === channel) {
                    onMessage(message);
                }
            });
            await new Promise((resolve) => {
                socket.bind(port, '127.0.0.1', () => resolve(undefined));
            });

            return async () => {
                socket.close();
            };
        },
    };
}

const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

/** @type {import('./common.mjs').Adapter} */
export const adapter = {
    version,
    transactional: true,
    databases: ['postgres', 'mysql', 'mariadb'],
    // The id of a slot's job: `<name>:schedule:<key>:<ISO>`
    scheduledJobs: async url => ({
        jobs: (await queryRows(url, 'SELECT id FROM sqlane_jobs WHERE id LIKE \'%:schedule:%\''))
            .map(row => /** @type {RegExpExecArray} */ (/^[^:]*:schedule:([^:]*):(.*)$/u.exec(row.id)))
            .map(([, key, slot]) => [key, slot]),
    }),
    async open({
        url, names, handler, concurrency = 4, stall = false, pollIntervalMs = 500, dialect = 'mysql', role, schedules,
    }) {
        const mysql = url.startsWith('mysql:');
        // MySQL and MariaDB: the pool of mysql2 (from the root package). No idle timeout: a closed connection takes its
        // CPU counters with it (see docs/cpu-cost.md, pitfall 5)
        const pool = mysql
            ? createPool({ uri: url, connectionLimit: 5 })
            : new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 0 });
        /** @type {string[]} */
        const notes = [];
        const sqlane = createSqlane({
            // One adapter type for both: the connections are the caller's (any)
            adapter: /** @type {import('../../../src/types.js').Adapter<any>} */ (mysql
                ? mysql2Adapter(/** @type {import('mysql2/promise').Pool} */ (pool), { dialect })
                : pgAdapter(/** @type {Pool} */ (pool), { notify: true })),
            ...mysql && { hint: udpHint(Number(new URL(url).port) - 10_000) },
            concurrency,
            pollInterval: pollIntervalMs,
            // A lease of 4 minutes: no public option shortens it
            ...stall && { timings: { leaseMs: 3000, renewIntervalMs: 1000, recoveryIntervalMs: 1000 } },
        });

        if (stall) {
            notes.push('test-only option: lease 3 s (default and minimum public: 4 min)');
        }

        await sqlane.migrate();

        /** @type {Map<string, import('../../../src/types.js').JobDefinition>} */
        const definitions = new Map();

        for (const [name, spec] of Object.entries(names)) {
            const definition = defineJob({
                name,
                maxAttempts: spec.maxAttempts ?? 1,
                ...spec.backoffMs !== undefined && {
                    backoff: { type: 'fixed', delay: Math.max(spec.backoffMs, 1), jitter: 0 },
                },
                ...spec.exclusive && {
                    mutexKeys: (/** @type {{ resources: string[] }} */ payload) => payload.resources.map(
                        resource => `resource:${resource}`,
                    ),
                },
                ...(spec.timeoutMs || spec.exclusive) && { timeout: spec.timeoutMs ?? '1m' },
            });

            definitions.set(name, definition);
            sqlane.handle(definition, ({ job, payload, signal }) => (
                handler(job.name, payload, signal, job.scheduledAt?.getTime())
            ));
        }

        // Schedules in code, in each worker: no jitter, `missed: 'once'` (the defaults), UTC
        if (schedules && role !== 'setup') {
            const [definition] = definitions.values();

            for (const key of scheduleKeys(schedules.count)) {
                sqlane.schedule(definition, { cron: schedules.cron, key, payload: { s: key } });
            }
        }

        return {
            notes,
            enqueue: async (name, payload, { delayMs, priority, client } = {}) => {
                if (priority) {
                    throw new UnsupportedError('no priority option');
                }

                const definition = definitions.get(name);

                if (!definition) {
                    throw new Error(`no definition ${name}`);
                }

                await sqlane.enqueue(client ?? pool, definition, payload, delayMs ? { delay: delayMs } : {});
            },
            start: () => sqlane.start(),
            stop: async () => {
                await sqlane.close({ deadline: 0 });
                await pool.end();
            },
        };
    },
};
