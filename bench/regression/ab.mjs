// The A/B performance regression check: `pnpm bench:regression [--ref main] [--db postgres|mysql|mariadb]… [--scenario
// <name>]… [--window 15] [--warmup 5] [--out <dir>] [--save <file>]`. Compares the working tree with a git ref on
// PostgreSQL, MySQL and MariaDB of this host (started from their binaries: --pg-bin, --mysql-bin, --mariadb-bin,
// defaults: the PG_BIN, MYSQL_BIN and MARIADB_BIN variables, else Homebrew's), in six scenarios under steady load. Each
// scenario runs its sqlane processes (app.mjs) on a fresh database, and measures a window: the CPU instructions per
// operation of these processes and of the database server (with its descendants), and the statements per operation (the
// server's statistics, db_stats.mjs).
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
// one lane each, their scenarios one after the other. About 6 minutes with the defaults, more with reruns.
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
        'window': { type: 'string', default: '15' },
        'warmup': { type: 'string', default: '5' },
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
const WINDOW_MS = Number(args.window) * 1000;
const WARMUP_MS = Number(args.warmup) * 1000;

/**
 * @typedef {object} Scenario
 * @property {string} name
 * @property {string} unit What one operation is.
 * @property {string} op The same, short (`--save`).
 * @property {{ role: 'producer' | 'worker' | 'scheduler', args?: string[] }[]} processes Started in this order.
 * @property {'ops' | 'completed' | 'fired' | 'seconds'} per The operations: the producer's calls, the worker's
 *     completed jobs, the scheduler's fired slots, or the seconds of the window.
 * @property {'none' | 'poll' | 'slot'} align
 */

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
        name: 'mutex',
        unit: 'job with one of 100 mutex keys (20/s)',
        op: 'job',
        processes: [
            { role: 'worker', args: ['--mutex-keys', '100'] },
            { role: 'producer', args: ['--op', 'enqueue', '--rate', '20', '--mutex-keys', '100'] },
        ],
        per: 'completed',
        align: 'poll',
    },
];

const dialects = args.db ?? DIALECTS;
const scenarios = args.scenario ? SCENARIOS.filter(scenario => args.scenario?.includes(scenario.name)) : SCENARIOS;
const unknown = [
    ...dialects.filter(dialect => !DIALECTS.includes(/** @type {any} */ (dialect))),
    ...(args.scenario ?? []).filter(name => !SCENARIOS.some(scenario => scenario.name === name)),
];

