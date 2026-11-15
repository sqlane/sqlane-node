// The statement counts of the hot paths, against snapshot.json: `pnpm bench:statements[:update] [--db <name>]…
// [--runs <n>]`. Starts each supported database in a container (Testcontainers, as the integration tests), runs the
// scenarios of scenarios.mjs, and checks that the statements, the rows and the blocks of each fall in the range of
// the snapshot, with a margin. `--update` runs each scenario 10 times (or `--runs`) and keeps the range that they
// spanned: a change of a hot path updates the snapshot on purpose. Without it, one run each (CI). `--scenario` runs
// some scenarios only.
/* oxlint-disable no-await-in-loop -- one database after the other, one scenario after the other */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPool } from 'mysql2/promise';
import { Pool } from 'pg';
import { TEST_DATABASES } from '../../test/support/databases.js';
import { statsServer } from '../lib/db_stats.mjs';
import { SCENARIOS } from './scenarios.mjs';

const HERE = import.meta.dirname;
const SNAPSHOT = join(HERE, 'snapshot.json');
const { values: args } = parseArgs({
    options: {
        update: { type: 'boolean', default: false },
        db: { type: 'string', multiple: true },
        runs: { type: 'string' },
        scenario: { type: 'string', multiple: true },
    },
});
const runs = Number(args.runs ?? (args.update ? 10 : 1));
const databases = args.db ? TEST_DATABASES.filter(database => args.db?.includes(database.name)) : TEST_DATABASES;
const lib = await import('../../src/index.js');
const { pgAdapter } = await import('../../src/adapters/pg.js');
const { mysql2Adapter } = await import('../../src/adapters/mysql2.js');

/** @typedef {{ operations: number, statements: number, rows: number, blocks: number }} Counts */
/** @typedef {{ min: number, max: number }} Range */
/** @typedef {{ operations: number, statements: Range, rows: Range, blocks: Range }} Expected */

const FIELDS = /** @type {const} */ (['statements', 'rows', 'blocks']);
/**
 * The margin around the range of the snapshot. The runs of a scenario differ by the rounds of a drain that find no
 * due job, or by a schedule chunk that runs twice: the range holds that. One more statement per operation lands
 * outside it in every scenario. Rows and blocks move with the table statistics and the buffer cache more than the
 * runs of an update show: 20%; a lost index multiplies them.
 */
const MARGIN = { statements: 0.02, rows: 0.2, blocks: 0.2 };

/**
 * @param {Counts[]} results
 * @returns {Expected} The range of each field over the runs.
 */
function rangeOf(results) {
    /**
     * @param {'statements' | 'rows' | 'blocks'} field
     * @returns {Range}
     */
    const range = field => ({
        min: Math.min(...results.map(result => result[field])),
        max: Math.max(...results.map(result => result[field])),
    });

    return { operations: results[0].operations, statements: range('statements'), rows: range('rows'),
        blocks: range('blocks') };
}

/**
 * @param {Expected | undefined} expected
 * @param {Counts} actual
 * @returns {boolean} Each field lies in the range of the snapshot, with its margin.
 */
function matches(expected, actual) {
    if (!expected || expected.operations !== actual.operations) {
        return false;
    }

    return FIELDS.every(field => (
        actual[field] >= expected[field].min * (1 - MARGIN[field])
        && actual[field] <= expected[field].max * (1 + MARGIN[field])
    ));
}

/**
 * @param {import('../../test/support/databases.js').TestDatabase} database
 * @param {import('../lib/db_stats.mjs').StatsServer} stats
 * @param {string} adminUrl
 * @param {import('./scenarios.mjs').Scenario} scenario
 * @returns {Promise<{ counts: Counts, byStatement: import('../lib/db_stats.mjs').StatementStats['byStatement'] }>}
 */
