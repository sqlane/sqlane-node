// MySQL, MariaDB: the reads of the jobs blocked on a key cost a few index entries, whatever the number of blocked jobs.
// MySQL 8.4 sorts the whole key for `ORDER BY run_at, id LIMIT 1` in a correlated subquery of `jobs_blocked`, and reads
// every blocked job for `SELECT DISTINCT blocked_on`; the full index prefix (`status, blocked_on, …`) avoids both.
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createSqlane, defineConcurrencyLimit, defineJob, defineRateLimit } from '../../src/index.js';
import * as mariadbFinal from '../../src/store/mariadb_final.js';
import * as mariadbWorker from '../../src/store/mariadb_worker.js';
import * as mysqlFinal from '../../src/store/mysql_final.js';
import * as mysqlWorker from '../../src/store/mysql_worker.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

const isMysqlFamily = inject('databaseDialect') !== 'postgres';
const FINAL = inject('databaseDialect') === 'mariadb' ? mariadbFinal : mysqlFinal;
const WORKER = inject('databaseDialect') === 'mariadb' ? mariadbWorker : mysqlWorker;
const BLOCKED = 2000;
/** Index entries a read may take: the head of each key, the candidates, a few more. Far below BLOCKED. */
const FEW = 50;

const api = defineRateLimit({ name: 'api', max: 1, per: '1h' });
const one = defineConcurrencyLimit({ name: 'one', max: 1 });
const rated = defineJob({ name: 'rated', globalRateLimits: () => [api.key('x')] });
const limited = defineJob({ name: 'limited', timeout: '1m', globalConcurrencyLimits: () => [one.key('x')] });

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
/** @type {string} */
let p;

beforeAll(async () => {
    if (!isMysqlFamily) {
        return;
    }

    database = await connectTestDatabase();
    testAdapter = createTestAdapter();
    p = `${database.tablePrefix}br_`;

    const sqlane = createSqlane({ adapter: testAdapter.adapter, tablePrefix: p, jobs: [rated, limited] });
    const items = Array.from({ length: BLOCKED }, () => ({ payload: {} }));

    await sqlane.schema.migrate();
    await sqlane.enqueueMany(testAdapter.pool, rated, items);
    await sqlane.enqueueMany(testAdapter.pool, limited, items);
    await database.query(`
        UPDATE ${p}jobs SET status = 'blocked',
               blocked_on = CASE job_name WHEN 'rated' THEN '@api:x' ELSE 'one:x' END
    `);
    // A slot held: the unblock finds the key full, and writes nothing
    await database.query(`
        INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, created_at)
        VALUES ('one:x', 0, 'held', 't', UTC_TIMESTAMP(3))
    `);
    // A few due jobs for the search of candidates
    await sqlane.enqueueMany(testAdapter.pool, rated, Array.from({ length: 5 }, () => ({ payload: {} })));
    await database.query(`ANALYZE TABLE ${p}jobs`);
});

afterAll(async () => {
    await testAdapter?.close();
    await database?.close();
});

/**
 * The index entries that func reads, on one session.
 * @param {(executor: import('../../src/types.js').Executor) => Promise<unknown>} func
 * @returns {Promise<number>}
 */
async function indexReads(func) {
    return testAdapter.adapter.queueTransaction(async (executor) => {
        const reads = async () => {
            const [row] = await executor.query('SHOW SESSION STATUS LIKE \'Handler_read_next\'', []);

            return Number(row.Value);
        };
        const before = await reads();

        await func(executor);

        return await reads() - before;
    });
}

test.runIf(isMysqlFamily)('unblock of a full key with 2,000 blocked jobs: a few index entries', async () => {
    await expect(indexReads(executor => FINAL.unblock(executor, p, ['one:x']))).resolves.toBeLessThan(FEW);
});

test.runIf(isMysqlFamily)('the search of candidates with rates, behind a key with 2,000 blocked jobs: a few index entries',
    async () => {
        const reads = await indexReads(executor => WORKER.findCandidates(executor, p, new Map([['rated', 10]]), true));

        expect(reads).toBeLessThan(FEW);
    });

test.runIf(isMysqlFamily)('the sweep of the blocked keys, 2 keys of 2,000 jobs each: a few index entries', async () => {
    const reads = await indexReads(executor => FINAL.sweepSlots(executor, p, 100, {
        lingers: false,
        orphans: false,
        blocked: true,
    }));

    expect(reads).toBeLessThan(FEW);
});
