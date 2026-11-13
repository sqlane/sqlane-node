// Type tests of the public API: checked by tsc (pnpm typecheck), never run.
import mysql from 'mysql2/promise';
import { Pool } from 'pg';
import { expectTypeOf } from 'vitest';
import { createSqlane, defineConcurrencyGroup, defineJob, getMigrations, RetryJobError } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';
import { pgAdapter } from '@sqlane/core/adapter-pg';

/** The type tests: never called. */
export async function publicApiTypes() {
    const mysqlPool = mysql.createPool({});
    const connection = await mysqlPool.getConnection();
    const pgPool = new Pool();
    const job = defineJob({ name: 'build_report', mutexKeys: payload => [`report:${payload.reportId}`], timeout: '1m' });
    const sqlane = createSqlane({ adapter: mysql2Adapter(mysqlPool), maxConcurrency: 10 });
    const heavy = defineConcurrencyGroup({ name: 'heavy', maxConcurrency: 2 });

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

    // MariaDB: the mysql2 adapter with its dialect
    expectTypeOf(mysql2Adapter(mysqlPool, { dialect: 'mariadb' }).dialect)
        .toEqualTypeOf(/** @type {import('@sqlane/core').Dialect} */ ('mariadb'));
    getMigrations({ dialect: 'mariadb' });
    // @ts-expect-error mysql2 is not a PostgreSQL driver
    mysql2Adapter(mysqlPool, { dialect: 'postgres' });

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

    // handle: caps, concurrency groups, weights
    sqlane.handle(job, () => {});
    sqlane.handle(job, () => {}, { concurrencyGroup: heavy, maxConcurrency: 1, fairShareWeight: 2, timeout: '5m' });
    sqlane.handle('build_report', async () => {}, { maxConcurrency: 2 });
    // @ts-expect-error lane was removed in 5.0
    sqlane.handle(job, () => {}, { lane: 'heavy' });
    // @ts-expect-error concurrency is now maxConcurrency
    sqlane.handle(job, () => {}, { concurrency: 2 });
    // @ts-expect-error a concurrency group is an object from defineConcurrencyGroup()
    sqlane.handle(job, () => {}, { concurrencyGroup: 'heavy' });
    // @ts-expect-error lanes were removed in 5.0
    createSqlane({ adapter: mysql2Adapter(mysqlPool), lanes: { heavy: { concurrency: 2 } } });
    // @ts-expect-error concurrency is now maxConcurrency
    createSqlane({ adapter: mysql2Adapter(mysqlPool), concurrency: 2 });
    expectTypeOf(heavy.maxConcurrency).toBeNumber();

    /** @type {import('@sqlane/core').HandleOptions} */
    const handleOptions = { maxConcurrency: 1, fairShareWeight: 3 };
    /** @type {import('@sqlane/core').Sqlane<import('@sqlane/core/adapter-mysql2').Mysql2Connection>} */
    const typedSqlane = sqlane;

    typedSqlane.handle('typed', () => {}, handleOptions);

    // handle: the context
    sqlane.handle(job, ({ payload: jobPayload, job: info, signal }) => {
        expectTypeOf(jobPayload).toBeAny();
        expectTypeOf(info.attempt).toBeNumber();
        expectTypeOf(info.enqueuedAt).toEqualTypeOf(new Date());
        expectTypeOf(info.mutexKeys).toEqualTypeOf(/** @type {readonly string[]} */ ([]));
        expectTypeOf(signal).toEqualTypeOf(new AbortController().signal);
    });

    // A declared payload: defineJob<P>(…) in TypeScript; in JSDoc, the type of the definition
    /** @type {import('@sqlane/core').JobDefinition<{ orderId: number, note?: string }>} */
    const syncOrder = defineJob({
        name: 'sync_order',
        mutexKeys: (order) => {
            expectTypeOf(order).toEqualTypeOf(/** @type {{ orderId: number, note?: string }} */ ({ orderId: 1 }));

            return [`order:${order.orderId}`];
        },
        timeout: '1m',
    });

    await sqlane.enqueue(connection, syncOrder, { orderId: 1 });
    await sqlane.enqueue(connection, syncOrder, { orderId: 1, note: 'n' }, { jobId: 'o1' });
    // @ts-expect-error orderId is a number
    await sqlane.enqueue(connection, syncOrder, { orderId: '1' });
    // @ts-expect-error orderId is required
    await sqlane.enqueue(connection, syncOrder, {});
    // @ts-expect-error not a field of the payload
    await sqlane.enqueue(connection, syncOrder, { orderId: 1, other: 1 });
    await sqlane.enqueueMany(connection, syncOrder, [{ payload: { orderId: 1 } }, { payload: { orderId: 2 } }]);
    // @ts-expect-error orderId is a number, in enqueueMany too
    await sqlane.enqueueMany(connection, syncOrder, [{ payload: { orderId: '1' } }]);
    sqlane.handle(syncOrder, ({ payload: order }) => {
        expectTypeOf(order.orderId).toBeNumber();
        expectTypeOf(order.note).toEqualTypeOf(/** @type {string | undefined} */ (undefined));
    });
    // By name: the payload is not known
    await sqlane.enqueue(connection, 'sync_order', { anything: true });
    sqlane.handle('sync_order', ({ payload: anything }) => {
        expectTypeOf(anything).toBeAny();
    });

    // A declared payload must be JSON
    /** @type {import('@sqlane/core').JobDefinition<{ at: Date }>} */
    const dated = defineJob({ name: 'dated' });

    // @ts-expect-error a Date is not JSON: the handler would get a string
    await sqlane.enqueue(connection, dated, { at: new Date() });

    // A declared payload with defineJob<P>: a type argument, also in JSDoc
    const typed = defineJob(/** @type {import('@sqlane/core').JobOptions<{ id: string }>} */ ({ name: 'typed' }));

    await sqlane.enqueue(connection, typed, { id: 'a' });
    // @ts-expect-error id is a string
    await sqlane.enqueue(connection, typed, { id: 1 });

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

    // A failure job: the error of the failed job, with its string `code` if it had one
    /** @type {import('@sqlane/core').FailedJobPayload} */
    const failure = { job: { id: 'a', name: 'a', payload: null, attempt: 3, maxAttempts: 3 }, error: { name: 'E', message: 'm' } };

    expectTypeOf(failure.error.code).toEqualTypeOf(/** @type {string | undefined} */ (undefined));

    // wake: no name, it probes all the handled names
    sqlane.wake();
    // @ts-expect-error wake() takes no name
    sqlane.wake('build_report');

    // schedule: a cron in a zone, or an interval; jitter on both
    sqlane.schedule(job, { cron: '0 3 * * *', timezone: 'Europe/Berlin', missed: 'skip', overlap: 'skip', jitter: '5m' });
    sqlane.schedule('build_report', { every: '15m', key: 'tenant-42', payload: { tenantId: 42 }, jitter: '1m' });
    // @ts-expect-error cron or every, not both
    sqlane.schedule(job, { cron: '* * * * *', every: '1m' });
    // @ts-expect-error a timezone is only for cron
    sqlane.schedule(job, { every: '1m', timezone: 'UTC' });
    // @ts-expect-error cron or every is required
    sqlane.schedule(job, { key: 'a' });
    // @ts-expect-error an unknown missed value
    sqlane.schedule(job, { every: '1m', missed: 'all' });
    // @ts-expect-error a payload is JSON
    sqlane.schedule(job, { every: '1m', payload: { at: new Date() } });
    sqlane.schedule(syncOrder, { every: '1h', payload: { orderId: 1 } });
    // @ts-expect-error a declared payload is required
    sqlane.schedule(syncOrder, { every: '1m' });
    // @ts-expect-error a declared payload is checked
    sqlane.schedule(syncOrder, { every: '1m', payload: { orderId: '1' } });

    // Options built apart, in a variable of the exported type
    /** @type {import('@sqlane/core').ScheduleOptions<{ orderId: number, note?: string }>} */
    const perOrder = { every: '1h', key: 'order-1', payload: { orderId: 1 } };

    sqlane.schedule(syncOrder, perOrder);
    /** @type {import('@sqlane/core').ScheduleOptions} */
    const untyped = { cron: '0 3 * * *', payload: { any: 'json' } };

    sqlane.schedule('sync_order', untyped);
    /** @type {import('@sqlane/core').ScheduleOptions<{ orderId: number }>} */
    // @ts-expect-error with a payload type, the payload is required
    const withoutPayload = { every: '1h' };

    void withoutPayload;
    /** @type {import('@sqlane/core').ScheduleOptions<{ orderId: string }>} */
    const otherPayload = { every: '1h', payload: { orderId: '1' } };

    // @ts-expect-error the payload type of the options is not the one of the definition
    sqlane.schedule(syncOrder, otherPayload);

    const [schedule] = await sqlane.getSchedules();

    expectTypeOf(schedule.nextAt).toEqualTypeOf(/** @type {Date | null} */ (null));
    expectTypeOf(schedule.nextRunAt).toEqualTypeOf(/** @type {Date | null} */ (null));
    expectTypeOf(schedule.lastJobId).toEqualTypeOf(/** @type {string | null} */ (null));

    // The slot of a job of a schedule
    sqlane.handle(job, ({ job: info }) => {
        expectTypeOf(info.scheduledAt).toEqualTypeOf(/** @type {Date | null} */ (null));
    });
    /** @type {import('@sqlane/core').JobInfo} */
    // @ts-expect-error scheduledAt is required in a context built by hand
    const builtByHand = { id: 'a', name: 'a', attempt: 1, maxAttempts: 1, enqueuedAt: new Date(), mutexKeys: [] };

    void builtByHand;

    // enqueue: a slot run by hand
    await sqlane.enqueue(connection, job, {}, { slot: { at: new Date(), key: 'tenant-42' } });
    await sqlane.enqueue(connection, job, {}, { slot: { at: new Date() }, delay: '1m' });
    // @ts-expect-error slot or jobId, not both
    await sqlane.enqueue(connection, job, {}, { slot: { at: new Date() }, jobId: 'x' });
    // @ts-expect-error slot.at is a Date
    await sqlane.enqueue(connection, job, {}, { slot: { at: '2026-01-01' } });

    // The event of a slot
    createSqlane({
        adapter: mysql2Adapter(mysqlPool),
        onEvent: (event) => {
            if (event.type === 'schedule_fired') {
                expectTypeOf(event.scheduledAt).toEqualTypeOf(new Date());
                expectTypeOf(event.jobId).toEqualTypeOf(/** @type {string | null} */ (null));
                expectTypeOf(event.late).toBeBoolean();
            }
        },
    });

    // close, drain
    await sqlane.close({ deadline: '30s', mode: 'release', exitsBy: '1m' });
    // @ts-expect-error an unknown close mode
    await sqlane.close({ mode: 'kill' });
    expectTypeOf(await sqlane.drain()).toEqualTypeOf({ completed: 0, retried: 0, failed: 0 });
}
