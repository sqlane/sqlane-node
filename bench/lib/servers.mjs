// PostgreSQL, MySQL, MariaDB and Redis of this host, started from their binaries with the data in a temporary
// directory: default configurations, TCP on 127.0.0.1 only (Unix sockets in a long temporary path exceed the 104-byte
// limit of macOS). The statement statistics are on (db_stats.mjs): pg_stat_statements on PostgreSQL,
// performance_schema on MySQL and MariaDB. MariaDB gets the binary log of MySQL 8.4, as in the other benchmarks.
/* oxlint-disable no-await-in-loop -- the tries of a connection go one after the other */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createConnection } from 'mysql2/promise';
import { Client } from 'pg';

const execFileAsync = promisify(execFile);

/**
 * @typedef {object} Server
 * @property {string} url A connection to its default database: `postgres` (PostgreSQL), `bench` (MySQL, MariaDB).
 * @property {string} adminUrl A superuser connection: `postgres` (PostgreSQL), `admin` with all privileges (MySQL,
 *     MariaDB), no database chosen on MySQL and MariaDB.
 * @property {number} pid The server process: its backends (PostgreSQL) are its descendants.
 * @property {() => Promise<void>} stop Stops the server and removes its data.
 * @property {() => void} kill Stops it at once, synchronously: for an exit handler.
 */

/**
 * @typedef {object} ServerOptions
 * @property {string} bin The directory of the server binaries.
 * @property {number} [port]
 * @property {string} [dir] The parent directory of its data. Default: a new temporary directory.
 */

/**
 * @typedef {object} PostgresOptions
 * @property {string} [template] A data directory of initdb (postgresTemplate()) to clone instead of running initdb.
 * @property {number} [connections] max_connections. Default: PostgreSQL's, 100.
 */

/**
 * @param {'postgres' | 'mysql' | 'mariadb'} dialect
 * @param {ServerOptions} options
 * @returns {Promise<Server>}
 */
export function startServer(dialect, options) {
    return dialect === 'postgres' ? startPostgres(options) : startMysqlFamily(dialect, options);
}

/**
 * An initialized data directory, for the template of startPostgres(): a copy is faster than initdb.
 * @param {{ bin: string, dir: string }} options dir: the parent directory.
 * @returns {string} The data directory.
 */
export function postgresTemplate({ bin, dir }) {
    const data = join(dir, 'pg-template');

    execFileSync(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });

    return data;
}

/**
 * PostgreSQL with pg_stat_statements (top-level statements).
 * @param {ServerOptions & PostgresOptions} options
 * @returns {Promise<Server>}
 */