async function runScenario(database, stats, adminUrl, scenario) {
    const name = `snapshot_${scenario.name}`;
    const url = await stats.createDatabase(name);
    /** @type {any} */
    const pool = database.dialect === 'postgres'
        ? new Pool({ connectionString: url, max: 5 })
        : createPool({ uri: url, connectionLimit: 5 });
    // An idle connection that the server closes emits an error on the pool: logged, as the run goes on without it
    pool.on('error', (/** @type {Error} */ error) => console.error(`${database.name} pool: ${error.message}`));

    /** @type {any} */
    const adapter = database.dialect === 'postgres'
        ? pgAdapter(pool)
        : mysql2Adapter(pool, { dialect: database.dialect });

    try {
        const { operations, stats: measured } = await scenario.run({
            lib,
            pool,
            create: options => lib.createSqlane({ adapter, ...options }),
            measure: async (func) => {
                await stats.reset(name);
                await func();

                return stats.read(name);
            },
        });
        const timing = scenario.timing;
        const counted = timing ? measured.byStatement.filter(row => !timing.test(row.text)) : measured.byStatement;
        const { byStatement } = measured;
        let statements = 0;
        let rows = 0;
        let blocks = 0;

        for (const row of counted) {
            statements += row.statements;
            rows += row.rows;
            blocks += row.blocks;
        }

        return { counts: { operations, statements, rows, blocks }, byStatement };
    } finally {
        await pool.end();
    }
}

/**
 * @param {Counts | Expected} counts
 * @returns {string} Per operation: one value, or the range of a snapshot.
 */
function perOperation(counts) {
    const per = (/** @type {number | Range} */ value) => (typeof value === 'number'
        ? (value / counts.operations).toFixed(2)
        : `${(value.min / counts.operations).toFixed(2)}–${(value.max / counts.operations).toFixed(2)}`);

    return `${per(counts.statements)} statements, ${per(counts.rows)} rows, ${per(counts.blocks)} blocks`;
}

/**
 * @param {string} label
 * @param {Expected | undefined} expected
 * @param {{ counts: Counts, byStatement: import('../lib/db_stats.mjs').StatementStats['byStatement'] }[]} results
 * @param {string} unit
 * @returns {string[]} A failure per run outside the range, with its most frequent statements.
 */
function outsideRange(label, expected, results, unit) {
    return results.filter(({ counts }) => !matches(expected, counts)).map(({ counts, byStatement }) => (
        `${label}: ${expected ? perOperation(expected) : 'none'} in the snapshot, now ${perOperation(counts)} per ${
            unit}\n${byStatement.slice(0, 15).map(row => `      ${row.statements} × ${row.text.slice(0, 140)}`).join('\n')}`
    ));
}

const saved = /** @type {Record<string, Record<string, Expected>>} */ (
    JSON.parse(readFileSync(SNAPSHOT, { encoding: 'utf8', flag: 'a+' }) || '{}')
);
/** @type {Record<string, Record<string, Expected>>} */
const current = {};
const failures = [];

for (const database of databases) {
    const startedAt = Date.now();
    const container = await database.start({ statistics: true });
    const adminUrl = container.getConnectionUri(true);
    const stats = await statsServer({ dialect: database.dialect, adminUrl });

    current[database.name] = {};

    try {
        for (const scenario of SCENARIOS.filter(each => !args.scenario || args.scenario.includes(each.name))) {
            const results = [];

            for (let run = 0; run < runs; run++) {
                results.push(await runScenario(database, stats, adminUrl, scenario));
            }

            const range = rangeOf(results.map(result => result.counts));
            const label = `${database.name} ${scenario.name}`;

            current[database.name][scenario.name] = range;

            if (!args.update) {
                failures.push(...outsideRange(label, saved[database.name]?.[scenario.name], results, scenario.unit));
            }

            console.log(`${label}: ${perOperation(range)} per ${scenario.unit}`);
        }
    } finally {
        await stats.close();
        await container.stop();
    }

    console.error(`${database.name}: ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);
}

if (args.update) {
    const merged = { ...saved };

    // Per scenario: an update of some scenarios (`--scenario`) keeps the others
    for (const [name, scenarios] of Object.entries(current)) {
        merged[name] = { ...saved[name], ...scenarios };
    }

    writeFileSync(SNAPSHOT, `${JSON.stringify(merged, null, 4)}\n`);
    console.log(`\nWrote ${SNAPSHOT}`);
}

if (failures.length) {
    console.error(`\n${failures.join('\n\n')}`);
    process.exitCode = 1;
}
