// The benchmarks: `pnpm bench [--db <name>]… [--quick]`. Starts the databases in Docker (data on disk, default
// config), runs the scenarios of each one after the other, prints the results as Markdown. Not in CI: the numbers
// depend on the machine.
import { availableParallelism, cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { TEST_DATABASES } from '../test/integration/databases.js';
import { benchEnqueue, benchLatency, benchProbe, benchProcess, SIZES } from './scenarios.js';

/** @typedef {import('./scenarios.js').BenchContext} BenchContext */

/**
 * @param {number} value
 * @returns {string}
 */
function ms(value) {
    return value < 10 ? value.toFixed(2) : value.toFixed(0);
}

/**
 * @param {number} value
 * @returns {string}
 */
function rate(value) {
    return Math.round(value).toLocaleString('en-US');
}

/**
 * @param {string[]} header
 * @param {string[][]} rows
 * @returns {string}
 */
function table(header, rows) {
    return [header, header.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`).join('\n');
}

/**
 * Runs a scenario; logs its time to stderr.
 * @template T
 * @param {{ name: string }} context
 * @param {string} label
 * @param {() => Promise<T>} func
 * @returns {Promise<T>}
 */
async function step(context, label, func) {
    const startedAt = performance.now();
    const result = await func();

    console.error(`${context.name}: ${label}: ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);

    return result;
}

/**
 * @param {BenchContext & { name: string }} context
 * @returns {Promise<string>} The results, in Markdown.
 */
async function runScenarios(context) {
    const sections = [];
    const probe = await step(context, 'probe', () => benchProbe(context));

    sections.push(
        `Probe, with 1000 job names and ${rate(probe.historyRows)} completed jobs (ms):\n`,
        table(
            ['Names with pending jobs', 'p50', 'p95'],
            probe.rows.map(row => [String(row.pendingNames), ms(row.probe.p50), ms(row.probe.p95)]),
        ),
        `\nOne query per name instead (a \`UNION ALL\` of 1000), 10 names with pending jobs: p50 ${ms(probe.union.p50)} ms.`,
    );

    const latencyModes = /** @type {import('./scenarios.js').LatencyMode[]} */ ([
        { label: 'Same process', wake: 'same', gapMs: [0, 50] },
        { label: 'Other process, hint', wake: 'hint', gapMs: [0, 50] },
        ...context.dialect === 'postgres'
            ? [{ label: 'Other process, NOTIFY', wake: 'notify', gapMs: [0, 50] }]
            : [],
    ]);
    const latencies = [];

    for (const mode of latencyModes) {
        // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
        latencies.push(await step(context, `latency, ${mode.label}`, () => benchLatency(context, mode)));
    }

    sections.push(
        '\nFrom the COMMIT of the enqueue to the start of the handler, one job at a time (ms):\n',
        table(
            ['Worker', 'p50', 'p95', 'max'],
            latencies.map(({ label, latency: { p50, p95, max } }) => [label, ms(p50), ms(p95), ms(max)]),
        ),
    );

    const enqueues = [
        await step(context, 'enqueue', () => benchEnqueue(context, { label: '`enqueue`, a transaction each', batch: 1 })),
        await step(context, 'enqueueMany', () => benchEnqueue(context, { label: '`enqueueMany` of 100', batch: 100 })),
    ];
    const processModes = [
        { label: '1 process, concurrency 10', instances: 1, concurrency: 10 },
        { label: '1 process, concurrency 50', instances: 1, concurrency: 50 },
        { label: '4 processes, concurrency 10', instances: 4, concurrency: 10 },
    ];
    const processed = [];

    for (const mode of processModes) {
        // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
        processed.push(await step(context, `run, ${mode.label}`, () => benchProcess(context, mode)));
    }

    sections.push(
        '\nThroughput (jobs/s):\n',
        table(
            ['Enqueue, 8 producers', 'Jobs/s'],
            enqueues.map(({ label, jobsPerSecond }) => [label, rate(jobsPerSecond)]),
        ),
        '',
        table(
            ['Run, empty handler', 'Jobs/s'],
            processed.map(({ label, jobsPerSecond }) => [label, rate(jobsPerSecond)]),
        ),
    );

    return sections.join('\n');
}

async function main() {
    const { values } = parseArgs({
        options: {
            db: { type: 'string', multiple: true, default: TEST_DATABASES.map(({ name }) => name) },
            quick: { type: 'boolean', default: false },
        },
    });

    console.log(`Node.js ${process.version}, ${cpus()[0]?.model} (${availableParallelism()} threads), `
        + `${Math.round(totalmem() / 2 ** 30)} GiB${values.quick ? ', --quick' : ''}`);

    const databases = values.db.map((name) => {
        const database = TEST_DATABASES.find(candidate => candidate.name === name);

        if (!database) {
            throw new Error(`Unknown database: ${name}. Known: ${TEST_DATABASES.map(known => known.name).join(', ')}`);
        }

        return database;
    });
    const startedAt = performance.now();
    // Started together, before the first scenario: a start does not slow down the scenarios of another database
    const containers = await Promise.all(databases.map(database => database.start({ inMemory: false })));

    try {
        for (const [index, database] of databases.entries()) {
            let prefixCount = 0;
            // oxlint-disable-next-line no-await-in-loop -- one database at a time
            const results = await runScenarios({
                name: database.name,
                dialect: database.dialect,
                url: containers[index].getConnectionUri(),
                nextPrefix: () => `bench${++prefixCount}_`,
                sizes: values.quick ? SIZES.quick : SIZES.full,
            });

            console.log(`\n### ${database.name}\n\n${results}`);
        }
    } finally {
        await Promise.all(containers.map(container => container.stop()));
    }

    console.error(`\nDone in ${Math.round((performance.now() - startedAt) / 1000)} s`);
}

await main();
