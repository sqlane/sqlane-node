import { setTimeout as sleep } from 'node:timers/promises';
import { expect } from 'vitest';
import { defineConcurrencyLimit, defineJob } from '../../../src/index.js';

/**
 * The start time of a run through an adapter: its claim writes one time to the job and to its new slots (on MySQL and
 * MariaDB, a parameter that the adapter binds). The `claimed` event, `JobInfo`, `JobRecord.startedAt` and the slot's
 * time are the same.
 * @param {import('../../../src/types.js').Sqlane<any>} sqlane Migrated, not started; its events in `events`.
 * @param {unknown} connection A connection that `enqueue` of this adapter takes, outside a transaction.
 * @param {object} tables
 * @param {string} tables.p The table prefix of the instance.
 * @param {import('../../support/test_database.js').TestDatabaseConnection} tables.database
 * @param {import('../../../src/types.js').SqlaneEvent[]} tables.events The events of the instance.
 * @returns {Promise<void>}
 */
export async function checkStartTimes(sqlane, connection, { p, database, events }) {
    const epochMs = database.family === 'postgres'
        ? (/** @type {string} */ column) => `(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`
        : (/** @type {string} */ column) => `TIMESTAMPDIFF(MICROSECOND, '1970-01-01', ${column}) DIV 1000`;
    const order = defineConcurrencyLimit({ name: 'order', max: 2 });
    const sync = defineJob({ name: 'start_check', timeout: '10s', globalConcurrencyLimits: () => [order.key(1), order] });
    /** @type {{ info: import('../../../src/types.js').JobInfo, record: any, slots: number[] }[]} */
    const runs = [];

    sqlane.handle(sync, async ({ job }) => {
        const record = await sqlane.jobs.get(job.id);
        const rows = await database.query(
            `SELECT ${epochMs('created_at')} AS ms FROM ${p}concurrency_slots WHERE job_id = ${
                database.family === 'postgres' ? '$1' : '?'}`,
            [job.id],
        );

        runs.push({ info: job, record, slots: rows.map(row => Number(row.ms)) });
    });
    await sqlane.start();

    const { id } = await sqlane.enqueue(connection, sync, {});
    const deadline = Date.now() + 5000;

    // oxlint-disable-next-line no-await-in-loop -- polls
    while (!runs.length && Date.now() < deadline) {
        // oxlint-disable-next-line no-await-in-loop -- polls
        await sleep(10);
    }

    await sqlane.close();

    const [run] = runs;
    const claimed = /** @type {any} */ (events.find(event => event.type === 'claimed' && event.jobId === id));

    expect(run?.info.id).toBe(id);
    expect(claimed.startedAt).toBeInstanceOf(Date);
    expect(run.info.startedAt).toStrictEqual(claimed.startedAt);
    expect(run.info.runAt).toStrictEqual(claimed.runAt);
    expect(run.record.startedAt).toStrictEqual(claimed.startedAt);
    expect(run.slots).toStrictEqual([Number(claimed.startedAt), Number(claimed.startedAt)]);
    expect(Number(claimed.runAt)).toBeLessThanOrEqual(Number(claimed.startedAt));
}
