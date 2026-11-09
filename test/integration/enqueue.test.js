import { afterAll, beforeAll, expect, test } from 'vitest';
import { createSqlane, defineJob, InvalidOptionsError, UnknownJobError } from '../../src/index.js';
import { createTestAdapter } from './helpers/test_adapter.js';
import { connectTestDatabase } from '../support/test_database.js';

/** @type {Record<'mysql' | 'postgres', (p: string) => string>} */
const READ_JOB_SQL = {
    mysql: p => `
        SELECT j.id, j.job_name, j.status, j.attempts, j.max_attempts, j.stalls, j.max_stalls, j.mutex_keys,
               j.failure_job, j.completed_retention_ms, j.failed_retention_ms, j.enqueue_token, pl.payload,
               TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), j.run_at) DIV 1000 AS run_in_ms,
               TIMESTAMPDIFF(MICROSECOND, '1970-01-01', j.run_at) DIV 1000 AS run_at_ms
          FROM ${p}jobs j LEFT JOIN ${p}payloads pl ON pl.id = j.id WHERE j.id = ?`,
    postgres: p => `
        SELECT j.id, j.job_name, j.status, j.attempts, j.max_attempts, j.stalls, j.max_stalls, j.mutex_keys,
               j.failure_job, j.completed_retention_ms, j.failed_retention_ms, j.enqueue_token, pl.payload,
               (EXTRACT(EPOCH FROM j.run_at - clock_timestamp()) * 1000)::bigint AS run_in_ms,
               (EXTRACT(EPOCH FROM j.run_at) * 1000)::bigint AS run_at_ms
          FROM ${p}jobs j LEFT JOIN ${p}payloads pl ON pl.id = j.id WHERE j.id = $1`,
};

/** A session time zone far from UTC: the stored times must not depend on it. */
const SET_TIME_ZONE_SQL = {
    mysql: 'SET time_zone = \'+05:00\'',
    postgres: 'SET TIME ZONE \'Asia/Tokyo\'',
};

const buildReport = defineJob({
    name: 'build_report',
    maxAttempts: 5,
    retention: { completed: '10m' },
    mutexKeys: payload => [`report:${payload.reportId}`, 'reports'],
    failureJob: 'report_failed',
});

/** @type {import('../support/test_database.js').TestDatabaseConnection} */
let database;
/** @type {import('./helpers/test_adapter.js').TestAdapter} */
let testAdapter;
/** @type {import('../../src/types.js').Sqlane<any, never>} */
let sqlane;

beforeAll(async () => {
    database = await connectTestDatabase();
    testAdapter = createTestAdapter();
    sqlane = createSqlane({ adapter: testAdapter.adapter, tablePrefix: database.tablePrefix, jobs: [buildReport] });
    await sqlane.migrate();
});

afterAll(async () => {
    await testAdapter?.close();
    await database?.close();
});

/**
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | undefined>} The job and its payload, as the other connections see them.
 */
async function readJob(id) {
    const [row] = await database.query(READ_JOB_SQL[database.family](database.tablePrefix), [id]);

    return row && {
        ...row,
        completed_retention_ms: Number(row.completed_retention_ms),
        failed_retention_ms: Number(row.failed_retention_ms),
        run_in_ms: Number(row.run_in_ms),
        run_at_ms: Number(row.run_at_ms),
    };
}

/**
 * Runs func in a transaction of a pool connection, with a session time zone far from UTC.
 * @template T
 * @param {(connection: any) => Promise<T>} func Gets the raw connection.
 * @param {boolean} [commit] Default: true. False: rolls back.
 * @returns {Promise<T>}
 */
async function inTransaction(func, commit = true) {
    const connection = await testAdapter.connect();

    try {
        await connection.execute(SET_TIME_ZONE_SQL[database.family]);
        await connection.begin();

        const result = await func(connection.raw);

        await (commit ? connection.commit() : connection.rollback());

        return result;
    } finally {
        connection.release();
    }
}

test('adds the job in the caller\'s transaction, with the values frozen at enqueue', async () => {
    const result = await inTransaction(connection => sqlane.enqueue(connection, buildReport, { reportId: 'r1' }, {
        jobId: 'r1',
        delay: '1m',
    }));

    expect(result).toStrictEqual({ id: 'build_report:r1', created: true });

    const job = await readJob('build_report:r1');

    expect(job).toMatchObject({
        id: 'build_report:r1',
        job_name: 'build_report',
        status: 'pending',
        attempts: 0,
        max_attempts: 5,
        stalls: 0,
        max_stalls: 2,
        mutex_keys: ['report:r1', 'reports'],
        failure_job: 'report_failed',
        completed_retention_ms: 600_000,
        failed_retention_ms: 2_592_000_000,
        payload: { reportId: 'r1' },
    });
    expect(job?.run_in_ms).toBeGreaterThan(55_000);
    expect(job?.run_in_ms).toBeLessThanOrEqual(60_000);
});

