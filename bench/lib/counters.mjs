// The CPU counters of processes: instructions retired, cycles and CPU time. macOS: proc_usage.py, a process per
// reading. Linux keeps no running total of a process's instructions: a daemon (proc_usage_linux.py) opens a counter on
// each thread as it appears, from the first reading on. PROC_USAGE_PYTHON: its interpreter, one with CAP_PERFMON so
// that the counts include the kernel (bench/compare/linux.dockerfile).
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CPU = join(import.meta.dirname, '../cpu');
const LINUX = process.platform === 'linux';

/**
 * @typedef {object} Counters
 * @property {number} instructions
 * @property {number} cycles
 * @property {number} cpuSeconds
 * @property {Record<string, any>} [byCommand] The same per process title, in a process tree.
 */

/** @type {Promise<(processes: Record<string, string>) => Promise<Record<string, Counters>>> | null} */
let linuxDaemon = null;
/** @type {import('node:child_process').ChildProcess | null} */
let daemonProcess = null;

/**
 * Starts the Linux daemon: the counts of a process that exists before it start at the daemon's start. Call it before
 * the processes to measure start; the first reading starts it otherwise.
 * @returns {Promise<void>}
 */
export async function startCounters() {
    if (LINUX) {
        linuxDaemon ??= startLinuxDaemon();
        await linuxDaemon;
    }
}

/**
 * Stops the Linux daemon, if it runs.
 */
export function stopCounters() {
    daemonProcess?.kill('SIGKILL');
    daemonProcess = null;
    linuxDaemon = null;
}

/**
 * @returns {Promise<(processes: Record<string, string>) => Promise<Record<string, Counters>>>} A request to the daemon.
 */
async function startLinuxDaemon() {
    // oxlint-disable-next-line node/no-process-env -- the interpreter of the daemon
    const daemon = spawn(process.env.PROC_USAGE_PYTHON ?? 'python3', [join(CPU, 'proc_usage_linux.py')], {
        stdio: ['pipe', 'pipe', 'inherit'],
    });

    daemonProcess = daemon;

    /** @type {Map<number, (result: Record<string, Counters>) => void>} */
    const pending = new Map();
    /** @type {PromiseWithResolvers<void>} */
    const ready = Promise.withResolvers();
    let next = 0;

    createInterface({ input: /** @type {import('node:stream').Readable} */ (daemon.stdout) }).on('line', (line) => {
        const message = JSON.parse(line);

        if (message.ready) {
            ready.resolve();
        } else {
            pending.get(message.id)?.(message.result);
            pending.delete(message.id);
        }
    });
    daemon.on('exit', code => ready.reject(new Error(`proc_usage_linux.py exited with ${code}`)));
    await ready.promise;

    return (processes) => {
        const id = next++;
        /** @type {PromiseWithResolvers<Record<string, Counters>>} */
        const { promise, resolve } = Promise.withResolvers();

        pending.set(id, resolve);
        daemon.stdin?.write(`${JSON.stringify({ id, processes })}\n`);

        return promise;
    };
}

/**
 * The counters of processes since their start, without blocking the event loop. A process that exited counts as zero.
 * @param {Record<string, string>} processes label: pid, with `+` for the process and its descendants (the processes
 *     of a PostgreSQL server).
 * @returns {Promise<Record<string, Counters>>}
 */
export async function countersAsync(processes) {
    if (LINUX) {
        linuxDaemon ??= startLinuxDaemon();

        return (await linuxDaemon)(processes);
    }

    const { stdout } = await execFileAsync('python3', [
        join(CPU, 'proc_usage.py'), ...Object.entries(processes).map(([label, pid]) => `${label}=${pid}`),
    ], { encoding: 'utf8' });

    return JSON.parse(stdout);
}

/**
 * @param {Counters} before
 * @param {Counters} after
 * @returns {Counters} The counts between two readings.
 */
export function difference(before, after) {
    return {
        instructions: after.instructions - before.instructions,
        cycles: after.cycles - before.cycles,
        cpuSeconds: after.cpuSeconds - before.cpuSeconds,
    };
}
