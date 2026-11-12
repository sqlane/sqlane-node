// The comparison of docs/comparison.md and docs/comparison-performance.md: the feature checks, the performance
// workloads of jobs, and those of schedules, on database servers of this host (macOS, Homebrew).
//
//   pnpm bench:compare                    # checks and perf, about 10.5 minutes
//   pnpm bench:compare --only checks      # or: perf (the jobs, about 9 minutes), cron (the schedules, about 9)
//   pnpm bench:compare --only cron --libs sqlane,river
//
// Options: --pg-bin, --mysql-bin, --mariadb-bin (the directories of the server binaries). Writes results.json next to
// this file and prints Markdown tables. See README.md.
/* oxlint-disable no-await-in-loop -- the runs go one after the other: they share the machine */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { createConnection } from 'mysql2/promise';
import { Client } from 'pg';

const execFileAsync = promisify(execFile);
const HERE = import.meta.dirname;
const PROC_USAGE = join(HERE, '../cpu/proc_usage.py');
const { values: args } = parseArgs({
    options: {
        'only': { type: 'string' },
        'libs': { type: 'string' },
        'pg-bin': { type: 'string', default: '/opt/homebrew/opt/postgresql@17/bin' },
        'mysql-bin': { type: 'string', default: '/opt/homebrew/opt/mysql@8.4/bin' },
        'mariadb-bin': { type: 'string', default: '/opt/homebrew/opt/mariadb@11.8/bin' },
        'redis-bin': { type: 'string', default: '/opt/homebrew/bin' },
    },
});
const PG_BIN = args['pg-bin'];
const MYSQL_BIN = args['mysql-bin'];
const MARIADB_BIN = args['mariadb-bin'];
const REDIS_BIN = args['redis-bin'];
/**
 * The libraries of the performance runs. Each adapter uses the settings that its library's documentation offers for
 * throughput (libs/common.mjs); a library whose enqueue cannot take the caller's transaction enqueues after the COMMIT.
 */
const PERF_LIBRARIES = [
    'sqlane', 'pg-boss', 'graphile-worker', 'river', 'bullmq', 'sidequest', 'boring-node-queue', 'izi-queue',
];
/** The schedules: the libraries whose adapters run schedules */
const CRON_LIBRARIES = new Set([
    'sqlane', 'pg-boss', 'graphile-worker', 'river', 'bullmq', 'sidequest', 'boring-node-queue', 'izi-queue',
]);
const ALL_PARTS = ['checks', 'perf', 'cron'];
/** The schedules are a part of their own, outside the default: each run stays under 15 minutes */
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
const BACKLOG = 10_000;
/** A drain that takes longer stops: each run stays under 15 minutes */
const DRAIN_LIMIT_S = 60;
const SCHEDULES = 1000;
/** A sparse cron, which pg-boss's cron parser evaluates far slower than a daily one: a separate idle run */
const YEARLY_CRON = '0 0 1 1 *';
const FIRE_CRON = '* * * * *';
/** The schedule runs repeat: the tables give the median, results.json each run */
const CRON_REPEATS = 3;
/**
 * The window of the idle schedules: twice the longest check of a library (sqlane's longest timer sleep and Graphile
 * Worker's minute timer, 60 s; pg-boss's cron pass, 30 s; River's election, 5 s), so each check counts a whole number
 * of times. The schedule runs go in parallel: it ends with the firing ones
 */
const CRON_IDLE_S = 120;
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
/**
 * The first ports of the servers of the schedule runs. PostgreSQL: one per library, each run counts the backends of its
 * database; then the one of the business tables of the runs on Redis. Redis and MySQL: one per run, the server's
 * process is the run's database
 */
const CRON_PORT = 55_450;
const CRON_REDIS_PORT = 56_450;
const CRON_MYSQL_PORT = 53_450;
/** The first ports of the servers of the performance lanes: one per library and database */
const PERF_PG_PORT = 55_500;
const PERF_MYSQL_PORT = 53_320;
const PERF_REDIS_PORT = 56_380;
/** The workloads of a lane, one after the other */
const JOB_WORKLOADS = /** @type {const} */ ([['steady', NAMES], ['idle', 1], ['idle', NAMES], ['drain', NAMES]]);
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
 * The counters of processes, without blocking the runs that go in parallel.
 * @param {Record<string, string>} processes label: pid, with `+` for the process and its descendants
 * @returns {Promise<Record<string, any>>} label: { instructions, cycles, cpuSeconds, byCommand }
 */
async function countersAsync(processes) {
    const { stdout } = await execFileAsync('python3', [
        PROC_USAGE, ...Object.entries(processes).map(([label, pid]) => `${label}=${pid}`),
    ], { encoding: 'utf8' });

    return JSON.parse(stdout);
}

