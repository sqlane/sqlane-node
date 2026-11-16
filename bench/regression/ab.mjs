// The A/B performance regression check: `pnpm bench:regression [--ref main] [--db postgres|mysql|mariadb]… [--scenario
// <name>]… [--window 15] [--warmup 5] [--out <dir>] [--save <file>]`. Compares the working tree with a git ref on
// PostgreSQL, MySQL and MariaDB of this host (started from their binaries: --pg-bin, --mysql-bin, --mariadb-bin,
// defaults: the PG_BIN, MYSQL_BIN and MARIADB_BIN variables, else Homebrew's), in seven scenarios under steady load.
// Each scenario runs its sqlane processes (app.mjs) on a fresh database, and measures a window: the CPU instructions
// per operation of these processes and of the database server (with its descendants), and the statements per operation
// (the server's statistics, db_stats.mjs). A scenario of a feature that the baseline lacks (`global_rate_limits`
// against a ref without `defineRateLimit`) is skipped: n/a, not a failure.
//
// `--ref .`: the baseline is the working tree itself, without git (a copy with no .git, as on the Linux machine of the
// published numbers: `bench/run_linux.sh regression --ref . --save bench/regression/results.json`). Every verdict
// should then be "same"; the run gives the numbers of the tree. `--save <file>`: after the run, writes the numbers of
// the working tree per scenario and database (with the baseline's and the verdict), the machine, whether the counters
// count the kernel, and the servers' versions, as JSON. The raw runs go to `results.json` of `--out` either way.
//
// A difference beyond ±5% in instructions, or ±3% in statements, reruns the pair in the other order; only a difference
// of both runs, in the same direction, counts. Exit code 1: a confirmed regression (more instructions or statements);
// 2: a run failed. The baseline and the working tree run on the same server instance; the databases run in parallel,
// one lane each, their scenarios one after the other. About 7 minutes with the defaults, more with reruns.
//
// Four more scenarios run only when named with --scenario (`--seed <n>`: another trace): `contention` and
// `contention_stress` replay a trace of jobs with concurrency and rate limits (trace.mjs: a realistic profile, and a
// stress one) on 2 workers of 10 slots, and `contention_plain` and `contention_stress_plain` the same traces without
// limits. Per completed job, as `run`; besides, the latency from the enqueue to the first start (p50, p95, p99), the
// share of the jobs that waited on a full key, and the guard: a key that ran more jobs at once than its max, or
// started more jobs in a period than its rate allows, fails the run. Their warm-up is 30 s and their window 60 s,
// unless --warmup and --window are given; the penalty of the limits is the ratio of each pair.
//
// Timing: a warm-up of 5 s, then a window of 15 s. The worker scenarios align their window with the poll of the
// worker (every 5 s from its start): from the middle of one interval to the middle of another, so that it holds whole
// polls. `schedule` aligns it with the slots of its schedules (every 10 s of the clock): from 5 s after one (the 2nd
// slot since the start, or later) to 5 s after another, 20 s = 2 slots. The producers pause at the edges of the
// window, so that no operation straddles them.
/* oxlint-disable no-await-in-loop -- the runs of a lane go one after the other: they share the server */
import { execFileSync, fork } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createConnection } from 'mysql2/promise';
import { Client } from 'pg';
import { countersAsync, countsKernel, difference, startCounters, stopCounters } from '../lib/counters.mjs';
import { statsServer } from '../lib/db_stats.mjs';
import { startServer } from '../lib/servers.mjs';
import { blockedJobs, guard, repeatedRuns, runsByKey } from './contention.mjs';
import { generateTrace, percentilesOf, TRACE_SEED } from './trace.mjs';