export async function startPostgres({
    bin, port = 55_470, dir = mkdtempSync(join(tmpdir(), 'sqlane-pg-')), template, connections,
}) {
    const data = join(dir, `pg-${port}`);

    if (template) {
        // A clone on APFS: instant; on Linux, a reflink where the file system has them
        await execFileAsync('cp', process.platform === 'linux'
            ? ['-a', '--reflink=auto', template, data]
            : ['-c', '-R', template, data]);
    } else {
        execFileSync(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
    }

    await execFileAsync(join(bin, 'pg_ctl'), ['-D', data, '-l', join(dir, `pg-${port}.log`), '-w', 'start', '-o', [
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`,
        '-c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=top',
        ...connections ? [`-c max_connections=${connections}`] : [],
    ].join(' ')]);

    const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    const admin = new Client({ connectionString: url });

    await admin.connect();
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    await admin.end();

    let stopped = false;

    return {
        url,
        adminUrl: url,
        pid: Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]),
        async stop() {
            if (!stopped) {
                stopped = true;
                await execFileAsync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']);
                rmSync(data, { recursive: true, force: true });
            }
        },
        kill() {
            if (!stopped) {
                stopped = true;
                execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
            }
        },
    };
}

/** @type {Promise<void>} The installations of MySQL and MariaDB data directories, one after the other */
let installs = Promise.resolve();

/**
 * @param {ServerOptions} options
 * @returns {Promise<Server>}
 */
export function startMysql(options) {
    return startMysqlFamily('mysql', options);
}

/**
 * @param {ServerOptions} options
 * @returns {Promise<Server>}
 */
export function startMariadb(options) {
    return startMysqlFamily('mariadb', options);
}

/**
 * MySQL or MariaDB, with performance_schema. A `bench` user and database, and an `admin` user with all privileges and
 * the grant option: root of MariaDB authenticates by Unix socket, and its `localhost` matches TCP from 127.0.0.1.
 * @param {'mysql' | 'mariadb'} dialect
 * @param {ServerOptions} options
 * @returns {Promise<Server>}
 */
async function startMysqlFamily(dialect, {
    bin, port = dialect === 'mysql' ? 53_470 : 53_471, dir = mkdtempSync(join(tmpdir(), `sqlane-${dialect}-`)),
}) {
    const name = `${dialect}-${port}`;
    const data = join(dir, name);
    const initFile = join(dir, `${name}-init.sql`);
    // A temporary directory of its own: the servers name their temporary tables after their process ids
    const temporary = `${data}-tmp`;

    writeFileSync(initFile, `CREATE DATABASE IF NOT EXISTS bench;
CREATE USER IF NOT EXISTS 'bench'@'127.0.0.1';
GRANT ALL ON *.* TO 'bench'@'127.0.0.1';
CREATE USER IF NOT EXISTS 'admin'@'127.0.0.1';
GRANT ALL ON *.* TO 'admin'@'127.0.0.1' WITH GRANT OPTION;
`);
    mkdirSync(temporary, { recursive: true });

    // One installation at a time: parallel ones share temporary tables in the system's temporary directory
    const previous = installs;
    /** @type {PromiseWithResolvers<void>} */
    const { promise, resolve: done } = Promise.withResolvers();

    installs = promise;

    try {
        await previous;

        if (dialect === 'mysql') {
            await execFileAsync(join(bin, 'mysqld'), [
                '--no-defaults', '--initialize-insecure', `--datadir=${data}`, `--tmpdir=${temporary}`,
            ]);
        } else {
            await execFileAsync(join(bin, 'mariadb-install-db'), [
                '--no-defaults', `--datadir=${data}`, '--skip-test-db',
            ], { env: { PATH: process.env.PATH, TMPDIR: temporary } }); // oxlint-disable-line node/no-process-env
        }
    } finally {
        done();
    }

    const server = spawn(join(bin, dialect === 'mysql' ? 'mysqld' : 'mariadbd'), [
        '--no-defaults', `--datadir=${data}`, `--port=${port}`, '--bind-address=127.0.0.1', `--socket=${name}.sock`,
        `--tmpdir=${temporary}`, `--log-error=${join(dir, `${name}.err`)}`, `--init-file=${initFile}`,
        ...dialect === 'mysql'
            ? ['--mysqlx=OFF']
            : ['--performance-schema=ON', '--log-bin=binlog', '--sync-binlog=1', '--binlog-format=ROW'],
    ], { cwd: dir, stdio: 'ignore' });
    /** @type {Promise<void>} */
    const exited = new Promise((resolve) => {
        server.on('exit', () => resolve());
    });

    const url = `mysql://bench@127.0.0.1:${port}/bench`;

    for (let tries = 0; ; tries++) {
        try {
            await (await createConnection({ uri: url })).end();
            break;
        } catch (error) {
            if (tries > 240 || server.exitCode !== null) {
                server.kill('SIGKILL');
                throw new Error(`${dialect} did not start: see ${join(dir, `${name}.err`)}`, { cause: error });
            }

            await sleep(250);
        }
    }

    let stopped = false;

    return {
        url,
        adminUrl: `mysql://admin@127.0.0.1:${port}/`,
        pid: /** @type {number} */ (server.pid),
        async stop() {
            if (!stopped) {
                stopped = true;
                server.kill('SIGTERM');
                await exited;
                rmSync(data, { recursive: true, force: true });
                rmSync(temporary, { recursive: true, force: true });
            }
        },
        kill() {
            if (!stopped) {
                stopped = true;
                server.kill('SIGKILL');
            }
        },
    };
}

/**
 * Redis: the append-only file synced every second (its documented durable setting), no snapshots.
 * @param {ServerOptions} options bin: the directory of redis-server and redis-cli.
 * @returns {Promise<Server>} url and adminUrl: the same `redis://` URL.
 */
export async function startRedis({ bin, port = 56_470, dir = mkdtempSync(join(tmpdir(), 'sqlane-redis-')) }) {
    const data = join(dir, `redis-${port}`);

    mkdirSync(data, { recursive: true });

    const server = spawn(join(bin, 'redis-server'), [
        '--port', String(port), '--bind', '127.0.0.1', '--dir', data, '--save', '', '--appendonly', 'yes',
        '--appendfsync', 'everysec', '--protected-mode', 'yes', '--logfile', join(data, 'redis.log'),
    ], { stdio: 'ignore' });
    /** @type {Promise<void>} */
    const exited = new Promise((resolve) => {
        server.on('exit', () => resolve());
    });

    for (let tries = 0; ; tries++) {
        try {
            await execFileAsync(join(bin, 'redis-cli'), ['-p', String(port), 'PING']);
            break;
        } catch (error) {
            if (tries > 120 || server.exitCode !== null) {
                server.kill('SIGKILL');
                throw new Error(`redis did not start: see ${join(data, 'redis.log')}`, { cause: error });
            }

            await sleep(250);
        }
    }

    const url = `redis://127.0.0.1:${port}`;
    let stopped = false;

    return {
        url,
        adminUrl: url,
        pid: /** @type {number} */ (server.pid),
        async stop() {
            if (!stopped) {
                stopped = true;
                server.kill('SIGTERM');
                await exited;
                rmSync(data, { recursive: true, force: true });
            }
        },
        kill() {
            if (!stopped) {
                stopped = true;
                server.kill('SIGKILL');
            }
        },
    };
}
