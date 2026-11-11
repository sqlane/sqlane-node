// The comparison of docs/comparison.md and docs/comparison-performance.md: the feature checks, then the performance
// workloads, on database servers of this host (macOS, Homebrew). About 13 minutes.
//
//   pnpm bench:compare                    # all
//   pnpm bench:compare --only checks      # or: perf
//   pnpm bench:compare --only perf --libs sqlane,river
//
// Options: --pg-bin, --mysql-bin, --mariadb-bin (the directories of the server binaries). Writes results.json next to
// this file and prints Markdown tables. See README.md.
/* oxlint-disable no-await-in-loop -- the runs go one after the other: they share the machine */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createConnection } from 'mysql2/promise';
import { Client } from 'pg';

const HERE = import.meta.dirname;
const PROC_USAGE = join(HERE, '../cpu/proc_usage.py');
const { values: args } = parseArgs({
    options: {
        'only': { type: 'string' },
        'libs': { type: 'string' },
        'pg-bin': { type: 'string', default: '/opt/homebrew/opt/postgresql@17/bin' },
        'mysql-bin': { type: 'string', default: '/opt/homebrew/opt/mysql@8.4/bin' },
        'mariadb-bin': { type: 'string', default: '/opt/homebrew/opt/mariadb@11.8/bin' },
    },
});
const PG_BIN = args['pg-bin'];
const MYSQL_BIN = args['mysql-bin'];
const MARIADB_BIN = args['mariadb-bin'];
/** The libraries that enqueue in the caller's transaction: the others are not compared on performance */
const PERF_LIBRARIES = ['sqlane', 'pg-boss', 'graphile-worker', 'river'];
const WARMUP_S = 5;
const MEASURE_S = 15;
const NAMES = 1000;
const RATE = 20;
const BACKLOG = 10_000;
const tmp = mkdtempSync(join(tmpdir(), 'sqlane-compare-'));
/** @type {(() => void)[]} */
const cleanups = [];

/**
 * @param {string} command
 * @param {string[]} commandArgs
 * @param {{ log?: string }} [options] log: the output goes to this file.
 * @returns {import('node:child_process').ChildProcess}
 */