const HERE = import.meta.dirname;
const ROOT = resolvePath(HERE, '../..');
const APP = join(HERE, 'app.mjs');
// oxlint-disable-next-line node/no-process-env -- the server binaries
const { PG_BIN, MYSQL_BIN, MARIADB_BIN } = process.env;
const DIALECTS = /** @type {const} */ (['postgres', 'mysql', 'mariadb']);
const { values: args } = parseArgs({
    options: {
        'ref': { type: 'string', default: 'main' },
        'db': { type: 'string', multiple: true },
        'scenario': { type: 'string', multiple: true },
        // Default: 15 and 5, 60 and 30 for the contention scenarios
        'window': { type: 'string' },
        'warmup': { type: 'string' },
        'seed': { type: 'string', default: String(TRACE_SEED) },
        'out': { type: 'string' },
        'save': { type: 'string' },
        'pg-bin': { type: 'string', default: PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin' },
        'mysql-bin': { type: 'string', default: MYSQL_BIN ?? '/opt/homebrew/opt/mysql@8.4/bin' },
        'mariadb-bin': { type: 'string', default: MARIADB_BIN ?? '/opt/homebrew/opt/mariadb@11.8/bin' },
    },
});

/** The thresholds of a possible regression: the relative difference per operation */
const THRESHOLDS = { instructions: 0.05, statements: 0.03 };
/** The poll interval of the workers: sqlane's default */
const POLL_MS = 5000;
/** The interval of the schedules of `schedule` */
const SLOT_MS = 10_000;
const NAMES = 1000;
const WINDOW_MS = Number(args.window ?? 15) * 1000;
const WARMUP_MS = Number(args.warmup ?? 5) * 1000;
const SEED = Number(args.seed);
/** The length of a trace after the warm-up and the window: the processes start, and the producer pauses */
const TRACE_MARGIN_S = 30;

/**
 * @typedef {object} Scenario
 * @property {string} name
 * @property {string} unit What one operation is.
 * @property {string} op The same, short (`--save`).
 * @property {{ role: 'producer' | 'worker' | 'scheduler', label?: string, args?: string[] }[]} processes Started in
 *     this order. `label`: the name of its counters and its log, if not its role.
 * @property {'ops' | 'completed' | 'fired' | 'seconds'} per The operations: the producer's calls, the worker's
 *     completed jobs, the scheduler's fired slots, or the seconds of the window.
 * @property {'none' | 'poll' | 'slot'} align
 * @property {string} [requires] The export of sqlane that the scenario needs: without it in the baseline (a version
 *     before it), the scenario is skipped, n/a.
 * @property {{ profile: 'realistic' | 'stress', limits: boolean }} [trace] A contention scenario: the trace it replays,
 *     with the limits of its profile or without. Only with --scenario.
 * @property {number} [warmupS] Its warm-up, unless --warmup.
 * @property {number} [windowS] Its window, unless --window.
 * @property {{ instructions: number, statements: number }} [thresholds] Its thresholds, if not THRESHOLDS.
 */

/**
 * The processes of a contention scenario: 2 workers of 10 slots, and the producer.
 * @param {'realistic' | 'stress'} profile
 * @param {boolean} limits
 * @returns {Scenario['processes']}
 */
function traceProcesses(profile, limits) {
    const common = ['--trace', profile, '--workers', '2', ...limits ? ['--trace-limits'] : []];
    const worker = ['--cap', '10', '--pool', '12'];

    return [
        { role: 'worker', args: [...common, ...worker, '--worker-index', '0'] },
        { role: 'worker', label: 'worker2', args: [...common, ...worker, '--worker-index', '1'] },
        { role: 'producer', args: common },
    ];
}

/** @type {Scenario[]} */
const SCENARIOS = [
    {
        name: 'enqueue',
        unit: 'enqueue, in a transaction of its own (50/s)',
        op: 'enqueue',
        processes: [{ role: 'producer', args: ['--op', 'enqueue', '--rate', '50'] }],
        per: 'ops',
        align: 'none',
    },
    {
        name: 'enqueue_many',
        unit: '`enqueueMany` of 100 jobs (2/s)',
        op: 'call of enqueueMany of 100',
        processes: [{ role: 'producer', args: ['--op', 'enqueue_many', '--rate', '2', '--batch', '100'] }],
        per: 'ops',
        align: 'none',
    },
    {
        name: 'run',
        unit: 'job enqueued, run and completed (20/s, 1000 handled names)',
        op: 'job',
        processes: [{ role: 'worker' }, { role: 'producer', args: ['--op', 'enqueue', '--rate', '20'] }],
        per: 'completed',
        align: 'poll',
    },
    {
        name: 'idle',
        unit: 'second of a worker of 1000 names, no job',
        op: 'second',
        processes: [{ role: 'worker' }],
        per: 'seconds',
        align: 'poll',
    },
    {
        name: 'schedule',
        unit: 'fired slot of 1000 `every: \'10s\'` schedules, no handler',
        op: 'slot',
        processes: [{ role: 'scheduler', args: ['--every', '10s'] }],
        per: 'fired',
        align: 'slot',
    },
    {
        name: 'global_limits',
        unit: 'job with one of 100 keys of a global limit of 1 (20/s)',
        op: 'job',
        processes: [
            { role: 'worker', args: ['--limit-keys', '100'] },
            { role: 'producer', args: ['--op', 'enqueue', '--rate', '20', '--limit-keys', '100'] },
        ],
        per: 'completed',
        align: 'poll',
    },
    {
        // A key takes a job every 5 s, its limit one per second: no job waits for its key. A tighter limit would block
        // a share of the jobs that depends on the timing (one per 5 s: about half), or all of them with a backlog that
        // grows, so the cost per job would differ between runs. This one measures what each job with a rate key pays
        name: 'global_rate_limits',
        unit: 'job with one of 100 keys of a global rate limit of 1/s, none limited (20/s)',
        op: 'job',
        processes: [
            { role: 'worker', args: ['--rate-limit-keys', '100'] },
            { role: 'producer', args: ['--op', 'enqueue', '--rate', '20', '--rate-limit-keys', '100'] },
        ],
        per: 'completed',
        align: 'poll',
        requires: 'defineRateLimit',
    },
    {
        name: 'contention',
        unit: 'job of the realistic trace, with its concurrency and rate limits (140/s, 2 workers of 10 slots)',
        op: 'job',
        processes: traceProcesses('realistic', true),
        per: 'completed',
        align: 'poll',
        requires: 'defineRateLimit',
        trace: { profile: 'realistic', limits: true },
        warmupS: 30,
        windowS: 60,
    },
    {
        name: 'contention_plain',
        unit: 'job of the realistic trace, without limits (140/s, 2 workers of 10 slots)',
        op: 'job',
        processes: traceProcesses('realistic', false),
        per: 'completed',
        align: 'poll',
        trace: { profile: 'realistic', limits: false },
        warmupS: 30,
        windowS: 60,
    },
    {
        name: 'contention_stress',
        unit: 'job of the stress trace, with 2 to 5 concurrency limits of max 1 to 5 each (140/s, 2 workers of 10 slots)',
        op: 'job',
        processes: traceProcesses('stress', true),
        per: 'completed',
        align: 'poll',
        requires: 'defineRateLimit',
        trace: { profile: 'stress', limits: true },
        warmupS: 30,
        windowS: 60,
    },
    {
        name: 'contention_stress_plain',
        unit: 'job of the stress trace, without limits (140/s, 2 workers of 10 slots)',
        op: 'job',
        processes: traceProcesses('stress', false),
        per: 'completed',
        align: 'poll',
        trace: { profile: 'stress', limits: false },
        warmupS: 30,
        windowS: 60,
    },
];

const dialects = args.db ?? DIALECTS;
const scenarios = args.scenario
    ? SCENARIOS.filter(scenario => args.scenario?.includes(scenario.name))
    : SCENARIOS.filter(scenario => !scenario.trace);
const unknown = [
    ...dialects.filter(dialect => !DIALECTS.includes(/** @type {any} */ (dialect))),
    ...(args.scenario ?? []).filter(name => !SCENARIOS.some(scenario => scenario.name === name)),
];

if (unknown.length || !(WINDOW_MS > 0) || !(WARMUP_MS >= 0) || !Number.isInteger(SEED)) {
    throw new Error(`Unknown or invalid: ${unknown.join(', ')
        || `--window ${args.window} --warmup ${args.warmup} --seed ${args.seed}`}`);
}

/**
 * @param {Scenario} scenario
 * @returns {{ warmupMs: number, windowMs: number }} Its warm-up and its window: --warmup and --window, else its own.
 */
function timingOf(scenario) {
    return {
        warmupMs: args.warmup === undefined ? (scenario.warmupS ?? 5) * 1000 : WARMUP_MS,
        windowMs: args.window === undefined ? (scenario.windowS ?? 15) * 1000 : WINDOW_MS,
    };
}

const BINS = { postgres: args['pg-bin'], mysql: args['mysql-bin'], mariadb: args['mariadb-bin'] };
const PORTS = { postgres: 55_470, mysql: 53_470, mariadb: 53_471 };
const HINT_PORTS = { postgres: 41_470, mysql: 41_471, mariadb: 41_472 };
const out = args.out ? resolvePath(args.out) : mkdtempSync(join(tmpdir(), 'sqlane-ab-'));
/** @type {Record<string, string>} The version of each database server, from `SELECT version()` */
const versions = {};
/** @type {(() => void)[]} */
const cleanups = [];

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleepUntil = ms => sleep(Math.max(0, ms - Date.now()));

/**
 * The sources of the ref, with the drivers of this checkout. `.`: the working tree itself.
 * @param {string} ref
 * @returns {{ dir: string, commit: string | null }}
 */
function extract(ref) {
    if (ref === '.') {
        return { dir: ROOT, commit: null };
    }

    const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' })
        .trim();
    const dir = join(out, 'baseline');

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync('sh', ['-c', 'git -C "$1" archive "$2" src package.json | tar -x -C "$3"', 'sh', ROOT, commit, dir]);
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));

    return { dir, commit };
}

