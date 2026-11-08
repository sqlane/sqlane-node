// The benchmarks: `pnpm bench [--db <name>]… [--quick]`. Starts each database in Docker (data on disk, default
// config), runs the scenarios, prints the results as Markdown. Not in CI: the numbers depend on the machine.
import { availableParallelism, cpus, totalmem } from 'node:os';
import { parseArgs } from 'node:util';
import { TEST_DATABASES } from '../test/integration/databases.js';
import { benchEnqueue, benchLatency, benchProbe, benchProcess } from './scenarios.js';

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
 * @param {BenchContext} context
 * @returns {Promise<string>} The results, in Markdown.
 */
async function runScenarios(context) {
    const sections = [];
    const probe = await benchProbe(context);

    sections.push(
        `Probe, with 1000 job names and ${rate(probe.historyRows)} completed jobs (ms):\n`,
        table(
            ['Names with pending jobs', 'sqlane probe p50', 'p95', 'One query per name p50'],
            probe.rows.map(row => [String(row.pendingNames), ms(row.probe.p50), ms(row.probe.p95), ms(row.union.p50)]),
        ),
    );

    const latencyModes = /** @type {import('./scenarios.js').LatencyMode[]} */ ([
        { label: 'Same process', wake: 'same', gapMs: [0, 300] },
        { label: 'Other process, hint', wake: 'hint', gapMs: [0, 300] },
        ...context.dialect === 'postgres'
            ? [{ label: 'Other process, NOTIFY', wake: 'notify', gapMs: [0, 300] }]
            : [],
    ]);
    const latencies = [];

    for (const mode of latencyModes) {
        // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
        latencies.push(await benchLatency(context, mode));
    }

    sections.push(
        '\nFrom the COMMIT of the enqueue to the start of the handler, one job at a time (ms):\n',
        table(
            ['Worker', 'p50', 'p95', 'p99', 'max'],
            latencies.map(({ label, latency: { p50, p95, p99, max } }) => [label, ms(p50), ms(p95), ms(p99), ms(max)]),
        ),
    );

    const enqueues = [
        await benchEnqueue(context, { label: '`enqueue`, a transaction each', batch: 1 }),
        await benchEnqueue(context, { label: '`enqueueMany` of 100', batch: 100 }),
    ];
    const processModes = [
        { label: '1 process, concurrency 10', instances: 1, concurrency: 10 },
        { label: '1 process, concurrency 50', instances: 1, concurrency: 50 },
        { label: '4 processes, concurrency 10', instances: 4, concurrency: 10 },
    ];
    const processed = [];

    for (const mode of processModes) {
        // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
        processed.push(await benchProcess(context, mode));
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

    for (const name of values.db) {
        const database = TEST_DATABASES.find(candidate => candidate.name === name);

        if (!database) {
            throw new Error(`Unknown database: ${name}. Known: ${TEST_DATABASES.map(known => known.name).join(', ')}`);
        }

        // oxlint-disable-next-line no-await-in-loop -- one database at a time
        const container = await database.start({ inMemory: false });
        let prefixCount = 0;

        try {
            // oxlint-disable-next-line no-await-in-loop -- one database at a time
            const results = await runScenarios({
                dialect: database.dialect,
                url: container.getConnectionUri(),
                nextPrefix: () => `bench${++prefixCount}_`,
                quick: values.quick,
            });

            console.log(`\n### ${name}\n\n${results}`);
        } finally {
            // oxlint-disable-next-line no-await-in-loop -- one database at a time
            await container.stop();
        }
    }
}

await main();
