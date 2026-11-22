// Type tests of the public API: checked by tsc (pnpm typecheck), never run.
import mysql from 'mysql2/promise';
import { Pool } from 'pg';
import { expectTypeOf } from 'vitest';
import {
    createSqlane,
    defineConcurrencyLimit,
    defineJob,
    defineRateLimit,
    IgnoredJobsError,
    JobCancelledError,
    RateLimitedError,
    RetryJobError,
} from '@sqlane/core';
import knex from 'knex';
import { drizzleAdapter } from '@sqlane/core/adapter-drizzle';
import { knexAdapter } from '@sqlane/core/adapter-knex';
import { kyselyAdapter } from '@sqlane/core/adapter-kysely';
import { mikroOrmAdapter } from '@sqlane/core/adapter-mikro-orm';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';
import { pgAdapter } from '@sqlane/core/adapter-pg';
import { postgresJsAdapter } from '@sqlane/core/adapter-postgres-js';
import { prismaAdapter } from '@sqlane/core/adapter-prisma';
import { sequelizeAdapter } from '@sqlane/core/adapter-sequelize';
import { typeOrmAdapter } from '@sqlane/core/adapter-typeorm';

/**
 * @returns {Promise<any>} A method of a mock.
 */
async function anyMethod() {
    return null;
}

