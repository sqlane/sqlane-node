// Runnable feature checks for docs/comparison.md: each queue library runs the same small scenarios on PostgreSQL, and
// the result of each is what the library did, not what its documentation says.
//
//   node checks.mjs <postgres admin url> [library ...]     # all libraries: see LIBRARIES
//
// Each library runs in a database of its own per check; the libraries run in parallel. Prints a JSON report and a
// Markdown table. See README.md.
/* oxlint-disable no-await-in-loop -- each check runs one step after the other */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { UnsupportedError } from './libs/common.mjs';

const HERE = import.meta.dirname;
export const LIBRARIES = ['sqlane', 'pg-boss', 'graphile-worker', 'river', 'bullmq', 'sidequest'];

/**
 * @typedef {{ result: 'yes' | 'partial' | 'no', note: string }} Outcome
 * @typedef {(context: CheckContext) => Promise<Outcome>} Check
 * @typedef {object} CheckContext
 * @property {import('./libs/common.mjs').Adapter} adapter
 * @property {string} url The database of this check.
 * @property {string} library
 */

/** @type {(ms: number) => string} */
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;

/**
 * Polls until func returns true or the time is up.
 * @param {() => boolean} func
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function until(func, timeoutMs) {
    const end = Date.now() + timeoutMs;

    while (Date.now() < end) {
        if (func()) {
            return true;
        }

        await sleep(25);
    }

    return func();
}

/**
 * @param {unknown} error
 * @returns {Outcome}
 */
function unsupported(error) {
    if (error instanceof UnsupportedError) {
        return { result: 'no', note: error.message };
    }

    throw error;
}

/**
 * Two job names, 4 jobs of 600 ms each, concurrency 4: the jobs that share a resource must not overlap, the others must
 * run in parallel.
 * @param {CheckContext} context
 * @param {[string, string, string[]][]} jobs name, id, resources
 * @returns {Promise<Outcome>}
 */
async function checkExclusion({ adapter, url }, jobs) {
    /** @type {Map<string, number>} running jobs by resource */
    const running = new Map();
    let overlaps = 0;
    let parallel = 0;
    let active = 0;
    /** @type {Set<string>} */
    const done = new Set();
    let queue;

    try {
        queue = await adapter.open({
            url,
            concurrency: 4,
            names: { charge: { exclusive: true }, refund: { exclusive: true } },
            handler: async (_name, payload) => {
                for (const resource of payload.resources) {
                    if (running.get(resource)) {
                        overlaps++;
                    }

                    running.set(resource, (running.get(resource) ?? 0) + 1);
                }

                active++;
                parallel = Math.max(parallel, active);
                await sleep(600);
                active--;

                for (const resource of payload.resources) {
                    running.set(resource, (running.get(resource) ?? 1) - 1);
                }

                done.add(payload.id);
            },
        });

        for (const [name, id, resources] of jobs) {
            await queue.enqueue(name, { id, resources });
        }

        await queue.start();
        await until(() => done.size === jobs.length, 10_000);
    } catch (error) {
        return unsupported(error);
    } finally {
        await queue?.stop();
    }

    const all = [...queue.notes, ...queue.limits ?? []];
    const notes = all.length ? `; ${all.join('; ')}` : '';

    if (done.size < jobs.length) {
        return { result: 'no', note: `only ${done.size} of ${jobs.length} jobs ran within 10 s${notes}` };
    }

    if (overlaps) {
        return { result: 'no', note: `jobs that share a resource overlapped ${overlaps} times${notes}` };
    }

    if (parallel < 2) {
        return { result: 'no', note: `no job ran in parallel${notes}` };
    }

    return { result: queue.limits?.length ? 'partial' : 'yes', note: `no overlap, the others ran in parallel${notes}` };
}