/**
 * @typedef {object} Child
 * @property {string} role Its label: its role, unless the scenario gives it another one.
 * @property {import('node:child_process').ChildProcess} process
 * @property {Promise<void>} ready
 * @property {(type: string, timeoutMs?: number) => Promise<Record<string, number>>} request Resolves to its counts.
 * @property {(type: string, timeoutMs?: number) => Promise<any>} message Resolves to its reply.
 * @property {Promise<number | null>} exited
 */

/**
 * Forks app.mjs, its output to a log file.
 * @param {string[]} appArgs
 * @param {string} role
 * @param {string} log
 * @param {string} [label] The name of its counters, if not its role.
 * @returns {Child}
 */
function startApp(appArgs, role, log, label = role) {
    const fd = openSync(log, 'w');
    // --expose-gc: `collect`
    const child = fork(APP, [...appArgs, '--role', role], {
        stdio: ['ignore', fd, fd, 'ipc'],
        execArgv: ['--expose-gc'],
    });

    closeSync(fd);

    /** @type {Map<number, PromiseWithResolvers<any>>} */
    const pending = new Map();
    /** @type {PromiseWithResolvers<void>} */
    const ready = Promise.withResolvers();
    /** @type {Promise<number | null>} */
    const exited = new Promise((resolve) => {
        child.on('exit', (code) => {
            const error = new Error(`${role} exited with ${code}: see ${log}`);

            ready.reject(error);

            for (const request of pending.values()) {
                request.reject(error);
            }

            resolve(code);
        });
    });
    let next = 0;

    // oxlint-disable-next-line promise/prefer-await-to-then -- a rejection without a reader: the process exited first
    ready.promise.catch(() => {});
    // A message to a process that exited: its requests fail on the exit
    child.on('error', () => {});
    child.on('message', (/** @type {any} */ message) => {
        if (message.type === 'ready') {
            ready.resolve();
        } else {
            pending.get(message.id)?.resolve(message);
            pending.delete(message.id);
        }
    });
    cleanups.push(() => child.kill('SIGKILL'));

    return {
        role: label,
        process: child,
        ready: ready.promise,
        exited,
        async request(type, timeoutMs = 30_000) {
            return (await this.message(type, timeoutMs)).counts;
        },
        async message(type, timeoutMs = 30_000) {
            if (child.exitCode !== null || child.signalCode !== null) {
                throw new Error(`${role} exited: see ${log}`);
            }

            const id = next++;
            /** @type {PromiseWithResolvers<any>} */
            const request = Promise.withResolvers();

            pending.set(id, request);
            child.send({ id, type });

            const timer = setTimeout(() => request.reject(new Error(`${role}: no reply to ${type}`)), timeoutMs);

            try {
                return await request.promise;
            } finally {
                clearTimeout(timer);
            }
        },
    };
}

/**
 * @typedef {object} Lane
 * @property {'postgres' | 'mysql' | 'mariadb'} dialect
 * @property {import('../lib/servers.mjs').Server} server
 * @property {import('../lib/db_stats.mjs').StatsServer} stats
 * @property {(sql: string) => Promise<any[]>} admin Its rows.
 * @property {() => Promise<void>} closeAdmin
 * @property {string} dir
 */

/**
 * @typedef {object} Run
 * @property {string} variant
 * @property {number} seconds
 * @property {number} operations
 * @property {Record<string, number>} counts The counts of the processes over the window.
 * @property {Record<string, number>} countsBefore Their counts before it, from their start.
 * @property {Record<string, import('../lib/counters.mjs').Counters>} cpu Per process, and the database.
 * @property {number} instructions The total, per operation.
 * @property {number} statements Per operation.
 * @property {number} rows Per operation.
 * @property {number} blocks Per operation.
 * @property {{ text: string, statements: number }[]} byStatement The most frequent statements of the window.
 * @property {Record<string, number>} dbByCommand The instructions of the server's processes, by title (PostgreSQL:
 *     backend, checkpointer, autovacuum...).
 * @property {Contention} [contention] A contention scenario: what its workers saw.
 */

/**
 * @typedef {object} Contention
 * @property {{ samples: number, p50: number, p95: number, p99: number }} latency From the enqueue to the first start,
 *     in ms, of the jobs that started in the window.
 * @property {{ jobs: number, share: number } | null} blocked The share of the jobs that started in the window and
 *     waited on a full key; null without limits.
 * @property {{ keys: number, busiest: { concurrency: string | null, rate: string | null } } | null} guard The keys
 *     of the run, and the closest to its bound of each kind; null without limits. A violation fails the run.
 * @property {{ retried: number, rateLimited: number, internalErrors: number }} events In the window. Internal
 *     errors: `error` events of sqlane (a deadlock of a sweep), which do not fail these runs.
 * @property {{ runs: number, jobs: number, repeated: number }} runs The runs of the whole run (all of its jobs), and
 *     those beyond what the trace explains: a job that ran again after a stall, or twice at once.
 */

/**
 * The counters of the processes, and the time.
 * @param {Lane} lane
 * @param {Child[]} children
 * @returns {Promise<{ at: number, cpu: Record<string, import('../lib/counters.mjs').Counters> }>}
 */
async function readCounters(lane, children) {
    const startedAt = Date.now();
    const cpu = await countersAsync({
        db: `${lane.server.pid}+`,
        ...Object.fromEntries(children.map(child => [child.role, String(child.process.pid)])),
    });

    return { at: (startedAt + Date.now()) / 2, cpu };
}

