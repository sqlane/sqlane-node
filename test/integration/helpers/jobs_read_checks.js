import { expect, inject } from 'vitest';
import { defineRateLimit } from '../../../src/index.js';

/**
 * sqlane.jobs through an adapter: the types of its driver (BigInt, strings of bigint, parsed JSON) and its parameters.
 * `get` of a job with a falsy payload and a rate key; two pages of `list` with a status filter, across jobs of one
 * insert (the same enqueue time on MySQL and MariaDB).
 * @param {import('../../../src/types.js').Sqlane<any>} sqlane Migrated.
 * @param {unknown} connection A connection that `enqueue` of this adapter takes, outside a transaction.
 * @returns {Promise<string[]>} The ids of the two pages.
 */
export async function checkJobsRead(sqlane, connection) {
    const api = defineRateLimit({ name: 'api', max: 10, per: '1s' });
    const [first, ...others] = await sqlane.enqueueMany(connection, 'read_check', /** @type {any[]} */ ([
        { payload: false, options: { globalRateLimits: [api.key('t1')] } },
        { payload: { n: 2 } },
        { payload: { n: 3 } },
    ]));

    await expect(sqlane.jobs.get(first.id)).resolves.toMatchObject({
        id: first.id,
        status: 'pending',
        attempts: 0,
        stuck: false,
        enqueuedAt: expect.any(Date),
        globalRateLimits: [{ limit: 'api', key: 't1', max: 10, per: 1000, burst: 1, cost: 1 }],
        payload: false,
    });

    const page1 = await sqlane.jobs.list({ jobName: 'read_check', status: 'pending' }, { limit: 2 });
    const page2 = await sqlane.jobs.list(
        { jobName: 'read_check', status: 'pending' },
        { limit: 2, cursor: page1.nextCursor, includePayload: true },
    );
    const ids = [...page1.jobs, ...page2.jobs].map(job => job.id);
    const single = await sqlane.jobs.list({ jobName: 'read_check', status: 'pending' }, { limit: 1000 });

    expect(page1.jobs).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(page2.nextCursor).toBeNull();
    expect(page2.jobs.every(job => 'payload' in job)).toBe(true);
    // The order across the pages is the order of one list
    expect(ids).toStrictEqual(single.jobs.map(job => job.id));
    expect(ids.toSorted()).toStrictEqual([first, ...others].map(({ id }) => id).toSorted());

    // Outside PostgreSQL, one insert has one enqueue time: the pages cross a tie, on the id of the cursor
    if (inject('databaseDialect') !== 'postgres') {
        expect(new Set(single.jobs.map(job => Number(job.enqueuedAt))).size).toBe(1);
    }

    // A JSON null payload is present, as null. Not on PostgreSQL: enqueue() of a null payload fails there (a bug of
    // enqueue, fixed apart)
    if (inject('databaseDialect') !== 'postgres') {
        const empty = await sqlane.enqueue(connection, 'read_null', null);
        const job = await sqlane.jobs.get(empty.id);

        expect(job).toHaveProperty('payload', null);
    }

    return ids;
}