test('a rollback adds no job', async () => {
    await inTransaction(connection => sqlane.enqueue(connection, buildReport, { reportId: 'r2' }, { jobId: 'r2' }), false);

    await expect(readJob('build_report:r2')).resolves.toBeUndefined();
});

test('a jobId adds one job while its row exists: a duplicate changes nothing', async () => {
    const first = await sqlane.enqueue(testAdapter.pool, buildReport, { reportId: 'r3' }, { jobId: 'r3' });
    const second = await sqlane.enqueue(testAdapter.pool, buildReport, { reportId: 'other' }, {
        jobId: 'r3',
        mutexKeys: ['other'],
    });

    expect([first, second]).toStrictEqual([
        { id: 'build_report:r3', created: true },
        { id: 'build_report:r3', created: false },
    ]);
    await expect(readJob('build_report:r3')).resolves.toMatchObject({
        payload: { reportId: 'r3' },
        mutex_keys: ['report:r3', 'reports'],
    });
});

test('a duplicate in a concurrent transaction waits for it, then is not created', async () => {
    const first = await testAdapter.connect();
    const second = await testAdapter.connect();

    try {
        await first.begin();
        await second.begin();
        await sqlane.enqueue(first.raw, buildReport, { reportId: 'first' }, { jobId: 'r4' });

        const secondEnqueue = sqlane.enqueue(second.raw, buildReport, { reportId: 'second' }, { jobId: 'r4' });

        await first.commit();

        await expect(secondEnqueue).resolves.toStrictEqual({ id: 'build_report:r4', created: false });
        await second.commit();
    } finally {
        first.release();
        second.release();
    }

    await expect(readJob('build_report:r4')).resolves.toMatchObject({ payload: { reportId: 'first' } });
});

test('a runAt is stored as that instant, whatever the session time zone', async () => {
    const runAt = new Date('2031-03-04T05:06:07.089Z');
    const { id } = await inTransaction(connection => sqlane.enqueue(connection, 'build_report', { reportId: 'r5' }, {
        runAt,
    }));

    await expect(readJob(id)).resolves.toMatchObject({ run_at_ms: runAt.getTime() });
});

test('enqueueMany: the results in the order of the items; a jobId repeated in the call is added once', async () => {
    const items = [
        { payload: { reportId: 'm1' }, options: { jobId: 'm1' } },
        { payload: { reportId: 'm2' }, options: { jobId: 'm2' } },
        { payload: { reportId: 'again' }, options: { jobId: 'm1' } },
        { payload: { reportId: 'none' } },
    ];
    const results = await inTransaction(connection => sqlane.enqueueMany(connection, buildReport, items));

    expect(results.map(result => result.created)).toStrictEqual([true, true, false, true]);
    expect(results.slice(0, 3).map(result => result.id))
        .toStrictEqual(['build_report:m1', 'build_report:m2', 'build_report:m1']);
    await expect(readJob('build_report:m1')).resolves.toMatchObject({ payload: { reportId: 'm1' } });
    await expect(readJob(results[3].id)).resolves.toMatchObject({ payload: { reportId: 'none' } });
});

test('enqueueMany adds 1,200 jobs at once', async () => {
    const items = Array.from({ length: 1200 }, (_, index) => ({ payload: { index }, options: { jobId: `bulk-${index}` } }));
    const results = await sqlane.enqueueMany(testAdapter.pool, 'send_email', items);

    expect(results.filter(result => result.created)).toHaveLength(1200);

    const [{ count }] = await database.query(
        `SELECT COUNT(*) AS count FROM ${database.tablePrefix}jobs WHERE job_name = 'send_email'`,
    );

    expect(Number(count)).toBe(1200);
});

test('a bad item adds no job of the call', async () => {
    const items = [
        { payload: { reportId: 'b1' }, options: { jobId: 'b1' } },
        { payload: { reportId: 'b2' }, options: { jobId: 'b2', delay: 'soon' } },
    ];

    await expect(sqlane.enqueueMany(testAdapter.pool, buildReport, items)).rejects.toThrow(InvalidOptionsError);
    await expect(readJob('build_report:b1')).resolves.toBeUndefined();
});

test('unknownJobs: reject: an unknown name throws, a name of "jobs" passes', async () => {
    const strict = createSqlane({
        adapter: testAdapter.adapter,
        tablePrefix: database.tablePrefix,
        jobs: [buildReport],
        unknownJobs: 'reject',
    });

    await expect(strict.enqueue(testAdapter.pool, 'not_registered', {})).rejects.toThrow(UnknownJobError);
    await expect(strict.enqueue(testAdapter.pool, 'build_report', { reportId: 'u1' }))
        .resolves.toMatchObject({ created: true });
});
