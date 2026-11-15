// The comparison of docs/features_vs_other_libs.md and docs/performance_vs_other_libs.md: the feature checks, the
// performance workloads of jobs, and those of schedules, on PostgreSQL (BullMQ also on Redis) of this host: Linux in
// the container of linux.dockerfile (bench/run_linux.sh vs-other-libs: the published numbers, with 0.5 ms each way on
// the loopback), or macOS with Homebrew.
//
//   pnpm bench:vs-other-libs                    # checks and perf
//   pnpm bench:vs-other-libs --only checks      # or: perf (the jobs), cron (the schedules)
//   pnpm bench:vs-other-libs --only cron --libs sqlane,river
//   pnpm bench:vs-other-libs --parallel 4       # at most 4 runs at once: a machine with fewer cores than 8
//
// Options: --pg-bin, --redis-bin (the directories of the server binaries; defaults: the PG_BIN and REDIS_BIN
// variables, else Homebrew's). Writes results.json next to this file and prints Markdown tables. See README.md.
/* oxlint-disable no-await-in-loop -- the runs go one after the other: they share the machine */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, release as kernelRelease, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { Client } from 'pg';
import { countersAsync, countsKernel, difference, startCounters, stopCounters } from '../lib/counters.mjs';
import { postgresTemplate, startPostgres, startRedis } from '../lib/servers.mjs';

const execFileAsync = promisify(execFile);
const HERE = import.meta.dirname;
const LINUX = process.platform === 'linux';
// oxlint-disable-next-line node/no-process-env -- the server binaries (linux.dockerfile)
const { PG_BIN: PG_ENV, REDIS_BIN: REDIS_ENV } = process.env;
const { values: args } = parseArgs({
    options: {
        'only': { type: 'string' },
        'libs': { type: 'string' },
        'pg-bin': { type: 'string', default: PG_ENV ?? '/opt/homebrew/opt/postgresql@17/bin' },
        'redis-bin': { type: 'string', default: REDIS_ENV ?? '/opt/homebrew/bin' },
        'parallel': { type: 'string' },
    },
});
const PG_BIN = args['pg-bin'];
const REDIS_BIN = args['redis-bin'];
/**
 * The most runs at once: the lanes of phase A, and the schedule runs, go in batches of this size, each batch with its
 * windows started together. Unlimited by default (8 cores): on fewer cores, the runs fall behind the load.
 */
const PARALLEL = args.parallel ? Number(args.parallel) : Number.POSITIVE_INFINITY;

if (!(PARALLEL >= 1)) {
    throw new Error(`--parallel ${args.parallel}: a number of 1 or more`);
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]} the items in batches of at most size
 */
function batches(items, size) {
    const out = [];

    for (let first = 0; first < items.length; first += size) {
        out.push(items.slice(first, first + size));
    }

    return out;
}
/**
 * The libraries of the performance runs. Each adapter uses the settings that its library's documentation offers for
 * throughput (libs/common.mjs); a library whose enqueue cannot take the caller's transaction enqueues after the COMMIT.
 */
const PERF_LIBRARIES = [
    'sqlane', 'pg-boss', 'graphile-worker', 'river', 'bullmq', 'sidequest', 'boring-node-queue', 'izi-queue',
];
/**
 * The databases of the performance and schedule runs: of those that an adapter lists, PostgreSQL, and Redis (BullMQ).
 * The feature checks run on PostgreSQL.
 */
const PERF_DATABASES = new Set(['postgres', 'redis']);
const ALL_PARTS = ['checks', 'perf', 'cron'];
/** The schedules are a part of their own, outside the default */
const PARTS = new Set(args.only ? [args.only] : ['checks', 'perf']);

if (!ALL_PARTS.includes(args.only ?? 'checks')) {
    throw new Error(`--only ${args.only}: one of ${ALL_PARTS.join(', ')}`);
}

const LIBRARIES = args.libs ? args.libs.split(',') : PERF_LIBRARIES;
const UNKNOWN = LIBRARIES.filter(library => !PERF_LIBRARIES.includes(library));

if (UNKNOWN.length) {
    throw new Error(`--libs ${UNKNOWN.join(',')}: unknown; one or more of ${PERF_LIBRARIES.join(', ')}`);
}

const WARMUP_S = 5;
const MEASURE_S = 15;
const NAMES = 1000;
const RATE = 20;
const SCHEDULES = 1000;
const FIRE_CRON = '* * * * *';
/** The worker processes of a schedule run */
const CRON_PROCESSES = 3;
/** The schedule runs repeat: a row has the median of each number, and each run in `samples` */
const CRON_REPEATS = 1;
/** The schedule runs start together: the first slot comes at least this long after the last worker is ready */
const CRON_WARMUP_S = 10;
/** The CPU window of the firing schedules: one period, from 30 s after the first slot to 30 s after the second */
const CRON_FIRE_S = 60;
/**
 * After the second slot, the time that the slots' jobs have to start: pg-boss files an occurrence up to 30 s late,
 * then 3 workers forward 1000 in about 33 s
 */
const CRON_LATE_S = 70;
const MINUTE_MS = 60_000;
/** The port of the checks' PostgreSQL */
const CHECKS_PG_PORT = 55_442;
/**
 * The first ports of the servers of the schedule runs, one per lane: PostgreSQL (each run counts the backends of its
 * database), and Redis, whose lane has a PostgreSQL for the business table too
 */
const CRON_PG_PORT = 55_450;
const CRON_REDIS_PORT = 56_450;
/** The first ports of the servers of the performance lanes, one per lane */
const PERF_PG_PORT = 55_500;
const PERF_REDIS_PORT = 56_380;
/** The workloads of a lane in phase A, one after the other */
const JOB_WORKLOADS = /** @type {const} */ ([['steady', NAMES], ['idle', NAMES]]);
/** The PostgreSQL servers' max_connections: the checks run the libraries in parallel on one */
const PG_CONNECTIONS = 500;
const tmp = mkdtempSync(join(tmpdir(), 'sqlane-compare-'));
/** @type {(() => void)[]} */
const cleanups = [];