function start(command, commandArgs, { log } = {}) {
    const child = spawn(command, commandArgs, { stdio: log ? ['ignore', 'pipe', 'pipe'] : 'inherit' });

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
 * @param {Record<string, string>} processes label: pid, with `+` for the process and its descendants
 * @returns {Record<string, { instructions: number, cycles: number, cpuSeconds: number }>}
 */
function counters(processes) {
    return JSON.parse(execFileSync('python3', [PROC_USAGE, ...Object.entries(processes).map(([label, pid]) => `${label}=${pid}`)], {
        encoding: 'utf8',
    }));
}

/**
 * Starts PostgreSQL with pg_stat_statements.
 * @returns {Promise<{ url: string, pid: number }>}
 */
async function startPostgres() {
    const data = join(tmp, 'pg');

    execFileSync(join(PG_BIN, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
    execFileSync(join(PG_BIN, 'pg_ctl'), ['-D', data, '-l', join(tmp, 'pg.log'), '-w', 'start', '-o', [
        '-p 55442 -c listen_addresses=127.0.0.1 -c unix_socket_directories=\'\' -c max_connections=500',
        '-c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=top',
    ].join(' ')], { stdio: 'ignore' });
    cleanups.push(() => execFileSync(join(PG_BIN, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' }));

    const url = 'postgresql://postgres@127.0.0.1:55442/postgres';
    const admin = new Client({ connectionString: url });

    await admin.connect();
    await admin.query('CREATE EXTENSION pg_stat_statements');
    await admin.end();

    return { url, pid: Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]) };
}

/**
 * Starts MySQL or MariaDB, as bench/cpu/measure.sh: default configuration; MariaDB with the binary log of MySQL 8.4.
 * @param {'mysql' | 'mariadb'} dialect
 * @returns {Promise<{ url: string, pid: number }>}
 */
async function startMysqlFamily(dialect) {
    const data = join(tmp, dialect);
    const port = dialect === 'mysql' ? 53_317 : 53_318;
    const initFile = join(tmp, 'init.sql');

    writeFileSync(initFile, `CREATE DATABASE IF NOT EXISTS bench;
CREATE USER IF NOT EXISTS 'bench'@'127.0.0.1';
GRANT ALL ON *.* TO 'bench'@'127.0.0.1';
`);

    if (dialect === 'mysql') {
        execFileSync(join(MYSQL_BIN, 'mysqld'), ['--no-defaults', '--initialize-insecure', `--datadir=${data}`], { stdio: 'ignore' });
    } else {
        execFileSync(join(MARIADB_BIN, 'mariadb-install-db'), ['--no-defaults', `--datadir=${data}`, '--skip-test-db'], {
            stdio: 'ignore',
        });
    }

    const server = spawn(dialect === 'mysql' ? join(MYSQL_BIN, 'mysqld') : join(MARIADB_BIN, 'mariadbd'), [
        '--no-defaults', `--datadir=${data}`, `--port=${port}`, '--bind-address=127.0.0.1', `--socket=${dialect}.sock`,
        `--log-error=${join(tmp, `${dialect}.err`)}`, `--init-file=${initFile}`,
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
 * @param {{ reset?: boolean }} [options]
 * @returns {Promise<{ statements: number, connections: number }>}
 */
async function postgresStats(adminUrl, database, { reset = false } = {}) {
    const admin = new Client({ connectionString: adminUrl });

    await admin.connect();

    const { rows: [stats] } = await admin.query(`
        SELECT (SELECT coalesce(sum(s.calls), 0)::bigint FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid
                 WHERE d.datname = $1) AS statements,
               (SELECT count(*)::integer FROM pg_stat_activity WHERE datname = $1) AS connections
    `, [database]);

    if (reset) {
        await admin.query('SELECT pg_stat_statements_reset()');
    }

    await admin.end();

    return { statements: Number(stats.statements), connections: stats.connections };
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
 * One workload of one library.
 * @param {{ library: string, workload: 'steady' | 'idle' | 'drain', names: number,
 *     server: { url: string, pid: number }, dialect?: string }} run
 * @returns {Promise<Record<string, any>>}
 */
async function runWorkload({ library, workload, names, server, dialect }) {
    // A name, and an output directory, per database server too: a stale `ready` would start a window early
    const database = `perf_${library.replaceAll('-', '_')}_${dialect ?? 'postgres'}_${workload}_${names}`;
    const url = await freshDatabase(server.url, database);
    const out = join(tmp, database);
    const backlog = workload === 'drain' ? BACKLOG : 0;
    const common = [
        join(HERE, 'perf.mjs'), '--library', library, '--url', url, '--names', String(names), '--out', tmp,
        '--warmup', String(WARMUP_S), '--measure', String(MEASURE_S), '--rate', String(RATE), '--backlog', String(backlog),
        ...dialect ? ['--dialect', dialect] : [],
    ].map(arg => (arg === tmp ? out : arg));
    const postgres = !server.url.startsWith('mysql:');

    execFileSync('mkdir', ['-p', out]);

    if (await exited(start(process.execPath, [...common, '--role', 'setup'], { log: join(out, 'setup.log') })) !== 0) {
        throw new Error(`${database}: setup failed, see ${out}/setup.log`);
    }

    const db = `${server.pid}+`;

    try {
        return await measureWorkload({ library, workload, names, dialect, url, out, common, db, server, database });
    } finally {
        if (postgres) {
            // No autovacuum of its tables in the next runs
            await adminQuery(server.url, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        }
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
async function measureWorkload({ library, workload, names, dialect, out, common, db, server, database }) {
    const postgres = !server.url.startsWith('mysql:');

    if (postgres) {
        await adminQuery(server.url, 'CHECKPOINT');
    }

    if (workload === 'drain') {
        const before = counters({ db });
        const worker = start(process.execPath, [...common, '--role', 'worker'], { log: join(out, 'worker.log') });

        // The worker writes worker.json when the backlog is done, then lingers
        while (!readJson(join(out, 'worker.json')) && worker.exitCode === null) {
            await sleep(100);
        }

        const after = counters({ db, worker: String(worker.pid) });
        const result = readJson(join(out, 'worker.json'));

        await exited(worker);

        return {
            library, workload, names, dialect: dialect ?? 'postgres', ...result,
            worker: after.worker, db: delta(before, after, 'db'),
        };
    }

    const worker = start(process.execPath, [...common, '--role', 'worker'], { log: join(out, 'worker.log') });

    await untilFile(join(out, 'ready'), worker);

    const producer = workload === 'steady'
        ? start(process.execPath, [...common, '--role', 'producer'], { log: join(out, 'producer.log') })
        : null;
    const pids = { db, worker: String(worker.pid), ...producer && { producer: String(producer.pid) } };

    await sleep(WARMUP_S * 1000);

    const before = counters(pids);

    if (postgres) {
        await postgresStats(server.url, database, { reset: true });
    }

    await sleep(MEASURE_S * 1000);

    const after = counters(pids);
    const stats = postgres ? await postgresStats(server.url, database) : null;

    await Promise.all([exited(worker), producer && exited(producer)]);

    return {
        library, workload, names, dialect: dialect ?? 'postgres', seconds: MEASURE_S,
        ...readJson(join(out, 'worker.json')),
        ...stats,
        worker: delta(before, after, 'worker'),
        ...producer && { producer: delta(before, after, 'producer') },
        db: delta(before, after, 'db'),
    };
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

    lines.push('Steady load: 20 jobs/s over 1000 job names, each enqueued in a transaction with an INSERT. Per job.\n');
    lines.push('| Library | Database | Jobs | Instructions (M), worker / producer / db = total | CPU ms | Latency p50 / p99 ms |');
    lines.push('| --- | --- | --- | --- | --- | --- |');

    for (const row of runs.filter(entry => entry.workload === 'steady')) {
        const roles = ['worker', 'producer', 'db'];
        const instructions = roles.map(role => perJob(row, role));
        const cpu = sum(roles.map(role => row[role]?.cpuSeconds ?? 0)) / row.completed * 1000;
        const total = millions(sum(instructions));

        lines.push(`| ${row.library} | ${row.dialect} | ${row.completed} | ${instructions.map(millions).join(' / ')} = **${total}** | ${cpu.toFixed(1)} | ${row.latencyP50Ms} / ${row.latencyP99Ms} |`);
    }

    lines.push('\nIdle: no jobs. Per second of the window.\n');
    lines.push('| Library | Job names | Database instructions (M) | Worker instructions (M) | SQL statements | Connections |');
    lines.push('| --- | --- | --- | --- | --- | --- |');

    for (const row of runs.filter(entry => entry.workload === 'idle')) {
        lines.push(`| ${row.library} | ${row.names} | ${millions(row.db.instructions / row.seconds)} | ${millions(row.worker.instructions / row.seconds)} | ${(row.statements / row.seconds).toFixed(1)} | ${row.connections} |`);
    }

    lines.push(`\nDrain: ${BACKLOG} due jobs over 1000 job names.\n`);
    lines.push('| Library | Time s | Instructions per job (M), worker / db = total |');
    lines.push('| --- | --- | --- |');

    for (const row of runs.filter(entry => entry.workload === 'drain')) {
        const worker = row.worker.instructions / row.completed;
        const db = row.db.instructions / row.completed;

        lines.push(`| ${row.library} | ${(row.drainMs / 1000).toFixed(1)} | ${millions(worker)} / ${millions(db)} = **${millions(worker + db)}** |`);
    }

    return lines.join('\n');
}

try {
    const postgres = await startPostgres();
    /** @type {Record<string, any>} */
    const results = { date: new Date().toISOString(), node: process.version };

    if (args.only !== 'perf') {
        const log = join(tmp, 'checks.log');

        process.stderr.write(`checks (log: ${log})\n`);
        await exited(start(process.execPath, [join(HERE, 'checks.mjs'), postgres.url], { log }));
        results.checks = readJson(join(HERE, 'checks.json'));
        console.log(readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('|')).join('\n'));
    }

    if (args.only !== 'checks') {
        /** @type {Record<string, any>[]} */
        const runs = [];

        const libraries = args.libs ? args.libs.split(',') : PERF_LIBRARIES;

        for (const library of libraries) {
            for (const [workload, names] of /** @type {const} */ ([['steady', NAMES], ['idle', 1], ['idle', NAMES], ['drain', NAMES]])) {
                process.stderr.write(`${library} ${workload} ${names}\n`);
                runs.push(await runWorkload({ library, workload, names, server: postgres }));
            }
        }

        for (const dialect of libraries.includes('sqlane') ? /** @type {const} */ (['mysql', 'mariadb']) : []) {
            process.stderr.write(`sqlane steady on ${dialect}\n`);
            runs.push(await runWorkload({
                library: 'sqlane', workload: 'steady', names: NAMES, server: await startMysqlFamily(dialect), dialect,
            }));
        }

        results.perf = runs;
        console.log(`\n${tables(runs)}`);
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
