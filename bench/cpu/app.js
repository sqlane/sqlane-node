// One process of the CPU cost benchmark (see docs/cpu-cost.md): `--role setup`, `worker` or `producer`. It loads sqlane
// from `--src`, a source tree: the working tree, or the baseline that measure.sh extracts from a git ref. The worker
// and the producer write their numbers of the measured window to `<out>/<role>.json`.
import { createSocket } from 'node:dgram';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
    options: {
        'role': { type: 'string' },
        'src': { type: 'string' },
        'dialect': { type: 'string', default: 'postgres' },
        'url': { type: 'string' },
        'names': { type: 'string', default: '1000' },
        'history': { type: 'string', default: '1000' },
        'completed': { type: 'string', default: '0' },
        'mutex-keys': { type: 'string', default: '0' },
        'blocked': { type: 'string', default: '0' },
        'queued': { type: 'string', default: '0' },
        'rate': { type: 'string', default: '20' },
        'warmup': { type: 'string', default: '5' },
        'measure': { type: 'string', default: '20' },
        'out': { type: 'string', default: '.' },
        'hint-port': { type: 'string', default: '41234' },
    },
});
const src = String(args.src);
const dialect = String(args.dialect);
const warmupMs = Number(args.warmup) * 1000;
const measureMs = Number(args.measure) * 1000;
const rate = Number(args.rate);
const hintPort = Number(args['hint-port']);
// The drivers of this checkout, sqlane of the source tree
const require = createRequire(join(src, 'package.json'));
const { createSqlane, defineJob } = await import(join(src, 'src/index.js'));
const LINGER_MS = 3000;
const names = Array.from({ length: Number(args.names) }, (_, index) => `job_${String(index).padStart(4, '0')}`);

/**
 * The pool and the adapter. MySQL and MariaDB have no NOTIFY: a hint over UDP on localhost stands in for Redis.
 * @returns {Promise<{ pool: any, adapter: any, hint: import('../../src/types.js').Hint | null }>}
 */
async function connect() {
    if (dialect === 'postgres') {
        const { Pool } = require('pg');
        const { pgAdapter } = await import(join(src, 'src/adapters/pg.js'));
        // No idle timeout: the database processes of the pool live through the window
        const pool = new Pool({ connectionString: args.url, max: 8, idleTimeoutMillis: 0 });

        return { pool, adapter: pgAdapter(pool, { notify: true }), hint: null };
    }

    const mysql = require('mysql2/promise');
    const { mysql2Adapter } = await import(join(src, 'src/adapters/mysql2.js'));
    const pool = mysql.createPool({ uri: args.url, connectionLimit: 8 });

    return {
        pool,
        adapter: mysql2Adapter(pool, { dialect }),
        hint: {
            publish: async (channel, message) => {
                const socket = createSocket('udp4');

                await new Promise((resolve) => {
                    socket.send(`${channel}\n${message}`, hintPort, '127.0.0.1', () => resolve(undefined));
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
                    socket.bind(hintPort, '127.0.0.1', () => resolve(undefined));
                });

                return async () => {
                    socket.close();
                };
            },
        },
    };
}

const { pool, adapter, hint } = await connect();
const mutexKeyCount = Number(args['mutex-keys']);
// With --mutex-keys: one mutex key per job, `account:<index mod mutex-keys>`, and handlers that hold it for 20 ms
const definitions = names.map(name => defineJob({
    name,
    maxAttempts: 1,
    retention: { completed: '7d', failed: '7d' },
    ...mutexKeyCount > 0 && {
        mutexKeys: (/** @type {{ index: number }} */ payload) => [`account:${payload.index % mutexKeyCount}`],
        timeout: '1m',
    },
}));
/** The mutex keys that a handler holds now, and the breaches of the mutual exclusion */
const heldKeys = new Set();
const checks = { overlaps: 0, wrongKeys: 0 };
let completed = 0;
/**
 * The instance, with its cap as the version of `--src` names it: `maxConcurrency` from 5.0, `concurrency` before.
 * @param {Record<string, unknown>} rest
 * @returns {any}
 */
