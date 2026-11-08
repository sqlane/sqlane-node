// Type tests of the public API: checked by tsc (pnpm typecheck), never run.
import mysql from 'mysql2/promise';
import { Pool } from 'pg';
import { expectTypeOf } from 'vitest';
import { createSqlane, defineJob, RetryJobError } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';
import { pgAdapter } from '@sqlane/core/adapter-pg';

/** The type tests: never called. */
export async function publicApiTypes() {
    const mysqlPool = mysql.createPool({});
    const connection = await mysqlPool.getConnection();
    const pgPool = new Pool();
    const job = defineJob({ name: 'build_report', mutexKeys: payload => [`report:${payload.reportId}`], timeout: '1m' });
    const sqlane = createSqlane({ adapter: mysql2Adapter(mysqlPool), lanes: { heavy: { concurrency: 2 } } });

    // enqueue: the result
    expectTypeOf(await sqlane.enqueue(connection, job, { reportId: 'r1' }))
        .toEqualTypeOf(/** @type {{ id: string, created: boolean }} */ ({ id: '', created: true }));
    expectTypeOf(await sqlane.enqueueMany(mysqlPool, job, [{ payload: { a: 1 } }]))
        .toEqualTypeOf(/** @type {import('@sqlane/core').EnqueueResult[]} */ ([]));

    // enqueue: the connections of the adapter
    await sqlane.enqueue(mysqlPool, job, {});
    await sqlane.enqueue(connection, 'build_report', {});
    // @ts-expect-error a pg client is not a connection of the mysql2 adapter
    await sqlane.enqueue(await pgPool.connect(), job, {});

    const pgSqlane = createSqlane({ adapter: pgAdapter(pgPool, { notify: true }) });

    await pgSqlane.enqueue(await pgPool.connect(), job, {});
    // @ts-expect-error a mysql2 connection is not a connection of the pg adapter
    await pgSqlane.enqueue(connection, job, {});

    // enqueue: JSON payloads
    /**
     * @typedef {{ reportId: string, note?: string, tags: readonly string[], nested: { at: number | null } }} Payload
     */
    /** @type {Payload} */
    const payload = { reportId: 'r1', tags: [], nested: { at: null } };

    await sqlane.enqueue(connection, job, payload); // an interface with optional fields
    // @ts-expect-error a Date is not JSON
    await sqlane.enqueue(connection, job, { at: new Date() });
    // @ts-expect-error a Map is not JSON
    await sqlane.enqueue(connection, job, { ids: new Map() });
    // @ts-expect-error a function is not JSON
    await sqlane.enqueue(connection, job, { callback: () => 1 });
    // @ts-expect-error a bigint is not JSON
    await sqlane.enqueue(connection, job, { id: 1n });
    // @ts-expect-error a Date in an array is not JSON
    await sqlane.enqueue(connection, job, { dates: [new Date()] });
    await sqlane.enqueueMany(connection, job, [{ payload: { a: 1 } }, { payload: { a: 2 }, options: { jobId: 'a2' } }]);
    // @ts-expect-error a Date is not JSON, in enqueueMany too
    await sqlane.enqueueMany(connection, job, [{ payload: { at: new Date() } }]);

    // enqueue: the options
    await sqlane.enqueue(connection, job, {}, { jobId: 'r1', delay: '10s', maxAttempts: 5, mutexKeys: ['a'] });
    await sqlane.enqueue(connection, job, {}, { runAt: new Date() });
    // @ts-expect-error delay or runAt, not both
    await sqlane.enqueue(connection, job, {}, { delay: '1s', runAt: new Date() });
    // @ts-expect-error jobId is a string
    await sqlane.enqueue(connection, job, {}, { jobId: 42 });

    // handle: lanes
    sqlane.handle(job, () => {});
    sqlane.handle(job, () => {}, { lane: 'heavy', timeout: '5m' });
    sqlane.handle('build_report', async () => {}, { concurrency: 2 });
    // @ts-expect-error an unknown lane
    sqlane.handle(job, () => {}, { lane: 'light' });
    // @ts-expect-error a lane or a concurrency, not both
    sqlane.handle(job, () => {}, { lane: 'heavy', concurrency: 2 });
    // @ts-expect-error no lanes in this instance
    pgSqlane.handle(job, () => {}, { lane: 'heavy' });

    // handle: the context
    sqlane.handle(job, ({ payload: jobPayload, job: info, signal }) => {
        expectTypeOf(jobPayload).toBeAny();
        expectTypeOf(info.attempt).toBeNumber();
        expectTypeOf(info.enqueuedAt).toEqualTypeOf(new Date());
        expectTypeOf(info.mutexKeys).toEqualTypeOf(/** @type {readonly string[]} */ ([]));
        expectTypeOf(signal).toEqualTypeOf(new AbortController().signal);
    });

    // defineJob
    // @ts-expect-error the name is required
    defineJob({ maxAttempts: 3 });
    // @ts-expect-error an unknown backoff type
    defineJob({ name: 'a', backoff: { type: 'linear', delay: '1s' } });
    // @ts-expect-error mutexKeys returns strings
    defineJob({ name: 'a', mutexKeys: () => [1] });
    expectTypeOf(job.name).toBeString();

    // errors
    // @ts-expect-error RetryJobError needs a delay
    const error = new RetryJobError('rate limited', {});
    void error;
    expectTypeOf(new RetryJobError('rate limited', { delay: '1m' }).code).toBeString();

    // createSqlane: the options
    // @ts-expect-error the adapter is required
    createSqlane({});
    // @ts-expect-error an unknown unknownJobs value
    createSqlane({ adapter: mysql2Adapter(mysqlPool), unknownJobs: 'warn' });
    createSqlane({
        adapter: mysql2Adapter(mysqlPool),
        onEvent: (event) => {
            if (event.type === 'retried') {
                expectTypeOf(event.delayMs).toBeNumber();
            }

            if (event.type === 'error') {
                expectTypeOf(event.operation).toBeString();
            }
        },
    });

    // close, drain
    await sqlane.close({ deadline: '30s', mode: 'release', exitsBy: '1m' });
    // @ts-expect-error an unknown close mode
    await sqlane.close({ mode: 'kill' });
    expectTypeOf(await sqlane.drain()).toEqualTypeOf({ completed: 0, retried: 0, failed: 0 });
}