/**
 * The environment of the processes that run the libraries: PATH and NODE_*, and HOME in the temporary directory of the
 * run. The libraries get their servers as arguments, so no other variable reaches them (no PG*, no DBOS__*, no
 * credentials of this shell), and no default credential path of the user (~/.npmrc, ~/.aws).
 * @returns {Record<string, string>}
 */
function minimalEnv() {
    // oxlint-disable-next-line node/no-process-env -- the one place that reads it, to pass on a part
    const env = /** @type {Record<string, string>} */ (process.env);

    return {
        ...Object.fromEntries(Object.entries(env).filter(([key]) => key === 'PATH' || key.startsWith('NODE_'))),
        HOME: tmp,
    };
}

/**
 * @param {string} command
 * @param {string[]} commandArgs
 * @param {{ log?: string }} [options] log: the output goes to this file.
 * @returns {import('node:child_process').ChildProcess}
 */
function start(command, commandArgs, { log } = {}) {
    const child = spawn(command, commandArgs, {
        stdio: log ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: minimalEnv(),
    });

    if (log) {
        /** @type {Buffer[]} */
        const chunks = [];

        child.stdout?.on('data', chunk => chunks.push(chunk));
        child.stderr?.on('data', chunk => chunks.push(chunk));
        child.on('exit', () => writeFileSync(log, Buffer.concat(chunks)));
    }

    return child;
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<number | null>}
 */
function exited(child) {
    if (child.exitCode !== null) {
        return Promise.resolve(child.exitCode);
    }

    return new Promise((resolve) => {
        child.on('exit', resolve);
    });
}

/**
 * The delay that netem adds on the loopback interface (bench/run_linux.sh vs-other-libs: `tc qdisc add dev lo root
 * netem delay 0.5ms`), from `tc qdisc show dev lo`. A packet goes through the loopback's queue once, so a round trip
 * between a client and its database costs twice the delay.
 * @returns {{ oneWayMs: number, roundTripMs: number, qdisc: string } | null} null: macOS (no netem), or no delay.
 */
function loopbackDelay() {
    if (!LINUX) {
        return null;
    }

    for (const tc of ['tc', '/usr/sbin/tc', '/sbin/tc']) {
        let qdisc;

        try {
            qdisc = execFileSync(tc, ['qdisc', 'show', 'dev', 'lo'], { encoding: 'utf8' }).trim();
        } catch {
            continue;
        }

        const match = /\bnetem\b.*?\bdelay ([\d.]+)(us|ms|s)\b/u.exec(qdisc);

        if (!match) {
            return null;
        }

        const oneWayMs = Number(match[1]) * { us: 0.001, ms: 1, s: 1000 }[/** @type {'us' | 'ms' | 's'} */ (match[2])];

        return { oneWayMs, roundTripMs: 2 * oneWayMs, qdisc };
    }

    return null;
}

/** @type {string | null} An initialized data directory that each PostgreSQL server clones */
let template = null;

/**
 * Starts PostgreSQL with pg_stat_statements (bench/lib/servers.mjs), stopped at the end of the run.
 * @param {number} port
 * @returns {Promise<Server>}
 */
async function postgresServer(port) {
    template ??= postgresTemplate({ bin: PG_BIN, dir: tmp });

    const server = await startPostgres({ bin: PG_BIN, port, dir: tmp, template, connections: PG_CONNECTIONS });

    cleanups.push(() => server.kill());

    return { url: server.url, pid: server.pid };
}

/**
 * Starts Redis for BullMQ (bench/lib/servers.mjs): the append-only file synced every second, no snapshots; and a
 * PostgreSQL for the business table.
 * @param {number} port
 * @param {number} businessPort
 * @returns {Promise<Server>}
 */
async function redisServer(port, businessPort) {
    const [server, business] = await Promise.all([
        startRedis({ bin: REDIS_BIN, port, dir: tmp }),
        postgresServer(businessPort),
    ]);

    cleanups.push(() => server.kill());

    return { url: server.url, pid: server.pid, business };
}

/**
 * @param {string} adminUrl
 * @param {string} database
 * @returns {Promise<string>} The URL of a new, empty database of the server.
 */