function createInstance(rest) {
    try {
        return createSqlane({ ...rest, maxConcurrency: 8 });
    } catch {
        return createSqlane({ ...rest, concurrency: 8 });
    }
}

const sqlane = createInstance({
    adapter,
    hint,
    jobs: definitions,
    pollInterval: 5000,
    onEvent: (/** @type {import('../../src/types.js').SqlaneEvent} */ event) => {
        if (event.type === 'completed') {
            completed++;
        } else if (event.type === 'error' || event.type === 'failed') {
            console.error(event);
        }
    },
});

/**
 * Most jobs go to the 10 hot names, every 10th to one of the others.
 * @param {number} index
 * @returns {string}
 */
function nameOf(index) {
    const hot = Math.min(10, names.length);

    return index % 10 === 9 && names.length > hot
        ? names[hot + (Math.floor(index / 10) % (names.length - hot))]
        : names[(index - Math.floor(index / 10)) % hot];
}

/**
 * Writes the jobs completed in the measured window, which starts `--warmup` after the start. Then lingers: measure.sh
 * reads the counters of this process, and of its database connections, at the end of the window.
 * @param {string} role
 * @returns {Promise<void>}
 */
async function recordWindow(role) {
    await sleep(warmupMs);

    const before = completed;

    await sleep(measureMs);
    writeFileSync(join(String(args.out), `${role}.json`), JSON.stringify({ completed: completed - before, ...checks }));
    await sleep(LINGER_MS);
}

/**
 * Completed jobs, spread evenly over the names, as the worker leaves them (no lock, no payload). PostgreSQL: one
 * INSERT of all, in time order. MySQL and MariaDB: enqueued by sqlane, then completed by SQL.
 * @param {number} count
 * @returns {Promise<void>}
 */
async function addCompletedJobs(count) {
    if (!count) {
        return;
    }

    if (dialect === 'postgres') {
        await pool.query(`
            INSERT INTO sqlane_jobs (id, job_name, status, enqueue_token, run_at, max_attempts, max_stalls, completed_retention_ms,
                failed_retention_ms, created_at, started_at, finished_at, expires_at, updated_at)
            SELECT '01J' || lpad(i::text, 23, '0'), 'job_' || lpad(n::text, 4, '0'), 'completed',
                   '01J' || lpad(i::text, 23, '0'), t, 1, 2, 604800000, 604800000, t, t, t, t + interval '7 days', t
              FROM (
                  SELECT i, i % ${names.length} AS n, now() - (${count} - i) * interval '1 millisecond' AS t
                    FROM generate_series(1, ${count}) AS i
              ) AS row`);

        return;
    }

    for (let index = 0; index < count; index += 1000) {
        const items = Array.from({ length: Math.min(1000, count - index) }, (_, offset) => ({
            payload: { index: index + offset },
            options: { delay: '200d' },
        }));

        // oxlint-disable-next-line no-await-in-loop -- a fixture, one batch after the other
        await sqlane.enqueueMany(pool, names[(index / 1000) % names.length], items);
    }

    await pool.query(`UPDATE sqlane_jobs SET status = 'completed', started_at = UTC_TIMESTAMP(3),
        finished_at = UTC_TIMESTAMP(3), expires_at = UTC_TIMESTAMP(3) + INTERVAL 7 DAY
        WHERE status = 'pending' AND run_at < UTC_TIMESTAMP(3) + INTERVAL 300 DAY`);
    await pool.query(`DELETE pl FROM sqlane_payloads pl JOIN sqlane_jobs j ON j.id = pl.id
        WHERE j.status = 'completed'`);
}

/**
 * Due jobs of one key, spread evenly over the names. `blocked`: the key is held for a day, a backlog that each claim
 * of a name with mutex keys reads past. `queue`: the key is free, its jobs run one after the other.
 * @param {number} count
 * @param {'blocked' | 'queue'} key
 * @returns {Promise<void>}
 */