/**
 * One run of a scenario with one source tree, on a fresh database.
 * @param {Lane} lane
 * @param {Scenario} scenario
 * @param {{ variant: string, src: string, attempt: number }} options
 * @returns {Promise<Run>}
 */
async function runScenario(lane, scenario, { variant, src, attempt }) {
    const database = `ab_${scenario.name}`;
    const url = await lane.stats.createDatabase(database);
    const dir = join(lane.dir, `${scenario.name}-${attempt}-${variant}`);
    const timing = timingOf(scenario);
    const common = [
        '--src', src, '--dialect', lane.dialect, '--url', url, '--names', String(NAMES),
        '--hint-port', String(HINT_PORTS[lane.dialect]),
        ...scenario.trace ? ['--seed', String(SEED), '--trace-seconds', String(traceSecondsOf(timing))] : [],
    ];

    mkdirSync(dir, { recursive: true });

    const setup = startApp(common, 'setup', join(dir, 'setup.log'));

    if (await setup.exited !== 0) {
        throw new Error(`${lane.dialect} ${scenario.name} ${variant}: setup failed: see ${join(dir, 'setup.log')}`);
    }

    // The setup's DDL leaves work to the server's background processes: a checkpoint, InnoDB's purge and dirty pages.
    // In the window, it would count as the cost of the scenario (an idle worker's second cost 30% more on MySQL after
    // the migrations of 6.0). A clean restart does it all first
    await restartLane(lane);

    /** @type {Child[]} */
    const children = [];

    try {
        /** @type {number | null} When the first process runs: the first poll of a worker */
        let readyAt = null;

        for (const { role, label = role, args: roleArgs = [] } of scenario.processes) {
            const child = startApp([...common, ...roleArgs], role, join(dir, `${label}.log`), label);

            children.push(child);
            await child.ready;
            readyAt ??= Date.now();
        }

        const { start, windowMs } = windowOf(scenario, /** @type {number} */ (readyAt), timing);

        await sleepUntil(start);

        // The producers pause: no operation straddles the edge
        const countsBefore = await Promise.all(children.map(child => child.request('pause')));

        // Their young generation empty: a scavenge in the window comes from its allocations, not from the start-up's,
        // which differ between versions and would put one in the window of one of them (an idle worker allocates
        // ~100 KB per poll: none then)
        await Promise.all(children.map(child => child.request('collect')));
        await lane.stats.reset(database);

        const before = await readCounters(lane, children);

        await Promise.all(children.map(child => child.request('resume')));
        await sleepUntil(before.at + windowMs);

        const countsAfter = await Promise.all(children.map(child => child.request('pause')));
        const after = await readCounters(lane, children);
        const stats = await lane.stats.read(database);

        const totalBefore = sumOf(countsBefore);
        const counts = Object.fromEntries(Object.entries(sumOf(countsAfter)).map(([key, value]) => [
            key, value - (totalBefore[key] ?? 0),
        ]));
        const contention = scenario.trace
            ? await contentionOf(scenario, children, counts, { from: before.at, to: after.at, timing })
            : undefined;

        const seconds = (after.at - before.at) / 1000;
        const operations = scenario.per === 'seconds' ? seconds : counts[scenario.per];
        const cpu = Object.fromEntries(Object.keys(after.cpu).map(label => [
            label, difference(before.cpu[label], after.cpu[label]),
        ]));
        const instructions = sum(Object.values(cpu).map(counters => counters.instructions));

        if (!(operations > 0) || counts.errors) {
            throw new Error(`${lane.dialect} ${scenario.name} ${variant}: ${operations} operations, ${
                counts.errors} errors: see ${dir}`);
        }

        return {
            variant,
            seconds,
            operations,
            counts,
            countsBefore: sumOf(countsBefore),
            cpu,
            instructions: instructions / operations,
            statements: stats.statements / operations,
            rows: stats.rows / operations,
            blocks: stats.blocks / operations,
            byStatement: stats.byStatement.slice(0, 30).map(row => ({ text: row.text, statements: row.statements })),
            dbByCommand: Object.fromEntries(Object.entries(after.cpu.db.byCommand ?? {}).map(([command, [value]]) => [
                command, value - (before.cpu.db.byCommand?.[command]?.[0] ?? 0),
            ])),
            ...contention && { contention },
        };
    } finally {
        await Promise.all(children.map(async (child) => {
            try {
                await child.request('stop', 20_000);
            } catch {
                child.process.kill('SIGKILL');
            }

            await child.exited;
        }));
        // No autovacuum of its tables in the next runs
        await lane.admin(`DROP DATABASE IF EXISTS ${database}${lane.dialect === 'postgres' ? ' WITH (FORCE)' : ''}`);
    }
}

/**
 * The admin connection and the statistics of the lane's server: one connection through the lane, until a restart. A
 * server process that exits in a window would take its counts with it.
 * @param {Lane} lane
 * @returns {Promise<void>}
 */
async function connectLane(lane) {
    lane.stats = await statsServer({ dialect: lane.dialect, adminUrl: lane.server.adminUrl });

    if (lane.dialect === 'postgres') {
        const client = new Client({ connectionString: lane.server.adminUrl });

        await client.connect();
        versions[lane.dialect] = (await client.query('SELECT version() AS version')).rows[0].version;
        lane.admin = async sql => (await client.query(sql)).rows;
        lane.closeAdmin = () => client.end();
    } else {
        const connection = await createConnection({ uri: lane.server.adminUrl });
        const [rows] = /** @type {[any[], unknown]} */ (await connection.query('SELECT version() AS version'));

        versions[lane.dialect] = rows[0].version;
        lane.admin = async sql => /** @type {any[]} */ ((await connection.query(sql))[0]);
        lane.closeAdmin = () => connection.end();
    }
}

/**
 * Restarts the lane's server cleanly, and connects to it again.
 * @param {Lane} lane
 * @returns {Promise<void>}
 */
async function restartLane(lane) {
    await lane.closeAdmin();
    await lane.stats.close();
    await lane.server.restart?.();
    await connectLane(lane);
}

/**
 * The start of the window and its length. `poll`: from the middle of a poll interval of the worker, whole intervals.
 * `slot`: from 5 s after a slot of the schedules, whole slots. Else from the end of the warm-up.
 * @param {Scenario} scenario
 * @param {number} readyAt When the processes started: the first poll of a worker.
 * @param {{ warmupMs: number, windowMs: number }} timing Of the scenario.
 * @returns {{ start: number, windowMs: number }}
 */