async function freshDatabase(adminUrl, database) {
    const url = new URL(adminUrl);

    await adminQuery(adminUrl, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await adminQuery(adminUrl, `CREATE DATABASE ${database}`);
    url.pathname = `/${database}`;

    return url.toString();
}

/**
 * The statements of the queue: those of the window, without the benchmark's own business work. Each job of the
 * producer (perf.mjs) is a business transaction on the queue's database: BEGIN, INSERT INTO orders, the library's
 * enqueue (or none: then the library enqueues after the COMMIT), COMMIT. The INSERT statements are those that name the
 * business table `orders`, which no library touches; each came with one BEGIN and one COMMIT of the producer, so the
 * business work is 3 statements per INSERT (pg_stat_statements counts BEGIN and COMMIT: track_utility is on by
 * default). Any other statement is the queue's: its enqueue in the transaction, its own transactions, its worker. On
 * BullMQ's Redis lane, the PostgreSQL holds the business table only, and its queue statements come out at 0.
 * @param {{ query: string, calls: number }[]} byStatement the statements of the window
 * @returns {{ statements: number, businessStatements: number, queueStatements: number }}
 */
function queueStatements(byStatement) {
    const callsOf = (/** @type {RegExp} */ pattern) => sum(
        byStatement.filter(({ query }) => pattern.test(query)).map(({ calls }) => calls),
    );
    const statements = sum(byStatement.map(({ calls }) => calls));
    const inserts = callsOf(/\borders\b/iu);

    // A transaction that straddles the reset loses its BEGIN: 1 at most
    if (callsOf(/^\s*(?:begin|start transaction)\b/iu) < inserts - 1 || callsOf(/^\s*commit\b/iu) < inserts - 1) {
        process.stderr.write(`warning: fewer BEGINs or COMMITs than business INSERT statements (${inserts}): queueStatements `
            + 'subtracts statements that did not run\n');
    }

    return { statements, businessStatements: 3 * inserts, queueStatements: statements - (3 * inserts) };
}

/**
 * The statements of a PostgreSQL database since the last reset (queueStatements()), and its connections.
 * @param {string} adminUrl
 * @param {string} database
 * @param {{ reset?: boolean }} [options] reset: then clear the statements of this database.
 * @returns {Promise<{ statements: number, businessStatements: number, queueStatements: number, connections: number }>}
 */
async function postgresStats(adminUrl, database, { reset = false } = {}) {
    const admin = new Client({ connectionString: adminUrl });

    await admin.connect();

    try {
        const { rows } = await admin.query(`
            SELECT s.query, sum(s.calls)::bigint AS calls
            FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid
            WHERE d.datname = $1
            GROUP BY s.query`, [database]);
        const { rows: [{ connections }] } = await admin.query(
            'SELECT count(*)::integer AS connections FROM pg_stat_activity WHERE datname = $1', [database],
        );

        if (reset) {
            // Only this database's: the admin connection works from another one
            await admin.query(`
                SELECT pg_stat_statements_reset(0, (SELECT oid FROM pg_database WHERE datname = $1), 0)
            `, [database]);
        }

        return {
            ...queueStatements(rows.map(row => ({ query: String(row.query), calls: Number(row.calls) }))),
            connections,
        };
    } finally {
        await admin.end();
    }
}

/**
 * @param {string} url
 * @returns {Promise<Record<string, number>>} The calls of each command since the start of the Redis server
 *     (`INFO commandstats`), those that its Lua scripts call included.
 */
async function redisCommandStats(url) {
    const { stdout } = await execFileAsync(join(REDIS_BIN, 'redis-cli'), ['-u', url, 'INFO', 'commandstats'], {
        encoding: 'utf8',
    });

    return Object.fromEntries([...stdout.matchAll(/^cmdstat_(\S+):calls=(\d+)/gmu)].map(match => [
        match[1], Number(match[2]),
    ]));
}

/**
 * The Redis commands of a window: those of the queue. The reading counts a command once it has run, so the first
 * reading's INFO is in the second, and the second's is in neither: the measuring costs 1 INFO.
 * @param {Record<string, number>} before
 * @param {Record<string, number>} after
 * @returns {{ redisCommands: number, redisByCommand: Record<string, number> }} redisByCommand: the calls of each
 *     command, those of the Lua scripts (EVALSHA) included.
 */
function redisDelta(before, after) {
    /** @type {Record<string, number>} */
    const redisByCommand = {};

    for (const [command, calls] of Object.entries(after)) {
        const count = calls - (before[command] ?? 0) - (command === 'info' ? 1 : 0);

        if (count > 0) {
            redisByCommand[command] = count;
        }
    }

    return { redisCommands: sum(Object.values(redisByCommand)), redisByCommand };
}

/**
 * @param {string} adminUrl
 * @param {string} database
 * @returns {Promise<Record<string, string>>} The backends of the connections to the database: label: pid.
 */
async function backends(adminUrl, database) {
    const admin = new Client({ connectionString: adminUrl });

    await admin.connect();

    const { rows } = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname = $1', [database]);

    await admin.end();

    return Object.fromEntries(rows.map(row => [`backend${row.pid}`, String(row.pid)]));
}

/**
 * The instructions of a database's backends in a window. A backend that started in it counts from zero; one that
 * ended in it is lost, as with a whole server (the pools keep their connections).
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @param {string[]} labels the backends at the end
 * @returns {{ instructions: number, cycles: number, cpuSeconds: number }}
 */
function backendDelta(before, after, labels) {
    const zero = { instructions: 0, cycles: 0, cpuSeconds: 0 };
    const deltas = labels.filter(label => after[label]?.instructions > 0)
        .map(label => difference(before[label] ?? zero, after[label]));

    return {
        instructions: sum(deltas.map(entry => entry.instructions)),
        cycles: sum(deltas.map(entry => entry.cycles)),
        cpuSeconds: sum(deltas.map(entry => entry.cpuSeconds)),
    };
}

/**
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @param {string} role
 * @returns {{ instructions: number, cycles: number, cpuSeconds: number }}
 */
function delta(before, after, role) {
    // PostgreSQL: the backends of the connections only, not autovacuum or the checkpointer, which earlier runs feed
    const backend = role === 'db' && after.db.byCommand?.backend;

    if (backend) {
        const [instructions, cycles, cpuSeconds] = backend;
        const [instructionsBefore, cyclesBefore, cpuBefore] = before.db.byCommand?.backend ?? [0, 0, 0];

        return {
            instructions: instructions - instructionsBefore,
            cycles: cycles - cyclesBefore,
            cpuSeconds: cpuSeconds - cpuBefore,
        };
    }

    return difference(before[role], after[role]);
}

/**
 * @typedef {{ url: string, pid: number, business?: Server }} Server A database server. Redis: its PostgreSQL for the
 *     business table in `business`.
 */

/**
 * @typedef {{ library: string, database: 'postgres' | 'redis' }} Lane A library on one of its databases.
 */

/**
 * @param {string[]} libraries
 * @returns {Promise<Lane[]>} A lane per library and PostgreSQL or Redis among the databases that its adapter lists.
 */
async function lanesOf(libraries) {
    /** @type {Lane[]} */
    const lanes = [];

    for (const library of libraries) {
        const { adapter } = /** @type {{ adapter: import('./libs/common.mjs').Adapter }} */ (
            await import(`./libs/${library.replaceAll('-', '_')}.mjs`)
        );

        for (const database of adapter.databases) {
            if (PERF_DATABASES.has(database)) {
                lanes.push({ library, database: /** @type {Lane['database']} */ (database) });
            }
        }
    }

    return lanes;
}

/**
 * @param {Lane[]} lanes
 * @param {number} pgPort the first port of PostgreSQL
 * @param {number} redisPort the first port of Redis
 * @returns {Promise<Server[]>} A server per lane; Redis with a PostgreSQL for the business table.
 */
function laneServers(lanes, pgPort, redisPort) {
    return Promise.all(lanes.map(({ database }, index) => (
        database === 'redis' ? redisServer(redisPort + index, pgPort + index) : postgresServer(pgPort + index)
    )));
}

/**
 * One workload of one library: prepareWorkload(), measure(), finishWorkload().
 * @param {Parameters<typeof prepareWorkload>[0]} workload
 * @returns {Promise<Record<string, any>>}
 */
async function runWorkload(workload) {
    const run = await prepareWorkload(workload);

    try {
        return await measure(run);
    } finally {
        await finishWorkload(run);
    }
}

/**
 * The database and the setup of one workload of one library.
 * @param {{ library: string, workload: string, names: number, server: Server, dialect?: string, schedules?: number,
 *     processes?: number, cron?: string, start?: Barrier, phase?: string }} args cron: the schedules' cron; start: the
 *     runs that start their windows together; phase: a suffix of its database.
 * @returns {Promise<Record<string, any>>} What measure() takes.
 */
async function prepareWorkload({
    library, workload, names, server, dialect, schedules = 0, processes = 1, cron: spec, start: barrier, phase = '',
}) {
    const cron = workload.startsWith('cron-');
    // A name, and an output directory, per database server too: a stale `ready` would start a window early
    const size = cron ? `${schedules}x${processes}` : names;
    const database = `perf_${library}_${dialect ?? 'postgres'}_${workload}_${size}${phase}`.replaceAll(/[-:]/gu, '_');
    // Redis: the queue there, the business table in PostgreSQL
    const sql = server.business ?? server;
    const businessUrl = await freshDatabase(sql.url, database);

    if (server.business) {
        execFileSync(join(REDIS_BIN, 'redis-cli'), ['-u', server.url, 'FLUSHALL'], { stdio: 'ignore' });
    }

    const url = server.business ? server.url : businessUrl;
    const out = join(tmp, database);
    const common = [
        join(HERE, 'perf.mjs'), '--library', library, '--url', url, '--business-url', businessUrl,
        '--names', String(names), '--out', out,
        '--warmup', String(WARMUP_S), '--measure', String(MEASURE_S), '--rate', String(RATE),
        ...dialect ? ['--dialect', dialect] : [],
        ...cron ? ['--schedules', String(schedules), '--cron', String(spec)] : [],
    ];

    execFileSync('mkdir', ['-p', out]);

    if (await exited(start(process.execPath, [...common, '--role', 'setup'], { log: join(out, 'setup.log') })) !== 0) {
        throw new Error(`${database}: setup failed: ${readFileSync(join(out, 'setup.log'), 'utf8').slice(-2000)}`);
    }

    return {
        library, workload, names, dialect, url, out, common, db: `${sql.pid}+`, server, database, schedules, processes,
        spec, barrier,
    };
}

/**
 * @param {Record<string, any>} run from prepareWorkload()
 * @returns {Promise<Record<string, any>>} The row of the workload.
 */
async function measure(run) {
    const { adapter } = /** @type {{ adapter: import('./libs/common.mjs').Adapter }} */ (
        await import(`./libs/${run.library.replaceAll('-', '_')}.mjs`)
    );

    return {
        ...run.workload.startsWith('cron-') ? await measureSchedules(run) : await measureWorkload(run),
        // Without it, the producer enqueues after the COMMIT: not atomic
        transactional: adapter.transactional,
    };
}

/**
 * @param {Record<string, any>} run from prepareWorkload()
 * @returns {Promise<void>}
 */
async function finishWorkload({ server, database }) {
    // No autovacuum of its tables in the next runs
    await adminQuery((server.business ?? server).url, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
}

/**
 * @param {string} adminUrl
 * @param {string} sql
 * @returns {Promise<void>}
 */
async function adminQuery(adminUrl, sql) {
    const admin = new Client({ connectionString: adminUrl });

    await admin.connect();
    await admin.query(sql);
    await admin.end();
}

/**
 * @param {string} file
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
async function untilFile(file, child) {
    while (!existsSync(file) && child.exitCode === null) {
        await sleep(50);
    }
}

/**
 * Steady load or idle: a worker, and for steady a producer, with a window of MEASURE_S after WARMUP_S.
 * @param {Record<string, any>} run
 * @returns {Promise<Record<string, any>>}
 */
async function measureWorkload({ library, workload, names, dialect, out, common, db, server, database, barrier }) {
    const sql = server.business ?? server;
    const redis = server.business ? server.url : null;
    // The database of a library on Redis: Redis and the PostgreSQL of the business table
    const servers = { db, ...redis && { redis: String(server.pid) } };
    /**
     * @param {Record<string, any>} before
     * @param {Record<string, any>} after
     * @returns {{ instructions: number, cycles: number, cpuSeconds: number }}
     */
    const dbDelta = (before, after) => {
        const relational = delta(before, after, 'db');
        const memory = redis ? delta(before, after, 'redis') : { instructions: 0, cycles: 0, cpuSeconds: 0 };

        return {
            instructions: relational.instructions + memory.instructions,
            cycles: relational.cycles + memory.cycles,
            cpuSeconds: relational.cpuSeconds + memory.cpuSeconds,
        };
    };

    await adminQuery(sql.url, 'CHECKPOINT');

    const worker = start(process.execPath, [...common, '--role', 'worker'], { log: join(out, 'worker.log') });

    await untilFile(join(out, 'ready'), worker);
    // The windows of a phase start together
    await barrier?.arrive();

    const producer = workload === 'steady'
        ? start(process.execPath, [...common, '--role', 'producer'], { log: join(out, 'producer.log') })
        : null;
    const pids = { ...servers, worker: String(worker.pid), ...producer && { producer: String(producer.pid) } };

    await sleep(WARMUP_S * 1000);

    // Without blocking the other lanes; the window is the time between the two readings
    const before = await countersAsync(pids);
    const startedAt = Date.now();

    await postgresStats(sql.url, database, { reset: true });

    const redisBefore = redis ? await redisCommandStats(redis) : null;

    await sleep((MEASURE_S * 1000) - (Date.now() - startedAt));

    const after = await countersAsync(pids);
    const seconds = (Date.now() - startedAt) / 1000;
    const stats = await postgresStats(sql.url, database);
    const commands = redis && redisDelta(/** @type {Record<string, number>} */ (redisBefore),
        await redisCommandStats(redis));

    await Promise.all([exited(worker), producer && exited(producer)]);

    const result = readJson(join(out, 'worker.json'));

    return {
        library, workload, names, dialect: dialect ?? 'postgres', seconds,
        ...result,
        // Steady: the worker ran the jobs of its window, 95% at least; else its cost per job is not a cost per job
        ...workload === 'steady' && { keptUp: (result?.completed ?? 0) >= 0.95 * RATE * MEASURE_S },
        // Redis: the statements of the business table's PostgreSQL
        ...stats,
        ...commands,
        worker: delta(before, after, 'worker'),
        ...producer && { producer: delta(before, after, 'producer') },
        db: dbDelta(before, after),
    };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleepUntil = ms => sleep(Math.max(0, ms - Date.now()));

/**
 * @typedef {{ arrive: () => Promise<number>, leave: () => void }} Barrier Each run arrives once its workers are ready,
 *     or leaves when it fails before. arrive() resolves to the time when the last one arrived.
 */

/**
 * @param {number} count
 * @returns {() => Barrier} a barrier for each of count runs
 */
function barrierOf(count) {
    let waiting = count;
    /** @type {PromiseWithResolvers<number>} */
    const { promise: all, resolve: release } = Promise.withResolvers();

    return () => {
        let done = false;
        const leave = () => {
            if (!done) {
                done = true;
                waiting--;

                if (waiting === 0) {
                    release(Date.now());
                }
            }
        };

        return {
            arrive: () => {
                leave();

                return all;
            },
            leave,
        };
    };
}

/**
 * The schedules: `processes` workers with the schedules of one job name, in a database of its own. The runs start
 * together: the first slot comes CRON_WARMUP_S or more after the start; the CPU window is one period, from 30 s after
 * the first slot to 30 s after the second; the jobs of both slots get CRON_LATE_S after the second to start. Each
 * worker notes the scheduled jobs that it started; after they stop, the library's tables give the jobs that it stored.
 * @param {Record<string, any>} run
 * @returns {Promise<Record<string, any>>}
 */
async function measureSchedules({
    library, workload, names, dialect, url, out, common, server, database, schedules, processes, spec, barrier,
}) {
    // PostgreSQL: the backends of the run's database; Redis: the server, which is the run's
    const redis = server.business ? server.url : null;
    /** @returns {Promise<Record<string, string>>} The processes of the database. */
    const databasePids = async () => (redis ? { db: String(server.pid) } : backends(server.url, database));
    const workers = Array.from({ length: processes }, (_, index) => start(process.execPath, [
        ...common, '--role', 'worker', '--index', String(index),
    ], { log: join(out, `worker-${index}.log`) }));

    for (const [index, worker] of workers.entries()) {
        await untilFile(join(out, `ready-${index}`), worker);
    }

    const ready = await barrier.arrive();
    const pids = Object.fromEntries(workers.map((worker, index) => [`worker${index}`, String(worker.pid)]));
    const firstSlot = Math.ceil((ready + (CRON_WARMUP_S * 1000)) / MINUTE_MS) * MINUTE_MS;
    const windowStart = firstSlot + 30_000;
    const seconds = CRON_FIRE_S;
    const windowEnd = windowStart + (seconds * 1000);

    await sleepUntil(windowStart);

    const before = await countersAsync({ ...pids, ...await databasePids() });

    if (!redis) {
        await postgresStats(server.url, database, { reset: true });
    }

    const redisBefore = redis ? await redisCommandStats(redis) : null;

    await sleepUntil(windowEnd);

    const ended = await databasePids();
    const after = await countersAsync({ ...pids, ...ended });
    // Statements and connections: PostgreSQL; commands: Redis
    const stats = redis ? {} : await postgresStats(server.url, database);
    const commands = redis && redisDelta(/** @type {Record<string, number>} */ (redisBefore),
        await redisCommandStats(redis));
    const slots = [firstSlot, firstSlot + MINUTE_MS];

    await sleepUntil(slots[1] + (CRON_LATE_S * 1000));

    for (const worker of workers) {
        worker.kill('SIGUSR2');
    }

    await Promise.all(workers.map(worker => exited(worker)));

    const reports = workers.map((_, index) => (
        /** @type {{ scheduled: [string, number | null, number][] }} */
        (readJson(join(out, `worker-${index}.json`)) ?? { scheduled: [] })
    ));
    const roles = workers.map((_, index) => delta(before, after, `worker${index}`));
    const worker = {
        instructions: sum(roles.map(role => role.instructions)),
        cycles: sum(roles.map(role => role.cycles)),
        cpuSeconds: sum(roles.map(role => role.cpuSeconds)),
    };
    const { adapter } = /** @type {{ adapter: import('./libs/common.mjs').Adapter }} */ (
        await import(`./libs/${library.replaceAll('-', '_')}.mjs`)
    );
    const stored = adapter.scheduledJobs ? await adapter.scheduledJobs(url) : null;

    return {
        library, workload, names, dialect: dialect ?? 'postgres', schedules, processes, cron: spec, seconds, ...stats,
        ...commands,
        ...stored && slotCounts({
            scheduled: reports.flatMap(report => report.scheduled), stored, schedules, slots, windowStart, windowEnd,
        }),
        worker, db: redis ? delta(before, after, 'db') : backendDelta(before, after, Object.keys(ended)),
    };
}

/**
 * @param {number} ms
 * @returns {string}
 */
const iso = ms => new Date(ms).toISOString();

/**
 * @param {(number | null | undefined)[]} values
 * @returns {number | null} The median of the numbers among them.
 */
function median(values) {
    const numbers = /** @type {number[]} */ (values.filter(value => typeof value === 'number'));

    return numbers.length ? percentile(numbers, 0.5) : null;
}

/**
 * Counts the scheduled jobs of the slots: those that the library stored or ran, the duplicates, those that started,
 * and their lag from the slot to the handler start.
 * @param {{ scheduled: [string, number | null, number][], stored: import('./libs/common.mjs').ScheduledJobs,
 *     schedules: number, slots: number[], windowStart: number, windowEnd: number }} run scheduled: key, slot and
 *     start of each job that a handler started.
 * @returns {Record<string, any>}
 */
function slotCounts({ scheduled, stored, schedules, slots, windowStart, windowEnd }) {
    /** @type {Map<string, number>} jobs per key and slot */
    const counts = new Map();
    const add = (/** @type {string} */ key, /** @type {string} */ slot) => {
        counts.set(`${key} ${slot}`, (counts.get(`${key} ${slot}`) ?? 0) + 1);
    };
    let duplicates = 0;

    if (stored.forwarded && stored.filed) {
        // pg-boss: its jobs do not carry the slot. Each key's jobs pair, in order, with the slots whose forwarding job
        // ran: the send-it queue and the job's queue are both first in, first out
        const forwarded = stored.forwarded;
        /** @type {Map<string, [string, number | null, number][]>} */
        const byKey = new Map();

        for (const entry of scheduled.toSorted((a, b) => a[2] - b[2])) {
            const list = byKey.get(entry[0]) ?? [];

            list.push(entry);
            byKey.set(entry[0], list);
        }

        for (const [key, entries] of byKey) {
            for (const [index, entry] of entries.entries()) {
                const slot = forwarded[key]?.[index];

                entry[1] = slot ? Date.parse(slot) : null;
            }
        }

        // A slot filed twice, or more jobs of a key than forwarding jobs that ran
        for (const list of Object.values(stored.filed)) {
            duplicates += list.length - new Set(list).size;
        }

        /** @type {Map<string, number>} */
        const jobsPerKey = new Map();

        for (const [key] of stored.jobs) {
            jobsPerKey.set(key, (jobsPerKey.get(key) ?? 0) + 1);
        }

        for (const [key, count] of jobsPerKey) {
            duplicates += Math.max(0, count - (forwarded[key]?.length ?? 0));
        }

        for (const [key, list] of Object.entries(stored.filed)) {
            for (const slot of new Set(list)) {
                add(key, slot);
            }
        }
    } else {
        // The jobs in the library's tables; Graphile Worker deletes a completed job, so its handler saw it
        for (const [key, slot] of stored.jobs) {
            add(key, String(slot));
        }

        if (stored.deletesCompleted) {
            for (const [key, slot] of scheduled) {
                add(key, iso(/** @type {number} */ (slot)));
            }
        }

        duplicates = sum([...counts.values()].map(count => count - 1));
    }

    const inSlots = scheduled.filter(([, slot]) => slot !== null && slots.includes(slot));
    const lags = inSlots.map(([, slot, startedAt]) => startedAt - /** @type {number} */ (slot));

    return {
        slots: slots.map(iso),
        // Each schedule should add 1 job for each slot
        expected: schedules * slots.length,
        // The slots that the library decided: a job stored or run (pg-boss: an occurrence filed)
        decided: sum(slots.map(slot => [...counts.keys()].filter(id => id.endsWith(` ${iso(slot)}`)).length)),
        // Over all the slots of the run, also those before and after the two
        duplicates,
        started: inSlots.length,
        // The scheduled jobs that started in the CPU window, of any slot: 1000 when the library keeps up
        startedInWindow: scheduled.filter(entry => entry[2] >= windowStart && entry[2] < windowEnd).length,
        // pg-boss: the occurrences that it forwarded as jobs in the CPU window
        ...stored.forwardedAt && {
            forwardedInWindow: stored.forwardedAt.filter(time => time >= windowStart && time < windowEnd).length,
        },
        lagP50Ms: percentile(lags, 0.5),
        lagP99Ms: percentile(lags, 0.99),
        lagMaxMs: lags.length ? Math.max(...lags) : null,
    };
}

/**
 * @param {number[]} values
 * @param {number} fraction
 * @returns {number | null}
 */
function percentile(values, fraction) {
    const sorted = values.toSorted((a, b) => a - b);

    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] : null;
}

/**
 * @param {string} file
 * @returns {Record<string, any> | null}
 */
function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * @param {number} value
 * @returns {string}
 */
const millions = value => (value / 1e6).toFixed(1);

/**
 * @param {Record<string, any>} row
 * @param {string} role
 * @returns {number} The instructions of the role per job.
 */
const perJob = (row, role) => (row[role] ? row[role].instructions / row.completed : 0);

/**
 * @param {number[]} values
 * @returns {number}
 */
function sum(values) {
    let total = 0;

    for (const value of values) {
        total += value;
    }

    return total;
}

/**
 * @param {Record<string, any>} row
 * @param {number} count the jobs or slots
 * @returns {string} The queue's statements (PostgreSQL) or commands (Redis) per job or slot.
 */
function queueWork(row, count) {
    if (row.dialect === 'redis') {
        return row.redisCommands === undefined ? '—' : `${(row.redisCommands / count).toFixed(2)} Redis commands`;
    }

    return row.queueStatements === undefined ? '—' : (row.queueStatements / count).toFixed(2);
}

/**
 * @param {Record<string, any>[]} runs
 * @returns {string}
 */
function tables(runs) {
    const lines = [];

    lines.push('Steady load: 20 jobs/s over 1000 job names, each with an INSERT in a transaction. Per job; (timing): phase B.\n');
    lines.push('| Library | Database | Jobs | Instructions (M), worker / producer / db = total | Queue statements | CPU ms | Latency p50 / p99 ms |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');

    for (const row of runs.filter(entry => entry.workload === 'steady')) {
        const roles = ['worker', 'producer', 'db'];
        const instructions = roles.map(role => perJob(row, role));
        const cpu = sum(roles.map(role => row[role]?.cpuSeconds ?? 0)) / row.completed * 1000;
        const total = millions(sum(instructions));
        const library = `${row.library}${row.transactional === false ? ' (enqueue after commit, not atomic)' : ''}${row.timing ? ' (timing)' : ''}`;
        // Behind the load: its cost per job that ran is not a cost per job
        const cost = row.keptUp === false ? `— (${row.completed} of ${Math.round(RATE * row.seconds)} ran)` : `${instructions.map(millions).join(' / ')} = **${total}**`;

        lines.push(`| ${library} | ${row.dialect} | ${row.completed} | ${cost} | ${queueWork(row, row.completed)} | ${cpu.toFixed(1)} | ${row.latencyP50Ms} / ${row.latencyP99Ms} |`);
    }

    lines.push('\nIdle: no jobs. Per second of the window.\n');
    lines.push('| Library | Database | Job names | Database instructions (M) | Worker instructions (M) | Queue statements | Connections |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');

    for (const row of runs.filter(entry => entry.workload === 'idle')) {
        lines.push(`| ${row.library} | ${row.dialect} | ${row.names} | ${millions(row.db.instructions / row.seconds)} | ${millions(row.worker.instructions / row.seconds)} | ${queueWork(row, row.seconds)} | ${row.connections ?? '—'} |`);
    }

    lines.push(`\nSchedules, firing: ${SCHEDULES} schedules of \`${FIRE_CRON}\`. Per due slot over one minute; jobs and lag of 2 slots. Median of ${CRON_REPEATS} run(s).\n`);
    lines.push('| Library | Database | Processes | Instructions per slot (M), workers / db = total | Queue statements | Started per minute | Decided / started / expected | Duplicates | Lag p50 / p99 ms |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

    for (const row of runs.filter(entry => entry.workload === 'cron-fire')) {
        // The slots due in the CPU window: the schedules fire once a minute
        const slots = row.schedules * row.seconds / 60;
        const worker = row.worker.instructions / slots;
        const db = row.db.instructions / slots;

        lines.push(`| ${row.library}${row.transactional === false ? ' (not transactional)' : ''} | ${row.dialect} | ${row.processes} | ${millions(worker)} / ${millions(db)} = **${millions(worker + db)}** | ${queueWork(row, slots)} | ${row.startedInWindow}${row.forwardedInWindow === undefined ? '' : ` (forwarded ${row.forwardedInWindow})`} | ${row.decided} / ${row.started} / ${row.expected} | ${row.duplicates} | ${row.lagP50Ms} / ${row.lagP99Ms} |`);
    }

    return lines.join('\n');
}

/**
 * The performance of jobs: a lane per library on PostgreSQL, and BullMQ's on Redis, each with a server of its own.
 * Phase A, for instructions and statements: the lanes in parallel (in batches of PARALLEL), one workload at a time, the
 * windows started together (steady, idle with 1000 names); instructions do not depend on the load of the machine
 * (see docs/contributing/benchmarks.md).
 * Phase B, for times: one lane at a time, the steady load, for the latencies and the CPU time. Its rows have
 * `timing: true`.
 * @param {string[]} libraries
 * @returns {Promise<Record<string, any>[]>}
 */
async function runJobs(libraries) {
    const lanes = await lanesOf(libraries);
    const servers = await laneServers(lanes, PERF_PG_PORT, PERF_REDIS_PORT);
    /**
     * @param {number} index
     * @param {string} workload
     * @param {number} names
     * @param {string} [phase]
     * @returns {Promise<Record<string, any>>}
     */
    const prepare = (index, workload, names, phase) => {
        const { library, database } = lanes[index];

        return prepareWorkload({
            library, workload, names, server: servers[index], ...database !== 'postgres' && { dialect: database }, phase,
        });
    };
    /** @type {Record<string, any>[]} */
    const rows = [];
    let startedAt = Date.now();

    for (const [workload, names] of JOB_WORKLOADS) {
        for (const batch of batches(lanes.map((_, index) => index), PARALLEL)) {
            process.stderr.write(`jobs, phase A: ${workload} ${names}, ${batch.length} of ${lanes.length} lanes in parallel\n`);

            const runs = await Promise.all(batch.map(index => prepare(index, workload, names)));
            const barrier = barrierOf(runs.length);
            const settled = await Promise.allSettled(runs.map(async (run) => {
                const own = barrier();

                try {
                    return await measure({ ...run, barrier: own });
                } finally {
                    own.leave();
                    await finishWorkload(run);
                }
            }));
            const failed = settled.find(result => result.status === 'rejected');

            if (failed) {
                throw failed.reason;
            }

            rows.push(...settled.map(result => (result.status === 'fulfilled' ? result.value : {})));
        }
    }

    process.stderr.write(`jobs, phase A: ${Math.round((Date.now() - startedAt) / 1000)} s\n`);
    startedAt = Date.now();

    for (const [index, { library, database }] of lanes.entries()) {
        process.stderr.write(`jobs, phase B: steady ${library} on ${database}\n`);

        const run = await prepare(index, 'steady', NAMES, '_b');

        try {
            rows.push({ ...await measure(run), timing: true });
        } finally {
            await finishWorkload(run);
        }
    }

    process.stderr.write(`jobs, phase B: ${Math.round((Date.now() - startedAt) / 1000)} s\n`);

    return rows;
}

/**
 * The firing schedules: a run per library on PostgreSQL, and BullMQ's on Redis, each with a server and a database of
 * its own and CRON_PROCESSES workers. The runs go in parallel (in batches of PARALLEL): instructions do not depend on
 * the load of the machine (see docs/contributing/benchmarks.md), and the runs wait for the same minutes.
 * CRON_REPEATS times; a row has the median of each number, and each run in `samples`.
 * @param {string[]} libraries
 * @returns {Promise<Record<string, any>[]>}
 */
async function runSchedules(libraries) {
    const step = { workload: 'cron-fire', names: 1, schedules: SCHEDULES, processes: CRON_PROCESSES, cron: FIRE_CRON };
    const lanes = await lanesOf(libraries);
    const servers = await laneServers(lanes, CRON_PG_PORT, CRON_REDIS_PORT);
    /** @type {Record<string, any>[][]} the runs of each lane */
    const samples = lanes.map(() => []);
    const groups = batches(lanes.map((_, index) => index), PARALLEL);

    for (let repeat = 1; repeat <= CRON_REPEATS; repeat++) {
        for (const group of groups) {
            const barrier = barrierOf(group.length);

            process.stderr.write(`schedules ${repeat}/${CRON_REPEATS}: ${group.length} of ${lanes.length} runs in parallel\n`);

            const settled = await Promise.allSettled(group.map(async (index) => {
                const { library, database } = lanes[index];
                const own = barrier();

                try {
                    return await runWorkload({
                        library, ...step, ...database !== 'postgres' && { dialect: database }, server: servers[index],
                        start: own,
                    });
                } finally {
                    own.leave();
                }
            }));
            const failed = settled.find(result => result.status === 'rejected');

            if (failed) {
                throw failed.reason;
            }

            for (const [position, result] of settled.entries()) {
                samples[group[position]].push(result.status === 'fulfilled' ? result.value : {});
            }
        }
    }

    return samples.map(medianRow);
}

/** The numbers of a schedule row that its median takes */
const MEDIAN_FIELDS = [
    'statements', 'businessStatements', 'queueStatements', 'redisCommands', 'connections', 'decided', 'started',
    'startedInWindow', 'forwardedInWindow', 'lagP50Ms', 'lagP99Ms', 'lagMaxMs',
];

/**
 * @param {Record<string, any>[]} rows the runs of one step
 * @returns {Record<string, any>} the median of each number, the most duplicates, and each run in `samples`
 */
function medianRow(rows) {
    /**
     * @param {'worker' | 'db'} role
     * @returns {{ instructions: number | null, cycles: number | null, cpuSeconds: number | null }}
     */
    const counter = role => ({
        instructions: median(rows.map(row => row[role].instructions)),
        cycles: median(rows.map(row => row[role].cycles)),
        cpuSeconds: median(rows.map(row => row[role].cpuSeconds)),
    });
    const row = { ...rows[0] };

    for (const field of MEDIAN_FIELDS) {
        if (field in row) {
            row[field] = median(rows.map(entry => entry[field]));
        }
    }

    if ('duplicates' in row) {
        row.duplicates = Math.max(...rows.map(entry => entry.duplicates));
    }

    row.worker = counter('worker');
    row.db = counter('db');
    row.samples = rows.map(entry => ({
        ...Object.fromEntries([...MEDIAN_FIELDS, 'duplicates', 'slots'].filter(field => field in entry)
            .map(field => [field, entry[field]])),
        worker: entry.worker.instructions,
        db: entry.db.instructions,
    }));

    return row;
}

process.once('SIGINT', () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
        try {
            cleanup();
        } catch {
            // Already stopped
        }
    }

    stopCounters();
    process.kill(process.pid, 'SIGINT');
});

try {
    const runStartedAt = Date.now();
    const latency = loopbackDelay();

    if (LINUX && !latency) {
        process.stderr.write('warning: no netem delay on the loopback: the latencies of the documents come with 0.5 ms '
            + 'each way (bench/run_linux.sh vs-other-libs)\n');
    }

    // Before the servers and the libraries start: the Linux daemon counts a process from its own start
    await startCounters();

    if (countsKernel() === false) {
        process.stderr.write('warning: the counters count user space only: the published numbers count the kernel '
            + 'too (on the host: sysctl kernel.perf_event_paranoid=1)\n');
    }

    // The checks have a server; the jobs and the schedules start servers of their own
    const postgres = PARTS.has('checks') ? await postgresServer(CHECKS_PG_PORT) : null;
    // A run of one part keeps the other parts' results. The date of each part, and of the last run
    const saved = readJson(join(HERE, 'results.json')) ?? {};
    const date = new Date().toISOString();
    /** @type {Record<string, any>} */
    const results = {
        ...saved,
        date,
        node: process.version,
        dates: { ...saved.dates, ...Object.fromEntries([...PARTS].map(part => [part, date])) },
        // The machine of each part: its numbers compare with those of other parts only on the same one. latency: the
        // delay of the loopback (netem), null without one; kernelCounted: the instructions include the kernel's (Linux)
        machines: {
            ...saved.machines,
            ...Object.fromEntries([...PARTS].map(part => [part, {
                platform: process.platform, kernel: kernelRelease(), cpu: cpus()[0]?.model.trim(), cores: cpus().length,
                memoryGiB: Math.round(totalmem() / 2 ** 30), parallel: Number.isFinite(PARALLEL) ? PARALLEL : null,
                latency, kernelCounted: countsKernel(),
            }])),
        },
    };
    const libraries = LIBRARIES;
    /** @type {Record<string, number>} the seconds of each part */
    const partSeconds = {};

    if (PARTS.has('checks')) {
        const partStartedAt = Date.now();
        const log = join(tmp, 'checks.log');

        process.stderr.write(`checks (log: ${log})\n`);
        const { url } = /** @type {Server} */ (postgres);

        await exited(start(process.execPath, [join(HERE, 'checks.mjs'), url], { log }));
        results.checks = readJson(join(HERE, 'checks.json'));
        console.log(readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('|')).join('\n'));
        partSeconds.checks = Math.round((Date.now() - partStartedAt) / 1000);
    }

    if (PARTS.has('perf')) {
        const partStartedAt = Date.now();
        const runs = await runJobs(libraries);

        // A run of some libraries replaces their rows only
        /** @type {Record<string, any>[]} */
        const previous = results.perf ?? [];
        const kept = previous.filter(row => row.workload.startsWith('cron-') || !libraries.includes(row.library));

        results.perf = [...kept, ...runs];
        partSeconds.perf = Math.round((Date.now() - partStartedAt) / 1000);
    }

    if (PARTS.has('cron')) {
        const partStartedAt = Date.now();
        const runs = await runSchedules(libraries);
        /** @type {Record<string, any>[]} */
        const previous = results.perf ?? [];
        const kept = previous.filter(row => (
            !row.workload.startsWith('cron-') || !libraries.includes(row.library)
        ));

        results.perf = [...kept, ...runs];
        partSeconds.cron = Math.round((Date.now() - partStartedAt) / 1000);
    }

    for (const [part, seconds] of Object.entries(partSeconds)) {
        results.machines[part].seconds = seconds;
    }

    if (results.perf) {
        console.log(`\n${tables(results.perf)}`);
    }

    writeFileSync(join(HERE, 'results.json'), `${JSON.stringify(results, null, 4)}\n`);
    process.stderr.write(`total: ${Math.round((Date.now() - runStartedAt) / 1000)} s (${Object.entries(partSeconds)
        .map(([part, seconds]) => `${part} ${seconds} s`).join(', ')})\n`);
} finally {
    stopCounters();

    for (const cleanup of cleanups.toReversed()) {
        try {
            cleanup();
        } catch {
            // Already stopped
        }
    }

    rmSync(tmp, { recursive: true, force: true });
}