async function addKeyBacklog(count, key) {
    if (!count) {
        return;
    }

    if (key === 'blocked') {
        const heldUntil = dialect === 'postgres' ? `now() + interval '1 day'` : 'UTC_TIMESTAMP(3) + INTERVAL 1 DAY';
        const now = dialect === 'postgres' ? 'now()' : 'UTC_TIMESTAMP(3)';

        await pool.query(`INSERT INTO sqlane_mutexes (mutex_key, job_id, lock_token, held_until, created_at)
            VALUES ('blocked', 'holder', 'holder', ${heldUntil}, ${now})`);
    }

    for (const [nameIndex, name] of names.entries()) {
        const length = Math.floor(count / names.length) + Number(nameIndex < count % names.length);
        const items = Array.from({ length }, (_, offset) => ({
            payload: { index: offset, key },
            options: { mutexKeys: [key], delay: 0 },
        }));

        if (items.length) {
            // oxlint-disable-next-line no-await-in-loop -- a fixture, one batch after the other
            await sqlane.enqueueMany(pool, name, items);
        }
    }
}

if (args.role === 'setup') {
    await pool.query('DROP TABLE IF EXISTS sqlane_jobs, sqlane_payloads, sqlane_mutexes, sqlane_job_keys, sqlane_migrations');
    await sqlane.migrate();
    await addCompletedJobs(Number(args.completed));

    // Pending jobs a year ahead, one name after the other: each name has pending jobs, as in a busy app

    for (let index = 0; index < Number(args.history); index++) {
        // oxlint-disable-next-line no-await-in-loop -- a fixture, one job after the other
        await sqlane.enqueue(pool, names[index % names.length], { index }, { jobId: `future-${index}`, delay: '365d' });
    }

    await addKeyBacklog(Number(args.blocked), 'blocked');
    await addKeyBacklog(Number(args.queued), 'queue');

    if (dialect === 'postgres') {
        // No autovacuum or checkpoint of the fixture in the measured window
        await pool.query('VACUUM ANALYZE sqlane_jobs, sqlane_payloads');
        await pool.query('CHECKPOINT');

        const { rows } = await pool.query(`SELECT relname, pg_relation_size(oid) AS bytes FROM pg_class
            WHERE relname LIKE 'sqlane\\_%' AND relkind IN ('r', 'i') AND relname NOT LIKE 'sqlane_migrations%'`);

        writeFileSync(join(String(args.out), 'sizes.json'),
            JSON.stringify(Object.fromEntries(rows.map((/** @type {any} */ row) => [row.relname, Number(row.bytes)]))));
    } else {
        await pool.query('ANALYZE TABLE sqlane_jobs, sqlane_payloads');
    }
} else if (args.role === 'worker') {
    for (const definition of definitions) {
        sqlane.handle(definition, mutexKeyCount > 0
            ? async (/** @type {import('../../src/types.js').HandlerContext} */ { job, payload }) => {
                const [key] = job.mutexKeys;

                const { index, key: payloadKey } = /** @type {{ index: number, key?: string }} */ (payload);

                if (key !== (payloadKey ?? `account:${index % mutexKeyCount}`)) {
                    checks.wrongKeys++;
                }

                if (heldKeys.has(key)) {
                    checks.overlaps++;
                }

                heldKeys.add(key);
                await sleep(20);
                heldKeys.delete(key);
            }
            : () => {});
    }

    await sqlane.start();
    await recordWindow('worker');
    await sqlane.close({ deadline: '10s' });
} else if (args.role === 'producer') {
    const startedAt = Date.now();
    const window = recordWindow('producer');

    for (let index = 0; Date.now() - startedAt < warmupMs + measureMs + LINGER_MS; index++) {
        // oxlint-disable-next-line no-await-in-loop -- a fixed schedule: one enqueue after the other
        await sleep(startedAt + ((index * 1000) / rate) - Date.now());
        // oxlint-disable-next-line no-await-in-loop -- the next one waits for its schedule anyway
        await sqlane.enqueue(pool, nameOf(index), { index }, { jobId: `load-${index}` });
    }

    await window;
}

await pool.end();