function windowOf(scenario, readyAt, { warmupMs, windowMs: lengthMs }) {
    if (scenario.align === 'poll') {
        return {
            start: readyAt + (Math.ceil(warmupMs / POLL_MS) * POLL_MS) + (POLL_MS / 2),
            windowMs: Math.max(1, Math.round(lengthMs / POLL_MS)) * POLL_MS,
        };
    }

    if (scenario.align === 'slot') {
        // The first middle after the warm-up and after 2 slots since the start. After 1, the database's cost of the
        // window took one of two values, 40% apart, in either variant: prepared statements of PostgreSQL's
        // connections that had run few times (custom plans first), likely.
        const slot = Math.max(
            (Math.ceil(readyAt / SLOT_MS) + 1) * SLOT_MS,
            Math.ceil((readyAt + warmupMs - (SLOT_MS / 2)) / SLOT_MS) * SLOT_MS,
        );

        return { start: slot + (SLOT_MS / 2), windowMs: Math.max(1, Math.ceil(lengthMs / SLOT_MS)) * SLOT_MS };
    }

    return { start: readyAt + warmupMs, windowMs: lengthMs };
}

/**
 * @param {{ warmupMs: number, windowMs: number }} timing
 * @returns {number} The length of the trace of a contention scenario, in s.
 */
function traceSecondsOf({ warmupMs, windowMs }) {
    return Math.ceil((warmupMs + windowMs) / 1000) + TRACE_MARGIN_S;
}

/** @type {Map<string, import('./trace.mjs').Trace>} */
const traces = new Map();

/**
 * @param {'realistic' | 'stress'} profile
 * @param {number} seconds
 * @returns {import('./trace.mjs').Trace} The trace that the processes of the scenario replay.
 */
function traceOf(profile, seconds) {
    const key = `${profile}:${seconds}`;

    if (!traces.has(key)) {
        traces.set(key, generateTrace({ profile, seed: SEED, seconds }));
    }

    return /** @type {import('./trace.mjs').Trace} */ (traces.get(key));
}

/**
 * What the workers of a contention scenario saw: the latencies of the window, from the histograms in their counts
 * (taken out of `counts`), and, with limits, the runs of the jobs, once, after the window: the guard, and the jobs
 * that waited on a full key.
 * @param {Scenario} scenario
 * @param {Child[]} children
 * @param {Record<string, number>} counts The counts of the window.
 * @param {{ from: number, to: number, timing: { warmupMs: number, windowMs: number } }} window
 * @returns {Promise<Contention>}
 */
async function contentionOf(scenario, children, counts, { from, to, timing }) {
    /** @type {Map<number, number>} */
    const histogram = new Map();

    for (const [key, value] of Object.entries(counts)) {
        if (key.startsWith('latency_')) {
            histogram.set(Number(key.slice('latency_'.length)), value);
            Reflect.deleteProperty(counts, key);
        }
    }

    const { samples, values: [p50, p95, p99] } = percentilesOf(histogram, [0.5, 0.95, 0.99]);
    const traced = /** @type {NonNullable<Scenario['trace']>} */ (scenario.trace);
    const replies = await Promise.all(children
        .filter(child => child.role.startsWith('worker'))
        .map(child => child.message('runs')));
    /** @type {import('./contention.mjs').Runs} */
    const runs = { index: [], start: [], end: [], enqueuedAt: [] };

    for (const reply of replies) {
        for (const field of /** @type {const} */ (['index', 'start', 'end', 'enqueuedAt'])) {
            runs[field] = runs[field].concat(reply.runs[field]);
        }
    }

    const trace = traceOf(traced.profile, traceSecondsOf(timing));
    const { example, ...repeated } = repeatedRuns(trace, runs);

    if (example) {
        console.error(`${scenario.name}: ${repeated.repeated} runs beyond those of the trace, e.g. job ${
            example.index} started at ${example.starts.join(', ')}`);
    }

    /** @type {Contention} */
    const contention = {
        latency: { samples, p50, p95, p99 },
        blocked: null,
        guard: null,
        events: { retried: counts.retried, rateLimited: counts.rateLimited, internalErrors: counts.internalErrors },
        runs: repeated,
    };

    if (!traced.limits) {
        return contention;
    }

    const keys = runsByKey(trace, runs);
    const checked = guard(keys);

    if (checked.violations.length > 0) {
        throw new Error(`The guard: ${checked.violations.length} keys over their limit: ${
            checked.violations.slice(0, 10).join('; ')}`);
    }

    const { jobs, blocked } = blockedJobs(trace, runs, keys, { from, to });

    return {
        ...contention,
        blocked: { jobs, share: jobs ? blocked / jobs : 0 },
        guard: { keys: checked.keys, busiest: checked.busiest },
    };
}

/**
 * @param {Record<string, number>[]} counts
 * @returns {Record<string, number>} The counts of the processes, added up.
 */
function sumOf(counts) {
    /** @type {Record<string, number>} */
    const total = {};

    for (const processCounts of counts) {
        for (const [key, value] of Object.entries(processCounts)) {
            total[key] = (total[key] ?? 0) + value;
        }
    }

    return total;
}

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
 * @param {number} base
 * @param {number} current
 * @returns {number} The relative difference.
 */
function deltaOf(base, current) {
    if (base === current) {
        return 0;
    }

    return base ? (current / base) - 1 : Infinity;
}

/**
 * @typedef {object} Comparison
 * @property {string} dialect
 * @property {string} scenario
 * @property {string} unit
 * @property {Run[]} runs
 * @property {{ base: number, current: number, delta: number }} instructions The means of the runs.
 * @property {{ base: number, current: number, delta: number }} statements
 * @property {'same' | 'faster' | 'slower'} verdict
 * @property {boolean} confirmed The first pair was beyond a threshold, and the rerun too, in the same direction.
 * @property {boolean} rerun
 * @property {string} [error]
 * @property {string} [skipped] Why the scenario did not run: a source tree without its export.
 * @property {{ base: Contention, current: Contention }} [contention] A contention scenario: the means of the runs.
 * @property {{ instructions: number, statements: number }} [thresholds] Its thresholds, if not THRESHOLDS.
 */

/**
 * @param {Run[]} pair
 * @returns {{ instructions: number, statements: number }} The differences of the current tree.
 */
function deltasOf(pair) {
    const base = /** @type {Run} */ (pair.find(run => run.variant === 'base'));
    const current = /** @type {Run} */ (pair.find(run => run.variant === 'current'));

    return {
        instructions: deltaOf(base.instructions, current.instructions),
        statements: deltaOf(base.statements, current.statements),
    };
}