/** The type tests: never called. */
export async function publicApiTypes() {
    const mysqlPool = mysql.createPool({});
    const connection = await mysqlPool.getConnection();
    const pgPool = new Pool();
    const heavy = defineConcurrencyLimit({ name: 'heavy', max: 2 });
    const job = defineJob({
        name: 'build_report',
        globalConcurrencyLimits: ({ payload }) => [heavy.key(payload.reportId)],
        timeout: '1m',
        fairShareWeight: 2,
        localConcurrencyLimits: [heavy],
    });
    const sqlane = createSqlane({ adapter: mysql2Adapter(mysqlPool, { dialect: 'mysql' }), localMaxConcurrency: 10 });

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

    const pgSqlane = createSqlane({ adapter: pgAdapter(pgPool, { dialect: 'postgres', notify: true }) });

    // MariaDB: the mysql2 adapter with its dialect
    expectTypeOf(mysql2Adapter(mysqlPool, { dialect: 'mariadb' }).dialect)
        .toEqualTypeOf(/** @type {import('@sqlane/core').Dialect} */ ('mariadb'));
    // @ts-expect-error mysql2 is not a PostgreSQL driver
    mysql2Adapter(mysqlPool, { dialect: 'postgres' });

    // schema.migrate: up to a version, or every migration
    expectTypeOf(await sqlane.schema.migrate({ targetVersion: '7.1.0', lockTimeout: '10s' }))
        .toEqualTypeOf(/** @type {{ applied: string[] }} */ ({ applied: [] }));
    await sqlane.schema.migrate();
    expectTypeOf(await sqlane.schema.rollback({ targetVersion: '7.0.0', lockTimeout: '10s' }))
        .toEqualTypeOf(/** @type {{ reverted: string[] }} */ ({ reverted: [] }));
    // @ts-expect-error rollback needs a target
    await sqlane.schema.rollback({});
    // @ts-expect-error migrate() is now schema.migrate()
    await sqlane.migrate();

    await pgSqlane.enqueue(await pgPool.connect(), job, {});
    // @ts-expect-error a mysql2 connection is not a connection of the pg adapter
    await pgSqlane.enqueue(connection, job, {});

    // Named prepared statements: opt-in for knex, Sequelize and MikroORM (PostgreSQL)
    const pgKnex = knex({ client: 'pg' });
    const sequelize = /** @type {Parameters<typeof sequelizeAdapter>[0]} */ (/** @type {unknown} */ ({}));
    const em = /** @type {Parameters<typeof mikroOrmAdapter>[0]} */ (/** @type {unknown} */ ({}));

    pgAdapter(pgPool, { dialect: 'postgres', prepare: false });
    knexAdapter(pgKnex, { dialect: 'postgres', prepare: true });
    sequelizeAdapter(sequelize, { dialect: 'postgres', prepare: true });
    mikroOrmAdapter(em, { dialect: 'postgres', prepare: true });
    // @ts-expect-error prepare is a boolean
    knexAdapter(pgKnex, { dialect: 'postgres', prepare: 'yes' });
    // @ts-expect-error prepare is a boolean
    sequelizeAdapter(sequelize, { dialect: 'postgres', prepare: 1 });

    // The dialect: required on every adapter, one of the dialects of the adapter
    const sql = /** @type {Parameters<typeof postgresJsAdapter>[0]} */ (/** @type {unknown} */ ({}));
    const kysely = /** @type {Parameters<typeof kyselyAdapter>[0]} */ (/** @type {unknown} */ ({}));
    const drizzle = /** @type {Parameters<typeof drizzleAdapter>[0]} */ (/** @type {unknown} */ ({}));
    const prisma = /** @type {Parameters<typeof prismaAdapter>[0]} */ (/** @type {unknown} */ ({}));
    const dataSource = {};

    mysql2Adapter(mysqlPool, { dialect: 'mysql' });
    postgresJsAdapter(sql, { dialect: 'postgres', notify: true });
    knexAdapter(pgKnex, { dialect: 'mariadb' });
    kyselyAdapter(kysely, { dialect: 'mysql' });
    drizzleAdapter(drizzle, { dialect: 'mariadb' });
    prismaAdapter(prisma, { dialect: 'postgres' });
    sequelizeAdapter(sequelize, { dialect: 'mysql' });
    typeOrmAdapter(dataSource, { dialect: 'mariadb' });
    mikroOrmAdapter(em, { dialect: 'mysql' });
    // @ts-expect-error the options are required
    mysql2Adapter(mysqlPool);
    // @ts-expect-error the options are required
    pgAdapter(pgPool);
    // @ts-expect-error the options are required
    postgresJsAdapter(sql);
    // @ts-expect-error the options are required
    knexAdapter(pgKnex);
    // @ts-expect-error the options are required
    kyselyAdapter(kysely);
    // @ts-expect-error the options are required
    drizzleAdapter(drizzle);
    // @ts-expect-error the options are required
    prismaAdapter(prisma);
    // @ts-expect-error the options are required
    sequelizeAdapter(sequelize);
    // @ts-expect-error the options are required
    typeOrmAdapter(dataSource);
    // @ts-expect-error the options are required
    mikroOrmAdapter(em);
    // @ts-expect-error the dialect is required
    pgAdapter(pgPool, { notify: true });
    // @ts-expect-error the dialect is required
    postgresJsAdapter(sql, { notify: true });
    // @ts-expect-error the dialect is required
    knexAdapter(pgKnex, { prepare: true });
    // @ts-expect-error the dialect is required
    kyselyAdapter(kysely, {});
    // @ts-expect-error the dialect is required
    drizzleAdapter(drizzle, { notify: true });
    // @ts-expect-error the dialect is required
    prismaAdapter(prisma, {});
    // @ts-expect-error the dialect is required
    sequelizeAdapter(sequelize, { prepare: true });
    // @ts-expect-error the dialect is required
    typeOrmAdapter(dataSource, {});
    // @ts-expect-error the dialect is required
    mikroOrmAdapter(em, { prepare: true });
    // @ts-expect-error pg is a PostgreSQL driver
    pgAdapter(pgPool, { dialect: 'mysql' });
    // @ts-expect-error postgres.js is a PostgreSQL driver
    postgresJsAdapter(sql, { dialect: 'mariadb' });
    // @ts-expect-error no aliases: 'postgres'
    knexAdapter(pgKnex, { dialect: 'postgresql' });
    // @ts-expect-error no aliases: 'postgres'
    prismaAdapter(prisma, { dialect: 'postgresql' });
    // @ts-expect-error not a dialect of sqlane
    kyselyAdapter(kysely, { dialect: 'sqlite' });

    // allowUnsupportedDbVersion: a boolean, on every adapter
    expectTypeOf(pgAdapter(pgPool, { dialect: 'postgres', allowUnsupportedDbVersion: true }).allowUnsupportedDbVersion)
        .toEqualTypeOf(/** @type {boolean | undefined} */ (true));
    mysql2Adapter(mysqlPool, { dialect: 'mysql', allowUnsupportedDbVersion: true });
    postgresJsAdapter(sql, { dialect: 'postgres', allowUnsupportedDbVersion: true });
    knexAdapter(pgKnex, { dialect: 'postgres', allowUnsupportedDbVersion: true });
    kyselyAdapter(kysely, { dialect: 'postgres', allowUnsupportedDbVersion: true });
    drizzleAdapter(drizzle, { dialect: 'postgres', allowUnsupportedDbVersion: true });
    prismaAdapter(prisma, { dialect: 'postgres', allowUnsupportedDbVersion: true });
    sequelizeAdapter(sequelize, { dialect: 'postgres', allowUnsupportedDbVersion: true });
    typeOrmAdapter(dataSource, { dialect: 'postgres', allowUnsupportedDbVersion: true });
    mikroOrmAdapter(em, { dialect: 'postgres', allowUnsupportedDbVersion: true });
    // @ts-expect-error allowUnsupportedDbVersion is a boolean
    mysql2Adapter(mysqlPool, { dialect: 'mysql', allowUnsupportedDbVersion: 'yes' });

    // allowUnsupportedDbConfiguration: a boolean, on every adapter
    expectTypeOf(mysql2Adapter(mysqlPool, { dialect: 'mysql', allowUnsupportedDbConfiguration: true })
        .allowUnsupportedDbConfiguration).toEqualTypeOf(/** @type {boolean | undefined} */ (true));
    pgAdapter(pgPool, { dialect: 'postgres', allowUnsupportedDbConfiguration: true });
    postgresJsAdapter(sql, { dialect: 'postgres', allowUnsupportedDbConfiguration: true });
    knexAdapter(pgKnex, { dialect: 'postgres', allowUnsupportedDbConfiguration: true });
    kyselyAdapter(kysely, { dialect: 'mysql', allowUnsupportedDbConfiguration: true });
    drizzleAdapter(drizzle, { dialect: 'mysql', allowUnsupportedDbConfiguration: true });
    prismaAdapter(prisma, { dialect: 'mariadb', allowUnsupportedDbConfiguration: true });
    sequelizeAdapter(sequelize, { dialect: 'mysql', allowUnsupportedDbConfiguration: true });
    typeOrmAdapter(dataSource, { dialect: 'mysql', allowUnsupportedDbConfiguration: true });
    mikroOrmAdapter(em, { dialect: 'mariadb', allowUnsupportedDbVersion: true, allowUnsupportedDbConfiguration: true });
    // @ts-expect-error allowUnsupportedDbConfiguration is a boolean
    mysql2Adapter(mysqlPool, { dialect: 'mysql', allowUnsupportedDbConfiguration: 'yes' });

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
    await sqlane.enqueue(connection, job, {}, {
        jobId: 'r1',
        delay: '10s',
        maxAttempts: 5,
        globalConcurrencyLimits: [heavy, heavy.key('a'), heavy.key(1)],
    });
    // @ts-expect-error a global limit is a limit or its key, not a string
    await sqlane.enqueue(connection, job, {}, { globalConcurrencyLimits: ['heavy:a'] });
    await sqlane.enqueue(connection, job, {}, { runAt: new Date() });
    // @ts-expect-error delay or runAt, not both
    await sqlane.enqueue(connection, job, {}, { delay: '1s', runAt: new Date() });
    // @ts-expect-error jobId is a string
    await sqlane.enqueue(connection, job, {}, { jobId: 42 });

    // handle: no options; local limits and weights are in the definition
    sqlane.handle(job, () => {});
    sqlane.handle('build_report', async () => {});
    // @ts-expect-error the options of 5.x moved to defineJob()
    sqlane.handle(job, () => {}, { maxConcurrency: 1 });
    // @ts-expect-error a local limit is an object from defineConcurrencyLimit()
    defineJob({ name: 'a', localConcurrencyLimits: ['heavy'] });
    // @ts-expect-error lanes were removed in 5.0
    createSqlane({ adapter: mysql2Adapter(mysqlPool, { dialect: 'mysql' }), lanes: { heavy: { concurrency: 2 } } });
    // @ts-expect-error maxConcurrency is now localMaxConcurrency
    createSqlane({ adapter: mysql2Adapter(mysqlPool, { dialect: 'mysql' }), maxConcurrency: 2 });
    expectTypeOf(heavy.max).toBeNumber();

    /** @type {import('@sqlane/core').Sqlane<import('@sqlane/core/adapter-mysql2').Mysql2Connection>} */
    const typedSqlane = sqlane;

    typedSqlane.handle('typed', () => {});

    // handle: the context
    sqlane.handle(job, ({ payload: jobPayload, job: info, signal }) => {
        expectTypeOf(jobPayload).toBeAny();
        expectTypeOf(info.attempt).toBeNumber();
        expectTypeOf(info.enqueuedAt).toEqualTypeOf(new Date());
        expectTypeOf(info.globalConcurrencyLimits)
            .toEqualTypeOf(/** @type {readonly { key: string, max: number }[]} */ ([]));
        expectTypeOf(signal).toEqualTypeOf(new AbortController().signal);
    });

    // A declared payload: defineJob<P>(…) in TypeScript; in JSDoc, the type of the definition
    /** @type {import('@sqlane/core').JobDefinition<{ orderId: number, note?: string }>} */
    const syncOrder = defineJob({
        name: 'sync_order',
        globalConcurrencyLimits: ({ payload: order }) => {
            expectTypeOf(order).toEqualTypeOf(/** @type {{ orderId: number, note?: string }} */ ({ orderId: 1 }));

            return [heavy.key(order.orderId)];
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
    // @ts-expect-error globalConcurrencyLimits returns limits and their keys
    defineJob({ name: 'a', globalConcurrencyLimits: () => ['a'] });
    // @ts-expect-error mutexKeys was removed in 6.0
    defineJob({ name: 'a', mutexKeys: () => ['a'] });

    // Rate limits: global per key, at a cost; local keyless
    const github = defineRateLimit({ name: 'github', max: 5000, per: '1h' });
    const sms = defineRateLimit({ name: 'sms', max: 10, per: 1000, burst: 10 });

    expectTypeOf(github.per).toBeNumber();
    expectTypeOf(github.burst).toBeNumber();
    expectTypeOf(github.key('t1', { cost: 1 })).toEqualTypeOf(sms.cost(2));
    expectTypeOf(sms.cost(2).key).toEqualTypeOf(/** @type {string | null} */ (null));
    defineJob({
        name: 'sync_repo',
        globalRateLimits: ({ payload: repo }) => [sms, sms.cost(2), github.key(repo.tokenId)],
        localRateLimits: [sms],
        globalConcurrencyLimits: () => [heavy],
        timeout: '1m',
    });
    // @ts-expect-error per is required
    defineRateLimit({ name: 'a', max: 1 });
    // @ts-expect-error a local rate limit is keyless
    defineJob({ name: 'a', localRateLimits: [github.key('t1')] });
    // @ts-expect-error globalRateLimits returns rate limits and their keys
    defineJob({ name: 'a', globalRateLimits: () => [heavy] });
    // @ts-expect-error a cost is a number
    github.key('t1', { cost: '1' });
    await sqlane.enqueue(connection, job, {}, { globalRateLimits: [github.key('t1'), sms] });
    // @ts-expect-error a global rate limit is a rate limit or its key
    await sqlane.enqueue(connection, job, {}, { globalRateLimits: ['@github:t1'] });
    expectTypeOf(new RateLimitedError({ limit: github.key('t1'), retryAfter: '30s' }).retryAfter)
        .toEqualTypeOf(/** @type {import('@sqlane/core').Duration} */ ('30s'));
    void new RateLimitedError({ retryAfter: 30_000, cause: new Error('429') });
    // @ts-expect-error retryAfter is required
    void new RateLimitedError({ limit: github });
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
    createSqlane({ adapter: mysql2Adapter(mysqlPool, { dialect: 'mysql' }), unknownJobs: 'warn' });
    createSqlane({
        adapter: mysql2Adapter(mysqlPool, { dialect: 'mysql' }),
        onEvent: (event) => {
            if (event.type === 'retried') {
                expectTypeOf(event.delayMs).toBeNumber();
            }

            if (event.type === 'rate_limited') {
                expectTypeOf(event.limit).toBeString();
                expectTypeOf(event.key).toEqualTypeOf(/** @type {string | null} */ (null));
                expectTypeOf(event.scope).toEqualTypeOf(/** @type {'global' | 'local'} */ ('global'));
                expectTypeOf(event.retryAt).toEqualTypeOf(new Date());
                expectTypeOf(event.durationMs).toBeNumber();
                expectTypeOf(event.attempt).toBeNumber();
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

    // sqlane.jobs: without a declared type the payload is any; the types are exported
    const read = await sqlane.jobs.get('build_report:r1');

    expectTypeOf(read).toEqualTypeOf(/** @type {import('@sqlane/core').JobRecord<any> | null} */ (null));
    /** @typedef {import('@sqlane/core').JobRecord['blockedOn']} BlockedOn */
    expectTypeOf(read?.blockedOn).toEqualTypeOf(/** @type {BlockedOn | undefined} */ (undefined));

    /** @type {import('@sqlane/core').JobFilter} */
    const filter = { jobName: job, status: ['pending', 'blocked'] };
    /** @type {import('@sqlane/core').ListJobsOptions} */
    const listOptions = { limit: 10, cursor: null, includePayload: undefined };
    /** @type {import('@sqlane/core').JobPage} */
    const page = await sqlane.jobs.list(filter, listOptions);
    /** @type {import('@sqlane/core').JobStatus[]} */
    const statuses = page.jobs.map(item => item.status);
    /** @type {import('@sqlane/core').SqlaneJobs} */
    const jobs = sqlane.jobs;

    void statuses;
    void jobs;
    expectTypeOf(page.nextCursor).toEqualTypeOf(/** @type {string | null} */ (null));
    expectTypeOf(page.jobs[0].lastError).toEqualTypeOf(/** @type {import('@sqlane/core').JobError | null} */ (null));
    expectTypeOf(/** @type {import('@sqlane/core').FailedJobPayload['error']} */ ({ name: '', message: '' }))
        .toEqualTypeOf(/** @type {import('@sqlane/core').JobError} */ ({ name: '', message: '' }));
    await sqlane.jobs.list({ jobName: 'build_report', status: undefined }, { cursor: undefined });
    // @ts-expect-error not a status
    await sqlane.jobs.list({ jobName: 'build_report', status: 'done' });
    // @ts-expect-error a list has the jobs of one name
    await sqlane.jobs.list({ status: 'failed' });

    // The bulk methods: a connection of the instance's adapter; a selector of ids or a filter, not both
    /** @type {import('@sqlane/core').BulkResult} */
    const retried = await sqlane.jobs.retry({ jobIds: ['build_report:r1'] }, {
        budget: 'one_more',
        connection,
        includeAffectedJobIds: true,
    });

    expectTypeOf(retried.affectedJobIds).toEqualTypeOf(/** @type {string[] | undefined} */ (undefined));
    expectTypeOf(retried.ignoredJobs[0].reason)
        .toEqualTypeOf(/** @type {'not_found' | 'status' | 'no_payload'} */ ('status'));
    await sqlane.jobs.cancel({ jobName: job, status: 'blocked' }, { mode: 'batches' });
    await sqlane.jobs.remove({ jobName: 'build_report' }, { connection: mysqlPool, strict: false });

    // keyStats: a page of keys, by type
    const keyPage = await sqlane.jobs.keyStats({ limit: 10, type: 'concurrency', orderBy: 'held' });

    expectTypeOf(keyPage.truncated).toBeBoolean();

    for (const key of keyPage.keys) {
        switch (key.type) {
            case 'concurrency':
                expectTypeOf(key.key).toBeString();
                expectTypeOf(key.max).toEqualTypeOf(/** @type {number | null} */ (null));
                expectTypeOf(key.oldestHeldAgeMs).toEqualTypeOf(/** @type {number | null} */ (null));
                break;
            case 'rate':
                expectTypeOf(key.key).toEqualTypeOf(/** @type {string | null} */ (null));
                expectTypeOf(key.nextStartInMs).toBeNumber();
                expectTypeOf(key.oldestBlockedAgeMs).toBeNumber();
                break;
            default:
                break;
        }
    }

    // @ts-expect-error not a type of key
    await sqlane.jobs.keyStats({ type: 'mutex' });
    // @ts-expect-error not an order
    await sqlane.jobs.keyStats({ orderBy: 'age' });
    /** @type {import('@sqlane/core').KeyStatsOptions} */
    const keyStatsOptions = { limit: 5 };

    void keyStatsOptions;

    // KeyStats is the union of the contract, exactly
    expectTypeOf(/** @type {import('@sqlane/core').KeyStats} */ (/** @type {any} */ (null))).toEqualTypeOf(
        /** @type {{
         *     type: 'concurrency', key: string, max: number | null, held: number, lingering: number, blocked: number,
         *     blockedTruncated: boolean, oldestBlockedAgeMs: number | null, oldestHeldAgeMs: number | null,
         * } | {
         *     type: 'rate', limit: string, key: string | null, blocked: number, blockedTruncated: boolean,
         *     oldestBlockedAgeMs: number, nextStartInMs: number,
         * }} */ (/** @type {any} */ (null)),
    );

    // A mock of SqlaneJobs needs keyStats
    /** @type {import('@sqlane/core').SqlaneJobs} */
    // @ts-expect-error keyStats is missing
    const mockWithoutKeyStats = {
        get: anyMethod, list: anyMethod, retry: anyMethod, cancel: anyMethod, remove: anyMethod,
    };
    /** @type {import('@sqlane/core').SqlaneJobs} */
    const mock = {
        get: anyMethod, list: anyMethod, retry: anyMethod, cancel: anyMethod, remove: anyMethod, keyStats: anyMethod,
    };

    void mockWithoutKeyStats;
    void mock;
    /** @type {import('@sqlane/core').JobSelector} */
    const selector = { jobIds: ['a'] };
    /** @type {import('@sqlane/core').BulkOptions} */
    const bulkOptions = { mode: 'atomic' };
    /** @type {import('@sqlane/core').RetryOptions} */
    const retryOptions = { budget: 'reset' };

    void selector;
    void bulkOptions;
    void retryOptions;
    // @ts-expect-error a pg client is not a connection of the mysql2 adapter
    await sqlane.jobs.cancel({ jobIds: ['a'] }, { connection: pgPool });
    // @ts-expect-error ids or a filter, not both
    await sqlane.jobs.cancel({ jobIds: ['a'], jobName: 'build_report' });
    // @ts-expect-error a selector needs ids or a filter
    await sqlane.jobs.cancel({});
    // @ts-expect-error status is for a filter
    await sqlane.jobs.remove({ jobIds: ['a'], status: 'failed' });
    // @ts-expect-error budget is for retry
    await sqlane.jobs.cancel({ jobIds: ['a'] }, { budget: 'reset' });
    // @ts-expect-error not a mode
    await sqlane.jobs.cancel({ jobIds: ['a'] }, { mode: 'fast' });
    expectTypeOf(new JobCancelledError().code).toEqualTypeOf(/** @type {string} */ (''));
    expectTypeOf(new IgnoredJobsError('m', { ignoredJobs: [] }).ignoredJobs).toEqualTypeOf(
        /** @type {readonly import('@sqlane/core').BulkResult['ignoredJobs'][number][]} */ ([]),
    );

    // The slot of a job of a schedule
    sqlane.handle(job, ({ job: info }) => {
        expectTypeOf(info.scheduledAt).toEqualTypeOf(/** @type {Date | null} */ (null));
    });
    /** @type {import('@sqlane/core').JobInfo} */
    // @ts-expect-error scheduledAt is required in a context built by hand
    const builtByHand = {
        id: 'a', name: 'a', attempt: 1, maxAttempts: 1, enqueuedAt: new Date(), globalConcurrencyLimits: [],
        runAt: new Date(), startedAt: new Date(),
    };
    /** @type {import('@sqlane/core').JobInfo} */
    // @ts-expect-error runAt is required in a context built by hand
    const withoutRunAt = {
        id: 'a', name: 'a', attempt: 1, maxAttempts: 1, enqueuedAt: new Date(), globalConcurrencyLimits: [],
        scheduledAt: null, startedAt: new Date(),
    };
    /** @type {import('@sqlane/core').JobInfo} */
    // @ts-expect-error startedAt is required in a context built by hand
    const withoutStartedAt = {
        id: 'a', name: 'a', attempt: 1, maxAttempts: 1, enqueuedAt: new Date(), globalConcurrencyLimits: [],
        scheduledAt: null, runAt: new Date(),
    };
    const claimedBase = { type: /** @type {const} */ ('claimed'), jobId: 'a', jobName: 'a', attempt: 1 };
    /** @type {import('@sqlane/core').SqlaneEvent} */
    // @ts-expect-error a claimed event built by hand needs runAt
    const claimedWithoutRunAt = { ...claimedBase, enqueuedAt: new Date(), startedAt: new Date() };
    /** @type {import('@sqlane/core').SqlaneEvent} */
    // @ts-expect-error a claimed event built by hand needs enqueuedAt
    const claimedWithoutEnqueuedAt = { ...claimedBase, runAt: new Date(), startedAt: new Date() };
    /** @type {import('@sqlane/core').SqlaneEvent} */
    // @ts-expect-error a claimed event built by hand needs startedAt
    const claimedWithoutStartedAt = { ...claimedBase, runAt: new Date(), enqueuedAt: new Date() };
    /** @type {import('@sqlane/core').SqlaneEvent} */
    const claimedEvent = { ...claimedBase, runAt: new Date(), enqueuedAt: new Date(), startedAt: new Date() };
    /** @type {import('@sqlane/core').JobInfo} */
    const complete = {
        id: 'a', name: 'a', attempt: 1, maxAttempts: 1, enqueuedAt: new Date(), globalConcurrencyLimits: [],
        scheduledAt: null, runAt: new Date(), startedAt: new Date(),
    };

    void builtByHand;
    void withoutRunAt;
    void withoutStartedAt;
    void complete;
    void claimedWithoutRunAt;
    void claimedWithoutEnqueuedAt;
    void claimedWithoutStartedAt;
    void claimedEvent;
    sqlane.handle(job, ({ job: info }) => {
        expectTypeOf(info.runAt).toEqualTypeOf(new Date());
        expectTypeOf(info.startedAt).toEqualTypeOf(new Date());
    });

    // enqueue: a slot run by hand
    await sqlane.enqueue(connection, job, {}, { slot: { at: new Date(), key: 'tenant-42' } });
    await sqlane.enqueue(connection, job, {}, { slot: { at: new Date() }, delay: '1m' });
    // @ts-expect-error slot or jobId, not both
    await sqlane.enqueue(connection, job, {}, { slot: { at: new Date() }, jobId: 'x' });
    // @ts-expect-error slot.at is a Date
    await sqlane.enqueue(connection, job, {}, { slot: { at: '2026-01-01' } });

    // The event of a slot
    createSqlane({
        adapter: mysql2Adapter(mysqlPool, { dialect: 'mysql' }),
        onEvent: (event) => {
            if (event.type === 'claimed') {
                expectTypeOf(event.runAt).toEqualTypeOf(new Date());
                expectTypeOf(event.enqueuedAt).toEqualTypeOf(new Date());
                expectTypeOf(event.startedAt).toEqualTypeOf(new Date());
            }

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