/**
 * Starts PostgreSQL with pg_stat_statements.
 * @param {{ port?: number, template?: string, connections?: number }} [options] template: a data directory to clone
 *     instead of initdb.
 * @returns {Promise<{ url: string, pid: number }>}
 */
async function startPostgres({ port = 55_442, template, connections = 500 } = {}) {
    const data = join(tmp, `pg-${port}`);

    if (template) {
        // A clone on APFS: instant
        await execFileAsync('cp', ['-c', '-R', template, data]);
    } else {
        execFileSync(join(PG_BIN, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
    }

    await execFileAsync(join(PG_BIN, 'pg_ctl'), ['-D', data, '-l', join(tmp, `pg-${port}.log`), '-w', 'start', '-o', [
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c max_connections=${connections}`,
        '-c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=top',
    ].join(' ')]);
    cleanups.push(() => execFileSync(join(PG_BIN, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' }));

    const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    const admin = new Client({ connectionString: url });

    await admin.connect();
    await admin.query('CREATE EXTENSION pg_stat_statements');
    await admin.end();

    return { url, pid: Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]) };
}

/** @type {Promise<void>} The installations of MySQL and MariaDB data directories, one after the other */
let installs = Promise.resolve();

/**
 * Starts MySQL or MariaDB, as bench/cpu/measure.sh: default configuration; MariaDB with the binary log of MySQL 8.4.
 * @param {'mysql' | 'mariadb'} dialect
 * @param {{ port?: number, name?: string }} [options] name: of its data directory, socket and log.
 * @returns {Promise<{ url: string, pid: number }>}
 */
async function startMysqlFamily(dialect, { port = dialect === 'mysql' ? 53_317 : 53_318, name = dialect } = {}) {
    const data = join(tmp, name);
    const initFile = join(tmp, `${name}-init.sql`);

    writeFileSync(initFile, `CREATE DATABASE IF NOT EXISTS bench;
CREATE USER IF NOT EXISTS 'bench'@'127.0.0.1';
GRANT ALL ON *.* TO 'bench'@'127.0.0.1';
`);

    // One installation at a time: parallel ones share temporary tables in the system's temporary directory
    const previous = installs;
    /** @type {PromiseWithResolvers<void>} */
    const { promise, resolve: done } = Promise.withResolvers();

    installs = promise;

    // A temporary directory of its own, too: the servers name their temporary tables after their process ids
    const temporary = `${data}-tmp`;

    execFileSync('mkdir', ['-p', temporary]);

    try {
        await previous;

        if (dialect === 'mysql') {
            await execFileAsync(join(MYSQL_BIN, 'mysqld'), [
                '--no-defaults', '--initialize-insecure', `--datadir=${data}`, `--tmpdir=${temporary}`,
            ]);
        } else {
            await execFileAsync(join(MARIADB_BIN, 'mariadb-install-db'), [
                '--no-defaults', `--datadir=${data}`, '--skip-test-db',
            ], { env: { ...minimalEnv(), TMPDIR: temporary } });
        }
    } finally {
        done();
    }

    const server = spawn(dialect === 'mysql' ? join(MYSQL_BIN, 'mysqld') : join(MARIADB_BIN, 'mariadbd'), [
        '--no-defaults', `--datadir=${data}`, `--port=${port}`, '--bind-address=127.0.0.1', `--socket=${name}.sock`,
        `--tmpdir=${temporary}`,
        `--log-error=${join(tmp, `${name}.err`)}`, `--init-file=${initFile}`,
        ...dialect === 'mysql' ? ['--mysqlx=OFF'] : ['--log-bin=binlog', '--sync-binlog=1', '--binlog-format=ROW'],
    ], { cwd: tmp, stdio: 'ignore' });

    cleanups.push(() => server.kill('SIGKILL'));

    const url = `mysql://bench@127.0.0.1:${port}/bench`;

    for (let tries = 0; ; tries++) {
        try {
            await (await createConnection({ uri: url })).end();
            break;
        } catch (error) {
            if (tries > 120) {
                throw error;
            }

            await sleep(500);
        }
    }

    return { url, pid: /** @type {number} */ (server.pid) };
}

/**
 * Starts Redis for BullMQ: a private port, data in the temporary directory, the append-only file synced every second
 * (its documented durable setting; no snapshots).
 * @param {number} port
 * @returns {Promise<{ url: string, pid: number }>}
 */
async function startRedis(port) {
    const data = join(tmp, `redis-${port}`);

    execFileSync('mkdir', ['-p', data]);

    const server = spawn(join(REDIS_BIN, 'redis-server'), [
        '--port', String(port), '--bind', '127.0.0.1', '--dir', data, '--save', '', '--appendonly', 'yes',
        '--appendfsync', 'everysec', '--protected-mode', 'yes', '--logfile', join(data, 'redis.log'),
    ], { stdio: 'ignore' });

    cleanups.push(() => server.kill('SIGKILL'));

    for (let tries = 0; ; tries++) {
        try {
            execFileSync(join(REDIS_BIN, 'redis-cli'), ['-p', String(port), 'PING'], { stdio: 'ignore' });
            break;
        } catch (error) {
            if (tries > 60) {
                throw error;
            }

            await sleep(250);
        }
    }

    return { url: `redis://127.0.0.1:${port}`, pid: /** @type {number} */ (server.pid) };
}

/**
 * @param {string} adminUrl
 * @param {string} database
 * @returns {Promise<string>} The URL of a new, empty database of the server.
 */
async function freshDatabase(adminUrl, database) {
    const url = new URL(adminUrl);

    if (adminUrl.startsWith('mysql:')) {
        const connection = await createConnection({ uri: adminUrl });

        await connection.query(`DROP DATABASE IF EXISTS ${database}`);
        await connection.query(`CREATE DATABASE ${database}`);
        await connection.end();
    } else {
        const admin = new Client({ connectionString: adminUrl });

        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${database}`);
        await admin.end();
    }

    url.pathname = `/${database}`;

    return url.toString();
}

/**
 * The statements of a PostgreSQL database since the last reset, and its connections.
 * @param {string} adminUrl
 * @param {string} database
 * @param {{ reset?: boolean, scoped?: boolean }} [options] scoped: reset the statements of this database only.
 * @returns {Promise<{ statements: number, connections: number }>}
 */
async function postgresStats(adminUrl, database, { reset = false, scoped = false } = {}) {
    const admin = new Client({ connectionString: adminUrl });

    await admin.connect();

    const { rows: [stats] } = await admin.query(`
        SELECT (SELECT coalesce(sum(s.calls), 0)::bigint FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid
                 WHERE d.datname = $1) AS statements,
               (SELECT count(*)::integer FROM pg_stat_activity WHERE datname = $1) AS connections
    `, [database]);

    if (reset && scoped) {
        // Only this database's: other runs share the server
        await admin.query(`
            SELECT pg_stat_statements_reset(0, (SELECT oid FROM pg_database WHERE datname = $1), 0)
        `, [database]);
    } else if (reset) {
        await admin.query('SELECT pg_stat_statements_reset()');
    }

    await admin.end();

    return { statements: Number(stats.statements), connections: stats.connections };
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
    const deltas = labels.filter(label => after[label]?.instructions > 0).map(label => ({
        instructions: after[label].instructions - (before[label] ?? zero).instructions,
        cycles: after[label].cycles - (before[label] ?? zero).cycles,
        cpuSeconds: after[label].cpuSeconds - (before[label] ?? zero).cpuSeconds,
    }));

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
    const backend = role === 'db' && after.db.byCommand.backend;

    if (backend) {
        const [instructions, cycles, cpuSeconds] = backend;
        const [instructionsBefore, cyclesBefore, cpuBefore] = before.db.byCommand.backend ?? [0, 0, 0];

        return {
            instructions: instructions - instructionsBefore,
            cycles: cycles - cyclesBefore,
            cpuSeconds: cpuSeconds - cpuBefore,
        };
    }

    return {
        instructions: after[role].instructions - before[role].instructions,
        cycles: after[role].cycles - before[role].cycles,
        cpuSeconds: after[role].cpuSeconds - before[role].cpuSeconds,
    };
}

/**
 * @typedef {{ url: string, pid: number, business?: { url: string, pid: number } }} Server A database server. Redis:
 *     its PostgreSQL for the business table in `business`.
 */

/**
 * One workload of one library: prepareWorkload(), measure(), finishWorkload().
 * @param {Parameters<typeof prepareWorkload>[0]} workload cron: the schedules' cron; start: the schedule runs start
 *     their windows together.
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
 *     processes?: number, cron?: string, start?: Barrier, phase?: string, warmupS?: number, measureS?: number }} args
 *     phase: a suffix of its database; warmupS, measureS: of the steady and idle windows.
 * @returns {Promise<Record<string, any>>} What measure() takes.
 */
async function prepareWorkload({
    library, workload, names, server, dialect, schedules = 0, processes = 1, cron: spec, start: barrier, phase = '',
    warmupS = WARMUP_S, measureS = MEASURE_S,
}) {
    const cron = workload.startsWith('cron-');
    // A name, and an output directory, per database server too: a stale `ready` would start a window early
    const size = cron ? `${schedules}x${processes}${spec === YEARLY_CRON ? '_yearly' : ''}` : names;
    const database = `perf_${library}_${dialect ?? 'postgres'}_${workload}_${size}${phase}`.replaceAll(/[-:]/gu, '_');
    // Redis: the queue there, the business table in PostgreSQL
    const sql = server.business ?? server;
    const businessUrl = await freshDatabase(sql.url, database);

    if (server.business) {
        execFileSync(join(REDIS_BIN, 'redis-cli'), ['-u', server.url, 'FLUSHALL'], { stdio: 'ignore' });
    }

    const url = server.business ? server.url : businessUrl;
    const out = join(tmp, database);
    const backlog = workload === 'drain' ? BACKLOG : 0;
    const common = [
        join(HERE, 'perf.mjs'), '--library', library, '--url', url, '--business-url', businessUrl,
        '--names', String(names), '--out', tmp,
        '--warmup', String(warmupS), '--measure', String(measureS), '--rate', String(RATE), '--backlog', String(backlog),
        ...dialect ? ['--dialect', dialect] : [],
        ...cron ? ['--schedules', String(schedules), '--cron', String(spec)] : [],
    ].map(arg => (arg === tmp ? out : arg));

    execFileSync('mkdir', ['-p', out]);

    if (await exited(start(process.execPath, [...common, '--role', 'setup'], { log: join(out, 'setup.log') })) !== 0) {
        throw new Error(`${database}: setup failed: ${readFileSync(join(out, 'setup.log'), 'utf8').slice(-2000)}`);
    }

    return {
        library, workload, names, dialect, url, out, common, db: `${sql.pid}+`, server, database, schedules, processes,
        spec, barrier, warmupS, measureS,
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
    const sql = server.business ?? server;

    if (!sql.url.startsWith('mysql:')) {
        // No autovacuum of its tables in the next runs
        await adminQuery(sql.url, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
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
 * @param {Record<string, any>} run
 * @returns {Promise<Record<string, any>>}
 */
async function measureWorkload({
    library, workload, names, dialect, out, common, db, server, database, barrier, warmupS, measureS,
}) {
    const sql = server.business ?? server;
    // pg_stat_statements: PostgreSQL only, and not the queue of a library on Redis
    const statements = !server.business && !sql.url.startsWith('mysql:');
    // The database of a library on Redis: Redis and the PostgreSQL of the business table
    const servers = { db, ...server.business && { redis: String(server.pid) } };
    /**
     * @param {Record<string, any>} before
     * @param {Record<string, any>} after
     * @returns {{ instructions: number, cycles: number, cpuSeconds: number }}
     */
    const dbDelta = (before, after) => {
        const relational = delta(before, after, 'db');
        const redis = server.business ? delta(before, after, 'redis') : { instructions: 0, cycles: 0, cpuSeconds: 0 };

        return {
            instructions: relational.instructions + redis.instructions,
            cycles: relational.cycles + redis.cycles,
            cpuSeconds: relational.cpuSeconds + redis.cpuSeconds,
        };
    };

    if (!sql.url.startsWith('mysql:')) {
        await adminQuery(sql.url, 'CHECKPOINT');
    }

    if (workload === 'drain') {
        // The drains of a phase start together
        await barrier?.arrive();

        const before = await countersAsync(servers);
        const worker = start(process.execPath, [...common, '--role', 'worker'], { log: join(out, 'worker.log') });

        const limit = Date.now() + (DRAIN_LIMIT_S * 1000);

        // The worker writes worker.json when the backlog is done, then lingers
        while (!readJson(join(out, 'worker.json')) && worker.exitCode === null && Date.now() < limit) {
            await sleep(100);
        }

        const after = await countersAsync({ ...servers, worker: String(worker.pid) });

        if (!readJson(join(out, 'worker.json'))) {
            // Too long: it writes what ran, and exits
            worker.kill('SIGUSR2');
            await exited(worker);
        }

        const result = readJson(join(out, 'worker.json'));

        await exited(worker);

        return {
            library, workload, names, dialect: dialect ?? 'postgres', ...result,
            worker: after.worker, db: dbDelta(before, after),
        };
    }

    const worker = start(process.execPath, [...common, '--role', 'worker'], { log: join(out, 'worker.log') });

    await untilFile(join(out, 'ready'), worker);
    // The windows of a phase start together
    await barrier?.arrive();

    const producer = workload === 'steady'
        ? start(process.execPath, [...common, '--role', 'producer'], { log: join(out, 'producer.log') })
        : null;
    const pids = { ...servers, worker: String(worker.pid), ...producer && { producer: String(producer.pid) } };

    await sleep(warmupS * 1000);

    // Without blocking the other lanes; the window is the time between the two readings
    const before = await countersAsync(pids);
    const startedAt = Date.now();

    if (statements) {
        await postgresStats(sql.url, database, { reset: true });
    }

    await sleep((measureS * 1000) - (Date.now() - startedAt));

    const after = await countersAsync(pids);
    const seconds = (Date.now() - startedAt) / 1000;
    const stats = statements ? await postgresStats(sql.url, database) : null;

    await Promise.all([exited(worker), producer && exited(producer)]);

    const result = readJson(join(out, 'worker.json'));

    return {
        library, workload, names, dialect: dialect ?? 'postgres', seconds,
        ...result,
        // Steady: the worker ran the jobs of its window, 95% at least; else its cost per job is not a cost per job
        ...workload === 'steady' && { keptUp: (result?.completed ?? 0) >= 0.95 * RATE * measureS },
        ...stats,
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
 * together. cron-idle: a window of CRON_IDLE_S. cron-fire: the first slot comes CRON_WARMUP_S or more after the start;
 * the CPU window is one period, from 30 s after the first slot to 30 s after the second; the jobs of both slots get
 * CRON_LATE_S after the second to start. Each worker notes the scheduled jobs that it started; after they stop, the
 * library's tables give the jobs that it stored.
 * @param {Record<string, any>} run
 * @returns {Promise<Record<string, any>>}
 */
async function measureSchedules({
    library, workload, names, dialect, url, out, common, server, database, schedules, processes, spec, barrier,
}) {
    // PostgreSQL: a server per library, so the backends of the run's database; Redis, MySQL: a server per run
    const shared = !server.business && !server.url.startsWith('mysql:');
    /** @returns {Promise<Record<string, string>>} The processes of the database. */
    const databasePids = async () => (shared ? backends(server.url, database) : { db: String(server.pid) });
    const workers = Array.from({ length: processes }, (_, index) => start(process.execPath, [
        ...common, '--role', 'worker', '--index', String(index),
    ], { log: join(out, `worker-${index}.log`) }));

    for (const [index, worker] of workers.entries()) {
        await untilFile(join(out, `ready-${index}`), worker);
    }

    const ready = await barrier.arrive();
    // The database: the backends of its connections, since the libraries' runs share a server
    const pids = Object.fromEntries(workers.map((worker, index) => [`worker${index}`, String(worker.pid)]));
    const fire = workload === 'cron-fire';
    const firstSlot = Math.ceil((ready + (CRON_WARMUP_S * 1000)) / MINUTE_MS) * MINUTE_MS;
    const windowStart = fire ? firstSlot + 30_000 : ready + (CRON_WARMUP_S * 1000);
    const seconds = fire ? CRON_FIRE_S : CRON_IDLE_S;
    const windowEnd = windowStart + (seconds * 1000);

    await sleepUntil(windowStart);

    const before = await countersAsync({ ...pids, ...await databasePids() });

    if (shared) {
        await postgresStats(server.url, database, { reset: true, scoped: true });
    }

    await sleepUntil(windowEnd);

    const ended = await databasePids();
    const after = await countersAsync({ ...pids, ...ended });
    // Statements and connections: PostgreSQL only
    const stats = shared ? await postgresStats(server.url, database) : {};
    const slots = [firstSlot, firstSlot + MINUTE_MS];

    if (fire) {
        await sleepUntil(slots[1] + (CRON_LATE_S * 1000));
    }

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
    const stored = fire && adapter.scheduledJobs ? await adapter.scheduledJobs(url) : null;

    return {
        library, workload, names, dialect: dialect ?? 'postgres', schedules, processes, cron: spec, seconds, ...stats,
        ...stored && slotCounts({
            scheduled: reports.flatMap(report => report.scheduled), stored, schedules, slots, windowStart, windowEnd,
        }),
        worker, db: shared ? backendDelta(before, after, Object.keys(ended)) : delta(before, after, 'db'),
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
 * @param {Record<string, any>[]} runs
 * @returns {string}
 */
function tables(runs) {
    const lines = [];

    lines.push('Steady load: 20 jobs/s over 1000 job names, each with an INSERT in a transaction. Per job; (timing): phase B.\n');
    lines.push('| Library | Database | Jobs | Instructions (M), worker / producer / db = total | CPU ms | Latency p50 / p99 ms |');
    lines.push('| --- | --- | --- | --- | --- | --- |');

    for (const row of runs.filter(entry => entry.workload === 'steady')) {
        const roles = ['worker', 'producer', 'db'];
        const instructions = roles.map(role => perJob(row, role));
        const cpu = sum(roles.map(role => row[role]?.cpuSeconds ?? 0)) / row.completed * 1000;
        const total = millions(sum(instructions));
        const library = `${row.library}${row.transactional === false ? ' (enqueue after commit, not atomic)' : ''}${row.timing ? ' (timing)' : ''}`;
        // Behind the load: its cost per job that ran is not a cost per job
        const cost = row.keptUp === false ? `— (${row.completed} of ${Math.round(RATE * row.seconds)} ran)` : `${instructions.map(millions).join(' / ')} = **${total}**`;

        lines.push(`| ${library} | ${row.dialect} | ${row.completed} | ${cost} | ${cpu.toFixed(1)} | ${row.latencyP50Ms} / ${row.latencyP99Ms} |`);
    }

    lines.push('\nIdle: no jobs. Per second of the window.\n');
    lines.push('| Library | Database | Job names | Database instructions (M) | Worker instructions (M) | SQL statements | Connections |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');

    for (const row of runs.filter(entry => entry.workload === 'idle')) {
        // Statements and connections: PostgreSQL only
        const statements = row.statements === undefined ? '—' : (row.statements / row.seconds).toFixed(1);

        lines.push(`| ${row.library} | ${row.dialect} | ${row.names} | ${millions(row.db.instructions / row.seconds)} | ${millions(row.worker.instructions / row.seconds)} | ${statements} | ${row.connections ?? '—'} |`);
    }

    lines.push(`\nDrain: ${BACKLOG} due jobs over 1000 job names.\n`);
    lines.push('| Library | Database | Time s | Instructions per job (M), worker / db = total |');
    lines.push('| --- | --- | --- | --- |');

    for (const row of runs.filter(entry => entry.workload === 'drain')) {
        const worker = row.worker.instructions / row.completed;
        const db = row.db.instructions / row.completed;

        const time = row.drainMs === null ? `> ${DRAIN_LIMIT_S} (${row.completed} ran)` : (row.drainMs / 1000).toFixed(1);

        lines.push(`| ${row.library}${row.timing ? ' (timing)' : ''} | ${row.dialect} | ${time} | ${millions(worker)} / ${millions(db)} = **${millions(worker + db)}** |`);
    }

    lines.push(`\nSchedules, idle: no slot due, 1 job name, 1 worker. Per second; median of ${CRON_REPEATS} runs.\n`);
    lines.push('| Library | Database | Schedules | Cron | Database instructions (M) | Worker instructions (M) | SQL statements | Connections |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');

    for (const row of runs.filter(entry => entry.workload === 'cron-idle')) {
        // Statements and connections: PostgreSQL only
        const statements = row.statements === undefined ? '—' : (row.statements / row.seconds).toFixed(1);

        lines.push(`| ${row.library} | ${row.dialect} | ${row.schedules} | \`${row.cron}\` | ${millions(row.db.instructions / row.seconds)} | ${millions(row.worker.instructions / row.seconds)} | ${statements} | ${row.connections ?? '—'} |`);
    }

    lines.push(`\nSchedules, firing: ${SCHEDULES} schedules of \`${FIRE_CRON}\`. CPU per due slot over one minute (range of the runs); jobs and lag of 2 slots. Median of ${CRON_REPEATS} runs.\n`);
    lines.push('| Library | Database | Processes | Instructions per slot (M), median workers / median db = their sum (range of the totals) | Statements | Started per minute | Decided / started / expected | Duplicates | Lag p50 / p99 ms |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

    for (const row of runs.filter(entry => entry.workload === 'cron-fire')) {
        // The slots due in the CPU window: the schedules fire once a minute
        const slots = row.schedules * row.seconds / 60;
        const worker = row.worker.instructions / slots;
        const db = row.db.instructions / slots;
        const totals = (row.samples ?? []).map((/** @type {any} */ sample) => (sample.worker + sample.db) / slots);
        const range = totals.length ? ` (${millions(Math.min(...totals))}–${millions(Math.max(...totals))})` : '';

        const statements = row.statements === undefined ? '—' : (row.statements / slots).toFixed(2);

        lines.push(`| ${row.library}${row.transactional === false ? ' (not transactional)' : ''} | ${row.dialect} | ${row.processes} | ${millions(worker)} / ${millions(db)} = **${millions(worker + db)}**${range} | ${statements} | ${row.startedInWindow}${row.forwardedInWindow === undefined ? '' : ` (forwarded ${row.forwardedInWindow})`} | ${row.decided} / ${row.started} / ${row.expected} | ${row.duplicates} | ${row.lagP50Ms} / ${row.lagP99Ms} |`);
    }

    return lines.join('\n');
}

/**
 * The performance of jobs: a lane per library and database that its adapter lists, each with a server of its own.
 * Phase A, for instructions: the lanes in parallel, one workload at a time, the windows started together (steady,
 * idle with 1 and 1000 names, drain); instructions do not depend on the load of the machine (see docs/cpu-cost.md).
 * Phase B, for times, on PostgreSQL and Redis: one lane at a time, the drains, then the steady load, for the drain
 * times, the latencies and the CPU time. Its rows have `timing: true`.
 * @param {string[]} libraries
 * @returns {Promise<Record<string, any>[]>}
 */
async function runJobs(libraries) {
    /** @type {{ library: string, database: 'postgres' | 'mysql' | 'mariadb' | 'redis' }[]} */
    const lanes = [];

    for (const library of libraries) {
        const { adapter } = /** @type {{ adapter: import('./libs/common.mjs').Adapter }} */ (
            await import(`./libs/${library.replaceAll('-', '_')}.mjs`)
        );

        lanes.push(...adapter.databases.map(database => ({ library, database })));
    }

    const template = join(tmp, 'pg-template');

    if (!existsSync(template)) {
        execFileSync(join(PG_BIN, 'initdb'), ['-D', template, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
    }

    /** @type {Server[]} */
    const servers = await Promise.all(lanes.map(async ({ library, database }, index) => {
        if (database === 'postgres') {
            return startPostgres({ port: PERF_PG_PORT + index, template });
        }

        if (database === 'redis') {
            const business = await startPostgres({ port: PERF_PG_PORT + index, template });

            return { ...await startRedis(PERF_REDIS_PORT + index), business };
        }

        return startMysqlFamily(database, { port: PERF_MYSQL_PORT + index, name: `${database}-${library}` });
    }));
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
        process.stderr.write(`jobs, phase A: ${workload} ${names}, ${lanes.length} lanes in parallel\n`);

        const runs = await Promise.all(lanes.map((_, index) => prepare(index, workload, names)));
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

    process.stderr.write(`jobs, phase A: ${Math.round((Date.now() - startedAt) / 1000)} s\n`);
    startedAt = Date.now();

    const timed = lanes.flatMap(({ database }, index) => (database === 'postgres' || database === 'redis' ? [index] : []));
    // The backlogs in parallel, then the drains one at a time
    const drains = await Promise.all(timed.map(index => prepare(index, 'drain', NAMES, '_b')));

    for (const run of drains) {
        process.stderr.write(`jobs, phase B: drain ${run.library} on ${run.dialect ?? 'postgres'}\n`);

        try {
            rows.push({ ...await measure(run), timing: true });
        } finally {
            await finishWorkload(run);
        }
    }

    for (const index of timed) {
        process.stderr.write(`jobs, phase B: steady ${lanes[index].library} on ${lanes[index].database}\n`);

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
 * The schedule runs, all in parallel, each with a database of its own: instructions do not depend on the load of the
 * machine (see docs/cpu-cost.md), and the runs wait for the same minutes. A lane per library and database that its
 * adapter lists, but MariaDB. PostgreSQL: a server per lane, for all its runs (macOS allows few PostgreSQL servers at
 * once: 32 shared memory segments, kern.sysv.shmmni). Redis and MySQL: a server per run; on MySQL, the runs that fire
 * only. CRON_REPEATS times; a row has the median of each number, and each run in `samples`.
 * @param {string[]} libraries
 * @returns {Promise<Record<string, any>[]>}
 */
async function runSchedules(libraries) {
    // Idle: a daily cron 12 hours away, which never fires in the window; and a yearly one
    const daily = `0 ${(new Date().getUTCHours() + 12) % 24} * * *`;
    const idle = [
        { workload: 'cron-idle', names: 1, schedules: 1, cron: daily },
        { workload: 'cron-idle', names: 1, schedules: SCHEDULES, cron: daily },
        { workload: 'cron-idle', names: 1, schedules: SCHEDULES, cron: YEARLY_CRON },
    ];
    const firing = [
        { workload: 'cron-fire', names: 1, schedules: SCHEDULES, processes: 1, cron: FIRE_CRON },
        { workload: 'cron-fire', names: 1, schedules: SCHEDULES, processes: 3, cron: FIRE_CRON },
    ];
    /** @type {{ library: string, database: 'postgres' | 'mysql' | 'mariadb' | 'redis' }[]} */
    const lanes = [];

    for (const library of libraries) {
        const { adapter } = /** @type {{ adapter: import('./libs/common.mjs').Adapter }} */ (
            await import(`./libs/${library.replaceAll('-', '_')}.mjs`)
        );

        const databases = adapter.databases.filter(database => database !== 'mariadb');

        lanes.push(...databases.map(database => ({ library, database })));
    }

    const template = join(tmp, 'pg-template');

    if (!existsSync(template)) {
        execFileSync(join(PG_BIN, 'initdb'), ['-D', template, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
    }

    const postgresLanes = lanes.filter(lane => lane.database === 'postgres');
    const postgres = await Promise.all(postgresLanes.map((_, index) => (
        startPostgres({ port: CRON_PORT + index, template })
    )));
    const business = lanes.some(lane => lane.database === 'redis')
        ? await startPostgres({ port: CRON_PORT + postgresLanes.length, template })
        : null;
    const steps = lanes.flatMap(lane => (lane.database === 'mysql' ? firing : [...idle, ...firing]).map(step => ({
        lane, step,
    })));
    /** @type {Server[]} */
    const servers = await Promise.all(steps.map(async ({ lane: { library, database } }, index) => {
        if (database === 'postgres') {
            return postgres[postgresLanes.findIndex(lane => lane.library === library)];
        }

        if (database === 'redis') {
            return { ...await startRedis(CRON_REDIS_PORT + index), business: /** @type {Server} */ (business) };
        }

        return startMysqlFamily('mysql', { port: CRON_MYSQL_PORT + index, name: `mysql-${library}-${index}` });
    }));
    /** @type {Record<string, any>[][]} the runs of each step */
    const samples = steps.map(() => []);

    for (let repeat = 1; repeat <= CRON_REPEATS; repeat++) {
        const barrier = barrierOf(steps.length);

        process.stderr.write(`schedules ${repeat}/${CRON_REPEATS}: ${steps.length} runs in parallel\n`);

        const settled = await Promise.allSettled(steps.map(async ({ lane: { library, database }, step }, index) => {
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

        for (const [index, result] of settled.entries()) {
            samples[index].push(result.status === 'fulfilled' ? result.value : {});
        }
    }

    return samples.map(medianRow);
}

/** The numbers of a schedule row that its median takes */
const MEDIAN_FIELDS = [
    'statements', 'connections', 'decided', 'started', 'startedInWindow', 'forwardedInWindow', 'lagP50Ms', 'lagP99Ms',
    'lagMaxMs',
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

try {
    // The checks have a server; the jobs and the schedules start servers of their own
    const postgres = PARTS.has('checks') ? await startPostgres() : null;
    // A run of one part keeps the other parts' results. The date of each part, and of the last run
    const saved = readJson(join(HERE, 'results.json')) ?? {};
    const date = new Date().toISOString();
    /** @type {Record<string, any>} */
    const results = {
        ...saved,
        date,
        node: process.version,
        dates: { ...saved.dates, ...Object.fromEntries([...PARTS].map(part => [part, date])) },
    };
    const libraries = LIBRARIES;

    if (PARTS.has('checks')) {
        const log = join(tmp, 'checks.log');

        process.stderr.write(`checks (log: ${log})\n`);
        const { url } = /** @type {{ url: string }} */ (postgres);

        await exited(start(process.execPath, [join(HERE, 'checks.mjs'), url], { log }));
        results.checks = readJson(join(HERE, 'checks.json'));
        console.log(readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('|')).join('\n'));
    }

    if (PARTS.has('perf')) {
        const runs = await runJobs(libraries);

        // A run of some libraries replaces their rows only
        /** @type {Record<string, any>[]} */
        const previous = results.perf ?? [];
        const kept = previous.filter(row => row.workload.startsWith('cron-') || !libraries.includes(row.library));

        results.perf = [...kept, ...runs];
    }

    if (PARTS.has('cron')) {
        const runs = await runSchedules(libraries.filter(library => CRON_LIBRARIES.has(library)));
        /** @type {Record<string, any>[]} */
        const previous = results.perf ?? [];
        const kept = previous.filter(row => (
            !row.workload.startsWith('cron-') || !libraries.includes(row.library)
        ));

        results.perf = [...kept, ...runs];
    }

    if (results.perf) {
        console.log(`\n${tables(results.perf)}`);
    }

    writeFileSync(join(HERE, 'results.json'), `${JSON.stringify(results, null, 4)}\n`);
} finally {
    for (const cleanup of cleanups.toReversed()) {
        try {
            cleanup();
        } catch {
            // Already stopped
        }
    }

    rmSync(tmp, { recursive: true, force: true });
}