/** @type {Record<string, { title: string, check: Check }>} */
const CHECKS = {
    transaction: {
        title: 'Enqueue in the caller\'s transaction',
        async check({ adapter, url }) {
            /** @type {number[]} */
            const ran = [];
            const queue = await adapter.open({
                url,
                names: { order_created: {} },
                handler: async (_name, payload) => { ran.push(payload.order); },
            });
            const client = new Client({ connectionString: url });

            await client.connect();
            await client.query('CREATE TABLE orders (id integer PRIMARY KEY)');

            try {
                for (const [order, end] of /** @type {[number, string][]} */ ([[1, 'ROLLBACK'], [2, 'COMMIT']])) {
                    await client.query('BEGIN');
                    await client.query('INSERT INTO orders (id) VALUES ($1)', [order]);
                    await queue.enqueue('order_created', { order }, { client });
                    await client.query(end);
                }

                await queue.start();
                await until(() => ran.length >= 2, 4000);
            } finally {
                await queue.stop();
                await client.end();
            }

            const note = queue.notes.join('; ');

            if (ran.length === 1 && ran[0] === 2) {
                return { result: 'yes', note: note || 'the rolled-back job never ran, the committed one ran' };
            }

            return { result: 'no', note: `jobs that ran: ${JSON.stringify(ran)} (order 1 was rolled back)${note ? `; ${note}` : ''}` };
        },
    },
    delay: {
        title: 'Delayed job',
        async check({ adapter, url }) {
            let startedAt = 0;
            const queue = await adapter.open({
                url,
                names: { later: {} },
                handler: async () => { startedAt ||= Date.now(); },
            });

            try {
                await queue.start();

                const enqueuedAt = Date.now();

                await queue.enqueue('later', { id: 1 }, { delayMs: 2000 });
                await until(() => startedAt > 0, 8000);

                const waited = startedAt - enqueuedAt;

                if (!startedAt) {
                    return { result: 'no', note: 'did not start within 8 s' };
                }

                return waited >= 1900
                    ? { result: 'yes', note: `delay 2 s: started after ${seconds(waited)}` }
                    : { result: 'no', note: `delay 2 s: started after ${seconds(waited)}` };
            } catch (error) {
                return unsupported(error);
            } finally {
                await queue.stop();
            }
        },
    },
    retry: {
        title: 'Retry after a configured backoff',
        async check({ adapter, url }) {
            /** @type {number[]} */
            const attempts = [];
            let queue;

            try {
                queue = await adapter.open({
                    url,
                    names: { flaky: { maxAttempts: 2, backoffMs: 2000 } },
                    handler: async () => {
                        attempts.push(Date.now());

                        if (attempts.length === 1) {
                            throw new Error('first attempt fails');
                        }
                    },
                });
                await queue.start();
                await queue.enqueue('flaky', { id: 1 });
                await until(() => attempts.length >= 2, 10_000);
            } catch (error) {
                return unsupported(error);
            } finally {
                await queue?.stop();
            }

            if (attempts.length < 2) {
                return { result: 'no', note: 'no second attempt within 10 s' };
            }

            const gap = attempts[1] - attempts[0];
            const extra = [...queue.notes, ...queue.limits ?? []];
            const note = `backoff 2 s: second attempt after ${seconds(gap)}${extra.length ? `; ${extra.join('; ')}` : ''}`;

            return { result: gap >= 1800 && !queue.limits?.length ? 'yes' : 'partial', note };
        },
    },
    timeout: {
        title: 'Timeout aborts the handler',
        async check({ adapter, url }) {
            let startedAt = 0;
            let abortedAt = 0;
            let attempts = 0;
            let queue;

            try {
                queue = await adapter.open({
                    url,
                    names: { slow: { timeoutMs: 1000, maxAttempts: 2, backoffMs: 0 } },
                    handler: async (_name, _payload, signal) => {
                        attempts++;
                        startedAt ||= Date.now();
                        await new Promise((resolve) => {
                            signal?.addEventListener('abort', () => {
                                abortedAt ||= Date.now();
                                resolve(undefined);
                            });
                            setTimeout(resolve, 6000);
                        });
                    },
                });
                await queue.start();
                await queue.enqueue('slow', { id: 1 });
                await until(() => abortedAt > 0 || attempts > 1, 6000);
            } catch (error) {
                return unsupported(error);
            } finally {
                await queue?.stop();
            }

            if (abortedAt) {
                return { result: 'yes', note: `timeout 1 s: signal aborted after ${seconds(abortedAt - startedAt)}` };
            }

            return attempts > 1
                ? { result: 'partial', note: 'timeout 1 s: the job ran again, the first handler was not signalled' }
                : { result: 'no', note: 'timeout 1 s: nothing happened within 6 s' };
        },
    },
    stall: {
        title: 'Job of a killed worker runs again',
        async check({ adapter, url, library }) {
            const child = spawn(process.execPath, [join(HERE, 'check_child.mjs'), library, url], {
                stdio: ['ignore', 'pipe', 'inherit'],
            });
            const started = new Promise((resolve) => {
                child.stdout.on('data', (data) => {
                    if (String(data).includes('started')) {
                        resolve(undefined);
                    }
                });
            });

            if (!await Promise.race([started.then(() => true), sleep(15_000).then(() => false)])) {
                child.kill('SIGKILL');

                return { result: 'no', note: 'the first worker did not start the job' };
            }

            child.kill('SIGKILL');

            const killedAt = Date.now();
            let againAt = 0;
            let queue;

            try {
                queue = await adapter.open({
                    url,
                    names: { stuck: { timeoutMs: 2000, maxAttempts: 2 } },
                    stall: true,
                    handler: async () => { againAt ||= Date.now(); },
                });
                await queue.start();
                await until(() => againAt > 0, 70_000);
            } catch (error) {
                return unsupported(error);
            } finally {
                await queue?.stop();
            }

            const settings = queue.notes.join('; ');

            return againAt
                ? { result: 'yes', note: `ran again ${seconds(againAt - killedAt)} after the kill; ${settings}` }
                : { result: 'no', note: `not within 70 s; ${settings}` };
        },
    },
    exclusion: {
        title: 'Exclusion by one resource, across job names',
        check: context => checkExclusion(context, [
            ['charge', 'a', ['alice']],
            ['refund', 'b', ['alice']],
            ['charge', 'c', ['bob']],
            ['refund', 'd', ['carol']],
        ]),
    },
    exclusionMany: {
        title: 'Exclusion by several resources per job',
        check: context => checkExclusion(context, [
            ['charge', 'a', ['alice', 'bob']],
            ['refund', 'b', ['bob', 'carol']],
            ['charge', 'c', ['dave', 'erin']],
            ['refund', 'd', ['frank', 'grace']],
        ]),
    },
    priority: {
        title: 'Priority',
        async check({ adapter, url }) {
            /** @type {string[]} */
            const order = [];
            let queue;

            try {
                queue = await adapter.open({
                    url,
                    concurrency: 1,
                    names: { task: {} },
                    handler: async (_name, payload) => { order.push(payload.id); },
                });

                for (const id of ['low1', 'low2', 'low3']) {
                    await queue.enqueue('task', { id }, { priority: 'low' });
                }

                await queue.enqueue('task', { id: 'high' }, { priority: 'high' });
                await queue.start();
                await until(() => order.length === 4, 6000);
            } catch (error) {
                return unsupported(error);
            } finally {
                await queue?.stop();
            }

            const limits = queue.limits?.length ? `; ${queue.limits.join('; ')}` : '';

            return order[0] === 'high'
                ? { result: limits ? 'partial' : 'yes', note: `enqueued last, ran first${limits}` }
                : { result: 'no', note: `order: ${order.join(', ')}${limits}` };
        },
    },
};

