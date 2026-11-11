// sqlane, from this checkout: the pg adapter, LISTEN/NOTIFY wakes.
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { pgAdapter } from '../../../src/adapters/pg.js';
import { createSqlane, defineJob } from '../../../src/index.js';
import { UnsupportedError } from './common.mjs';

const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

/** @type {import('./common.mjs').Adapter} */
export const adapter = {
    version,
    async open({ url, names, handler, concurrency = 4, stall = false }) {
        const pool = new Pool({ connectionString: url, max: 5 });
        /** @type {string[]} */
        const notes = [];
        const sqlane = createSqlane({
            adapter: pgAdapter(pool, { notify: true }),
            concurrency,
            pollInterval: '1s',
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
            sqlane.handle(definition, ({ job, payload, signal }) => handler(job.name, payload, signal));
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