if (unknown.length || !(WINDOW_MS > 0) || !(WARMUP_MS >= 0)) {
    throw new Error(`Unknown or invalid: ${unknown.join(', ') || `--window ${args.window} --warmup ${args.warmup}`}`);
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
 * @property {string} role
 * @property {import('node:child_process').ChildProcess} process
 * @property {Promise<void>} ready
 * @property {(type: string, timeoutMs?: number) => Promise<Record<string, number>>} request Resolves to its counts.
 * @property {Promise<number | null>} exited
 */

/**
 * Forks app.mjs, its output to a log file.
 * @param {string[]} appArgs
 * @param {string} role
 * @param {string} log
 * @returns {Child}
 */
function startApp(appArgs, role, log) {
    const fd = openSync(log, 'w');
    const child = fork(APP, [...appArgs, '--role', role], { stdio: ['ignore', fd, fd, 'ipc'] });

    closeSync(fd);

    /** @type {Map<number, PromiseWithResolvers<Record<string, number>>>} */
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
            pending.get(message.id)?.resolve(message.counts);
            pending.delete(message.id);
        }
    });
    cleanups.push(() => child.kill('SIGKILL'));

    return {
        role,
        process: child,
        ready: ready.promise,
        exited,
        async request(type, timeoutMs = 30_000) {
            if (child.exitCode !== null || child.signalCode !== null) {
                throw new Error(`${role} exited: see ${log}`);
            }

            const id = next++;
            /** @type {PromiseWithResolvers<Record<string, number>>} */
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
 * @property {(sql: string) => Promise<void>} admin
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
    const common = [
        '--src', src, '--dialect', lane.dialect, '--url', url, '--names', String(NAMES),
        '--hint-port', String(HINT_PORTS[lane.dialect]),
    ];

    mkdirSync(dir, { recursive: true });

    const setup = startApp(common, 'setup', join(dir, 'setup.log'));

    if (await setup.exited !== 0) {
        throw new Error(`${lane.dialect} ${scenario.name} ${variant}: setup failed: see ${join(dir, 'setup.log')}`);
    }

    if (lane.dialect === 'postgres') {
        // No checkpoint of the setup in the window: the next timed one comes 5 minutes later
        await lane.admin('CHECKPOINT');
    }

    /** @type {Child[]} */
    const children = [];

    try {
        /** @type {number | null} When the first process runs: the first poll of a worker */
        let readyAt = null;

        for (const { role, args: roleArgs = [] } of scenario.processes) {
            const child = startApp([...common, ...roleArgs], role, join(dir, `${role}.log`));

            children.push(child);
            await child.ready;
            readyAt ??= Date.now();
        }

        const { start, windowMs } = windowOf(scenario, /** @type {number} */ (readyAt));

        await sleepUntil(start);

        // The producers pause: no operation straddles the edge
        const countsBefore = await Promise.all(children.map(child => child.request('pause')));

        await lane.stats.reset(database);

        const before = await readCounters(lane, children);

        await Promise.all(children.map(child => child.request('resume')));
        await sleepUntil(before.at + windowMs);

        const countsAfter = await Promise.all(children.map(child => child.request('pause')));
        const after = await readCounters(lane, children);
        const stats = await lane.stats.read(database);

        const totalBefore = sumOf(countsBefore);
        const counts = Object.fromEntries(Object.entries(sumOf(countsAfter)).map(([key, value]) => [
            key, value - totalBefore[key],
        ]));

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
 * The start of the window and its length. `poll`: from the middle of a poll interval of the worker, whole intervals.
 * `slot`: from 5 s after a slot of the schedules, whole slots. Else from the end of the warm-up.
 * @param {Scenario} scenario
 * @param {number} readyAt When the processes started: the first poll of a worker.
 * @returns {{ start: number, windowMs: number }}
 */
function windowOf(scenario, readyAt) {
    if (scenario.align === 'poll') {
        return {
            start: readyAt + (Math.ceil(WARMUP_MS / POLL_MS) * POLL_MS) + (POLL_MS / 2),
            windowMs: Math.max(1, Math.round(WINDOW_MS / POLL_MS)) * POLL_MS,
        };
    }

    if (scenario.align === 'slot') {
        // The first middle after the warm-up and after 2 slots since the start. After 1, the database's cost of the
        // window took one of two values, 40% apart, in either variant: prepared statements of PostgreSQL's
        // connections that had run few times (custom plans first), likely.
        const slot = Math.max(
            (Math.ceil(readyAt / SLOT_MS) + 1) * SLOT_MS,
            Math.ceil((readyAt + WARMUP_MS - (SLOT_MS / 2)) / SLOT_MS) * SLOT_MS,
        );

        return { start: slot + (SLOT_MS / 2), windowMs: Math.max(1, Math.ceil(WINDOW_MS / SLOT_MS)) * SLOT_MS };
    }

    return { start: readyAt + WARMUP_MS, windowMs: WINDOW_MS };
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
 * @returns {{ instructions: -1 | 0 | 1, statements: -1 | 0 | 1 }} Per metric: beyond its threshold, and which way.
 */
function directions(deltas) {
    /**
     * @param {'instructions' | 'statements'} metric
     * @returns {-1 | 0 | 1}
     */
    const direction = (metric) => {
        if (Math.abs(deltas[metric]) <= THRESHOLDS[metric]) {
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
                + `operations in ${run.seconds.toFixed(1)} s)`);
        }

        return runs;
    };
    const first = await pairOf(['base', 'current'], 1);
    const firstDirections = directions(deltasOf(first));
    const beyond = firstDirections.instructions !== 0 || firstDirections.statements !== 0;
    const runs = beyond ? [...first, ...await pairOf(['current', 'base'], 2)] : first;
    /** @type {{ instructions: -1 | 0 | 1, statements: -1 | 0 | 1 }} */
    const confirmedDirections = { instructions: 0, statements: 0 };

    if (beyond) {
        const second = directions(deltasOf(runs.slice(2)));

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
    };
}

/**
 * @param {string} dialect
 * @param {Scenario} scenario
 * @param {unknown} error
 * @returns {Comparison}
 */
function failed(dialect, scenario, error) {
    return {
        dialect, scenario: scenario.name, unit: scenario.unit, runs: [],
        instructions: { base: 0, current: 0, delta: 0 }, statements: { base: 0, current: 0, delta: 0 },
        verdict: 'same', confirmed: false, rerun: false, error: String(error),
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

    const stats = await statsServer({ dialect, adminUrl: server.adminUrl });
    /** @type {(sql: string) => Promise<void>} */
    let admin;
    /** @type {() => Promise<void>} */
    let closeAdmin;

    // One connection through the lane: a server process that exits in a window would take its counts with it
    if (dialect === 'postgres') {
        const client = new Client({ connectionString: server.adminUrl });

        await client.connect();
        versions[dialect] = (await client.query('SELECT version() AS version')).rows[0].version;
        admin = async (sql) => {
            await client.query(sql);
        };
        closeAdmin = () => client.end();
    } else {
        const connection = await createConnection({ uri: server.adminUrl });
        const [rows] = /** @type {[any[], unknown]} */ (await connection.query('SELECT version() AS version'));

        versions[dialect] = rows[0].version;
        admin = async (sql) => {
            await connection.query(sql);
        };
        closeAdmin = () => connection.end();
    }

    const lane = { dialect, server, stats, admin, dir };
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
        await closeAdmin();
        await stats.close();
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
            databases: Object.fromEntries(dialects.map((dialect) => {
                const row = comparisons.find(item => item.scenario === scenario.name && item.dialect === dialect);

                if (!row || row.error) {
                    return [dialect, { error: row?.error ?? 'missing' }];
                }

                return [dialect, {
                    ...perOp(row.instructions.current, row.statements.current),
                    baseline: perOp(row.instructions.base, row.statements.base),
                    verdict: row.verdict,
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