/**
 * @param {string} adminUrl
 * @param {string} database
 * @returns {Promise<string>} The URL of a new, empty database.
 */
async function freshDatabase(adminUrl, database) {
    const admin = new Client({ connectionString: adminUrl });

    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();

    const url = new URL(adminUrl);

    url.pathname = `/${database}`;

    return url.toString();
}

/**
 * @param {string} adminUrl
 * @param {string} library
 * @returns {Promise<{ library: string, version: string, checks: Record<string, Outcome & { ms: number }> }>}
 */
async function runLibrary(adminUrl, library) {
    const { adapter } = await import(`./libs/${library.replaceAll('-', '_')}.mjs`);
    /** @type {Record<string, Outcome & { ms: number }>} */
    const checks = {};

    for (const [id, { check }] of Object.entries(CHECKS)) {
        const url = await freshDatabase(adminUrl, `check_${library.replaceAll('-', '_')}_${id}`.toLowerCase());
        const startedAt = Date.now();

        try {
            checks[id] = { ...await check({ adapter, url, library }), ms: Date.now() - startedAt };
        } catch (error) {
            checks[id] = { result: 'no', note: `error: ${error instanceof Error ? error.message : String(error)}`, ms: Date.now() - startedAt };
        }

        process.stderr.write(`${library} ${id}: ${checks[id].result} (${checks[id].note})\n`);
    }

    return { library, version: adapter.version, checks };
}

if (process.argv[1] === import.meta.filename) {
    const [adminUrl, ...only] = process.argv.slice(2);
    const libraries = only.length ? only : LIBRARIES;
    const reports = await Promise.all(libraries.map(library => runLibrary(adminUrl, library)));
    const mark = { yes: 'Yes', partial: 'Partial', no: 'No' };

    writeFileSync(join(HERE, 'checks.json'), `${JSON.stringify(reports, null, 4)}\n`);
    console.log(`| Check | ${reports.map(report => `${report.library} ${report.version}`).join(' | ')} |`);
    console.log(`| --- | ${reports.map(() => '---').join(' | ')} |`);

    for (const [id, { title }] of Object.entries(CHECKS)) {
        console.log(`| ${title} | ${reports.map(report => mark[report.checks[id].result]).join(' | ')} |`);
    }

    // The libraries can leave timers and sockets behind
    // oxlint-disable-next-line unicorn/no-process-exit -- a script
    process.exit(0);
}