/**
 * @param {{ instructions: number, statements: number }} deltas
 * @param {{ instructions: number, statements: number }} [thresholds]
 * @returns {{ instructions: -1 | 0 | 1, statements: -1 | 0 | 1 }} Per metric: beyond its threshold, and which way.
 */
function directions(deltas, thresholds = THRESHOLDS) {
    /**
     * @param {'instructions' | 'statements'} metric
     * @returns {-1 | 0 | 1}
     */
    const direction = (metric) => {
        if (Math.abs(deltas[metric]) <= thresholds[metric]) {
            return 0;
        }

        return deltas[metric] > 0 ? 1 : -1;
    };

    return { instructions: direction('instructions'), statements: direction('statements') };
}

/**
 * The scenario with both trees; again in the other order if a difference is beyond its threshold.
 * @param {Lane} lane
 * @param {Scenario} scenario
 * @param {{ base: string, current: string }} sources
 * @returns {Promise<Comparison>}
 */
async function compare(lane, scenario, sources) {
    const missing = await missingExport(scenario, sources);

    if (missing) {
        console.error(`${lane.dialect} ${scenario.name}: skipped, ${missing}`);

        return { ...failed(lane.dialect, scenario, null), skipped: missing };
    }

    const startedAt = Date.now();
    /**
     * @param {string[]} order
     * @param {number} attempt
     * @returns {Promise<Run[]>}
     */
    const pairOf = async (order, attempt) => {
        /** @type {Run[]} */
        const runs = [];

        for (const variant of order) {
            const run = await runScenario(lane, scenario, {
                variant, src: variant === 'base' ? sources.base : sources.current, attempt,
            });

            runs.push(run);
            console.error(`${lane.dialect} ${scenario.name} ${variant}: ${(run.instructions / 1e6).toFixed(2)} M `
                + `instructions, ${run.statements.toFixed(2)} statements per operation (${run.operations.toFixed(0)} `
                + `operations in ${run.seconds.toFixed(1)} s)${run.contention ? `; ${contentionText(run.contention)}` : ''}`);
        }

        return runs;
    };
    const first = await pairOf(['base', 'current'], 1);
    const firstDirections = directions(deltasOf(first), scenario.thresholds);
    const beyond = firstDirections.instructions !== 0 || firstDirections.statements !== 0;
    const runs = beyond ? [...first, ...await pairOf(['current', 'base'], 2)] : first;
    /** @type {{ instructions: -1 | 0 | 1, statements: -1 | 0 | 1 }} */
    const confirmedDirections = { instructions: 0, statements: 0 };

    if (beyond) {
        const second = directions(deltasOf(runs.slice(2)), scenario.thresholds);

        for (const metric of /** @type {const} */ (['instructions', 'statements'])) {
            confirmedDirections[metric] = firstDirections[metric] === second[metric] ? second[metric] : 0;
        }
    }

    const confirmed = Object.values(confirmedDirections);
    /**
     * @param {'instructions' | 'statements'} metric
     * @returns {{ base: number, current: number, delta: number }}
     */
    const meanOf = (metric) => {
        /**
         * @param {string} variant
         * @returns {number}
         */
        const mean = (variant) => {
            const values = runs.filter(run => run.variant === variant).map(run => run[metric]);

            return sum(values) / values.length;
        };

        return { base: mean('base'), current: mean('current'), delta: deltaOf(mean('base'), mean('current')) };
    };

    console.error(`${lane.dialect} ${scenario.name}: ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);

    /** @type {'same' | 'faster' | 'slower'} */
    let verdict = 'same';

    if (confirmed.includes(1)) {
        verdict = 'slower';
    } else if (confirmed.includes(-1)) {
        verdict = 'faster';
    }

    return {
        dialect: lane.dialect,
        scenario: scenario.name,
        unit: scenario.unit,
        runs,
        instructions: meanOf('instructions'),
        statements: meanOf('statements'),
        verdict,
        confirmed: verdict !== 'same',
        rerun: beyond,
        ...scenario.trace && {
            contention: { base: meanContention(runs, 'base'), current: meanContention(runs, 'current') },
        },
        ...scenario.thresholds && { thresholds: scenario.thresholds },
    };
}

/**
 * @param {Run[]} runs
 * @param {string} variant
 * @returns {Contention} The means of the variant's runs; the guard of the first.
 */
function meanContention(runs, variant) {
    const all = runs.filter(run => run.variant === variant).map(run => /** @type {Contention} */ (run.contention));
    /**
     * @param {(contention: Contention) => number} value
     * @returns {number}
     */
    const mean = value => sum(all.map(value)) / all.length;

    return {
        latency: {
            samples: mean(item => item.latency.samples),
            p50: mean(item => item.latency.p50),
            p95: mean(item => item.latency.p95),
            p99: mean(item => item.latency.p99),
        },
        blocked: all[0].blocked && {
            jobs: mean(item => item.blocked?.jobs ?? 0),
            share: mean(item => item.blocked?.share ?? 0),
        },
        guard: all[0].guard,
        events: {
            retried: mean(item => item.events.retried),
            rateLimited: mean(item => item.events.rateLimited),
            internalErrors: mean(item => item.events.internalErrors),
        },
        runs: {
            runs: mean(item => item.runs.runs),
            jobs: mean(item => item.runs.jobs),
            repeated: mean(item => item.runs.repeated),
        },
    };
}

/**
 * @param {Contention} contention
 * @returns {string} Its latencies, its blocked share and its guard, in a line.
 */
function contentionText({ latency, blocked, guard: checked, runs, events }) {
    const latencies = `latency p50/p95/p99 ${[latency.p50, latency.p95, latency.p99].map(ms => ms.toFixed(0)).join('/')} ms`;
    const share = blocked ? `, ${(blocked.share * 100).toFixed(1)}% of ${blocked.jobs.toFixed(0)} jobs blocked` : '';

    return `${latencies}${share}${checked ? `, guard ok on ${checked.keys} keys` : ''}, ${
        runs.repeated} repeated runs${events.internalErrors ? `, ${events.internalErrors} internal errors` : ''}`;
}

/**
 * @param {Scenario} scenario
 * @param {{ base: string, current: string }} sources
 * @returns {Promise<string | null>} Which tree lacks the export that the scenario needs, if one does.
 */
async function missingExport(scenario, sources) {
    if (!scenario.requires) {
        return null;
    }

    for (const variant of /** @type {const} */ (['base', 'current'])) {
        const lib = await import(join(sources[variant], 'src/index.js'));

        if (!(scenario.requires in lib)) {
            return `the ${variant === 'base' ? 'baseline' : 'working tree'} has no ${scenario.requires}`;
        }
    }

    return null;
}

/**
 * @param {string} dialect
 * @param {Scenario} scenario
 * @param {unknown} error null: no error, a skipped scenario.
 * @returns {Comparison}
 */
function failed(dialect, scenario, error) {
    return {
        dialect, scenario: scenario.name, unit: scenario.unit, runs: [],
        instructions: { base: 0, current: 0, delta: 0 }, statements: { base: 0, current: 0, delta: 0 },
        verdict: 'same', confirmed: false, rerun: false, ...error !== null && { error: String(error) },
    };
}

/**
 * The scenarios on one database server; a server that fails fails its scenarios only.
 * @param {'postgres' | 'mysql' | 'mariadb'} dialect
 * @param {{ base: string, current: string }} sources
 * @returns {Promise<Comparison[]>}
 */
async function runLane(dialect, sources) {
    try {
        return await runServer(dialect, sources);
    } catch (error) {
        console.error(`${dialect}: ${/** @type {Error} */ (error).stack}`);

        return scenarios.map(scenario => failed(dialect, scenario, error));
    }
}

/**
 * @param {'postgres' | 'mysql' | 'mariadb'} dialect
 * @param {{ base: string, current: string }} sources
 * @returns {Promise<Comparison[]>}
 */
async function runServer(dialect, sources) {
    const dir = join(out, dialect);

    mkdirSync(dir, { recursive: true });

    const server = await startServer(dialect, { bin: BINS[dialect], port: PORTS[dialect], dir });

    cleanups.push(() => server.kill());

    const lane = /** @type {Lane} */ ({ dialect, server, dir });

    await connectLane(lane);

    /** @type {Comparison[]} */
    const comparisons = [];

    try {
        for (const scenario of scenarios) {
            try {
                comparisons.push(await compare(lane, scenario, sources));
            } catch (error) {
                console.error(`${dialect} ${scenario.name}: ${/** @type {Error} */ (error).stack}`);
                comparisons.push(failed(dialect, scenario, error));
            }
        }
    } finally {
        await lane.closeAdmin();
        await lane.stats.close();
        await server.stop();
    }

    return comparisons;
}

/**
 * @param {number} delta
 * @returns {string}
 */
function percent(delta) {
    if (!Number.isFinite(delta)) {
        return 'new';
    }

    return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
}

/**
 * @param {number} value
 * @returns {string} 2 decimals, 3 below 1.
 */
function count(value) {
    return value.toFixed(value < 1 ? 3 : 2);
}

/**
 * @param {Comparison[]} comparisons
 * @returns {string} The Markdown table.
 */
function table(comparisons) {
    const rows = comparisons.map((row) => {
        if (row.error) {
            return `| ${row.scenario} | ${row.dialect} | | | error: ${row.error.split('\n')[0]} |`;
        }

        if (row.skipped) {
            return `| ${row.scenario} | ${row.dialect} | | | n/a: ${row.skipped} |`;
        }

        const { instructions: i, statements: s } = row;
        let verdict = row.confirmed ? `**${row.verdict}**, confirmed` : 'same';

        if (row.rerun && !row.confirmed) {
            verdict = 'same (not confirmed by the rerun)';
        }

        return `| ${row.scenario} | ${row.dialect} | ${(i.base / 1e6).toFixed(2)} M → ${(i.current / 1e6).toFixed(2)} M (${
            percent(i.delta)}) | ${count(s.base)} → ${count(s.current)} (${percent(s.delta)}) | ${verdict} |`;
    });

    return [
        '| Scenario | Database | Instructions per op | Statements per op | Verdict |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
    ].join('\n');
}

/**
 * @param {Contention} contention
 * @returns {string} Its latencies, in ms.
 */
function latenciesOf({ latency }) {
    return [latency.p50, latency.p95, latency.p99].map(ms => ms.toFixed(0)).join(' / ');
}

/**
 * @param {Contention} contention
 * @returns {string} Its blocked share.
 */
function blockedOf({ blocked }) {
    return blocked ? `${(blocked.share * 100).toFixed(1)}%` : '–';
}

/**
 * The contention scenarios: their latencies, blocked shares and guards, and the penalty of the limits (each scenario
 * with limits against its plain twin, per tree).
 * @param {Comparison[]} comparisons
 * @returns {string} The Markdown tables; empty without a contention scenario.
 */
function contentionTables(comparisons) {
    const rows = comparisons.filter(row => row.contention);

    if (rows.length === 0) {
        return '';
    }

    const lines = [
        '\nContention (no verdict): the latency from the enqueue to the first start of the jobs that started in the window, '
        + 'the share of them that waited on a full key (estimated from the start and the end of each run), and the guard '
        + '(a violation fails the run). Repeated runs: runs that the trace does not explain (a job that ran again after a '
        + 'stall, or twice at once), in the whole run. Internal errors: `error` events of sqlane in the window (they do '
        + 'not fail these runs). Baseline → working tree.\n',
        '| Scenario | Database | Latency p50 / p95 / p99, ms | Blocked | Guard | Repeated runs | Internal errors |',
        '| --- | --- | --- | --- | --- | --- | --- |',
    ];

    for (const row of rows) {
        const { base, current } = /** @type {NonNullable<Comparison['contention']>} */ (row.contention);

        lines.push(`| ${row.scenario} | ${row.dialect} | ${latenciesOf(base)} → ${latenciesOf(current)} | ${
            blockedOf(base)} → ${blockedOf(current)} | ${current.guard ? `ok, ${current.guard.keys} keys` : '–'} | ${
            base.runs.repeated} of ${base.runs.runs} → ${current.runs.repeated} of ${current.runs.runs} | ${
            base.events.internalErrors} → ${current.events.internalErrors} |`);
    }

    /** @type {string[]} */
    const penalties = [];

    for (const row of rows.filter(item => !item.scenario.endsWith('_plain'))) {
        const plain = comparisons.find(item => item.scenario === `${row.scenario}_plain` && item.dialect === row.dialect);

        if (!plain?.contention) {
            continue;
        }

        /**
         * @param {'instructions' | 'statements'} metric
         * @param {(value: number) => string} format
         * @returns {string} Plain → limits (penalty) of the working tree, and the baseline's penalty.
         */
        const penalty = (metric, format) => `${format(plain[metric].current)} → ${format(row[metric].current)} (×${
            (row[metric].current / plain[metric].current).toFixed(2)}; baseline ×${
            (row[metric].base / plain[metric].base).toFixed(2)})`;

        penalties.push(`| ${row.scenario} | ${row.dialect} | ${penalty('instructions', value => `${(value / 1e6).toFixed(2)} M`)} | ${
            penalty('statements', count)} |`);
    }

    if (penalties.length > 0) {
        lines.push(
            '\nThe penalty of the limits: per completed job, without limits → with them, in the working tree (the ratio), '
            + 'and the baseline\'s ratio.\n',
            '| Scenario | Database | Instructions per job | Statements per job |',
            '| --- | --- | --- | --- |',
            ...penalties,
        );
    }

    return lines.join('\n');
}

/**
 * @param {number} instructions
 * @param {number} statements
 * @returns {{ instructionsPerOp: number, statementsPerOp: number }} Rounded: to a unit, to 4 decimals.
 */
function perOp(instructions, statements) {
    return {
        instructionsPerOp: Math.round(instructions),
        statementsPerOp: Math.round(statements * 10_000) / 10_000,
    };
}

/**
 * The numbers of `--save`: the working tree's, per scenario and database, with the baseline's and the verdict. The keys
 * in a fixed order.
 * @param {Comparison[]} comparisons
 * @param {{ commit: string | null, totalS: number }} run
 * @returns {object}
 */
function saved(comparisons, { commit, totalS }) {
    return {
        date: new Date().toISOString(),
        ref: args.ref,
        commit,
        machine: {
            platform: process.platform,
            cpu: cpus()[0]?.model.trim() ?? null,
            cores: cpus().length,
            memoryGiB: Math.round(totalmem() / (2 ** 30)),
            kernel: release(),
        },
        kernelCounted: countsKernel(),
        node: process.version,
        servers: Object.fromEntries(dialects.map(dialect => [dialect, versions[dialect] ?? null])),
        warmupS: WARMUP_MS / 1000,
        windowS: WINDOW_MS / 1000,
        totalS: Math.round(totalS),
        scenarios: Object.fromEntries(scenarios.map(scenario => [scenario.name, {
            unit: scenario.op,
            description: scenario.unit,
            ...scenario.trace && {
                warmupS: timingOf(scenario).warmupMs / 1000,
                windowS: timingOf(scenario).windowMs / 1000,
                seed: SEED,
            },
            databases: Object.fromEntries(dialects.map((dialect) => {
                const row = comparisons.find(item => item.scenario === scenario.name && item.dialect === dialect);

                if (row?.skipped) {
                    return [dialect, { skipped: row.skipped }];
                }

                if (!row || row.error) {
                    return [dialect, { error: row?.error ?? 'missing' }];
                }

                return [dialect, {
                    ...perOp(row.instructions.current, row.statements.current),
                    baseline: perOp(row.instructions.base, row.statements.base),
                    verdict: row.verdict,
                    ...row.contention && { contention: row.contention.current },
                }];
            })),
        }])),
    };
}

const startedAt = Date.now();

/** Kills the processes and the servers that are left */
function cleanUp() {
    for (const cleanup of cleanups.splice(0).toReversed()) {
        try {
            cleanup();
        } catch {
            // Already stopped
        }
    }
}

process.once('SIGINT', () => {
    cleanUp();
    process.kill(process.pid, 'SIGINT');
});

try {
    const { dir: base, commit } = extract(args.ref);

    const baseline = commit ? `${args.ref} (${commit.slice(0, 12)})` : 'the working tree itself';

    console.error(`Baseline: ${baseline}; results and logs: ${out}`);
    await startCounters();

    const lanes = await Promise.all(dialects.map(dialect => runLane(
        /** @type {'postgres' | 'mysql' | 'mariadb'} */ (dialect), { base, current: ROOT },
    )));
    const comparisons = scenarios.flatMap(scenario => lanes.flat().filter(row => row.scenario === scenario.name));
    const totalS = (Date.now() - startedAt) / 1000;
    const file = join(out, 'results.json');

    writeFileSync(file, `${JSON.stringify({
        date: new Date().toISOString(), ref: args.ref, commit, platform: process.platform, cpu: cpus()[0]?.model.trim(),
        cores: cpus().length, node: process.version, warmupS: WARMUP_MS / 1000, windowS: WINDOW_MS / 1000,
        thresholds: THRESHOLDS, totalS, comparisons,
    }, null, 4)}\n`);

    if (args.save) {
        const saveFile = resolvePath(args.save);

        mkdirSync(dirname(saveFile), { recursive: true });
        writeFileSync(saveFile, `${JSON.stringify(saved(comparisons, { commit, totalS }), null, 4)}\n`);
        console.error(`Saved: ${saveFile}`);
    }

    console.log(`\nWorking tree vs ${baseline}: per operation, the instructions of the sqlane `
        + 'processes and of the database server, and the statements of the database. Mean of the runs; a difference '
        + `beyond ±${THRESHOLDS.instructions * 100}% (instructions) or ±${THRESHOLDS.statements * 100}% (statements) `
        + 'is rerun in the other order, and counts if the rerun confirms it.\n');
    console.log(table(comparisons));

    const thresholds = scenarios.filter(scenario => scenario.thresholds).map(scenario => `${scenario.name} ±${
        /** @type {{ instructions: number }} */ (scenario.thresholds).instructions * 100}% / ±${
        /** @type {{ statements: number }} */ (scenario.thresholds).statements * 100}%`);

    if (thresholds.length > 0) {
        console.log(`\nThresholds of their own (instructions / statements): ${thresholds.join(', ')}.`);
    }

    console.log(contentionTables(comparisons));
    console.log(`\n${scenarios.map(scenario => `- ${scenario.name}: per ${scenario.unit}`).join('\n')}`);
    console.log(`\nTotal: ${(totalS / 60).toFixed(1)} min. Raw results: ${file}`);
    rmSync(join(out, 'baseline'), { recursive: true, force: true });

    if (comparisons.some(row => row.verdict === 'slower')) {
        process.exitCode = 1;
    } else if (comparisons.some(row => row.error)) {
        process.exitCode = 2;
    }
} finally {
    stopCounters();
    cleanUp();
}
