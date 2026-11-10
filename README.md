# sqlane

A transactional job queue for Node.js that stores its jobs in your own MySQL, MariaDB or PostgreSQL database. Its npm
package is `@sqlane/core`.

[![npm](https://img.shields.io/npm/v/@sqlane/core)](https://www.npmjs.com/package/@sqlane/core)
[![CI](https://github.com/sqlane/sqlane-node/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sqlane/sqlane-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@sqlane/core)](https://github.com/sqlane/sqlane-node/blob/main/LICENSE)

[Getting started](https://github.com/sqlane/sqlane-node/blob/main/README.md#getting-started) ·
[Adapters](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md) ·
[API](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md) ·
[Comparison](https://github.com/sqlane/sqlane-node/blob/main/docs/comparison.md) ·
[Benchmarks](https://github.com/sqlane/sqlane-node/blob/main/docs/competitor-idle-benchmarks.md) ·
[Design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md)

**Status:** the API and the schema are stable since version 1.0 and follow
[semantic versioning](https://github.com/sqlane/sqlane-node/blob/main/README.md#versioning). sqlane is new (first
released in 2026) and has no known production users yet.

Many apps save their data and then send a job to a separate queue. If the process crashes between these two steps, the
job is lost. If the job goes out first and the transaction then rolls back, a worker runs a job for data that does not
exist.

sqlane avoids both problems. Each job is a row in your MySQL 8.4+, MariaDB 10.11+ or PostgreSQL 15+ database, and you
add it with the connection of your business transaction. So the job and your data commit together. This is the transactional outbox
pattern, without a separate relay process. You do not need Redis or a message broker.

When you enqueue a job inside a transaction, sqlane gives you this contract:

- The job exists only if the transaction commits. If the transaction rolls back, the job disappears with your data.
- Workers cannot see the job before the commit, so a job never starts before its data is visible.
- If the process crashes after the commit, the job is still in the database, and a worker runs it.

```js
import knex from 'knex';
import { createSqlane, defineJob } from '@sqlane/core';
import { knexAdapter } from '@sqlane/core/adapter-knex';

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL }); // your app's connection pool
// a small separate pool for sqlane
const queueDb = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { max: 3 } });

const sendReceipt = defineJob({ name: 'send_receipt' });
const sqlane = createSqlane({ adapter: knexAdapter(queueDb), jobs: [sendReceipt] });
await sqlane.migrate(); // creates the sqlane_* tables

// Worker: runs the job after the commit, in this process or in another one
sqlane.handle(sendReceipt, async ({ payload }) => sendReceiptEmail(payload.orderId));
await sqlane.start();

// Producer: the order and its job commit together, or not at all
await db.transaction(async (trx) => {
    await trx('orders').insert({ id: orderId, total: 42 });
    await sqlane.enqueue(trx, sendReceipt, { orderId });
});
```

sqlane uses its own small pool to find and claim jobs, so the queue and your app do not wait for each other's
connections. This example uses Knex on PostgreSQL. It works the same way with mysql2, pg, postgres.js, Kysely, Drizzle,
Prisma, Sequelize, TypeORM and MikroORM, on MySQL, MariaDB or PostgreSQL.

## Why sqlane

sqlane fits apps that need reliable background work in the SQL database they already run.

- **Your data and its jobs commit together.** Enqueue through your existing driver or ORM transaction. An order
  and its receipt job either both exist or neither does. Works on **MySQL, MariaDB and PostgreSQL**, with adapters
  for 10 drivers and ORMs.
- **Many job names, one polling loop.** Register hundreds of handlers without a separate idle poll or a dedicated
  connection per name. One readiness query per poll finds names with pending jobs; completed history does not keep a name active.
  The worker uses one shared connection pool. See the [idle-queue comparison](https://github.com/sqlane/sqlane-node/blob/main/docs/competitor-idle-benchmarks.md).
- **Coordinate work by entity.** Give `sync_order` and `cancel_order` the same `order:42` mutex key to keep them
  from overlapping across processes. A job can hold up to 10 keys, for example an order and its customer. Handlers
  must honor the abort signal; see the [guarantees](https://github.com/sqlane/sqlane-node/blob/main/README.md#guarantees-and-limits).
- **MIT license, zero runtime dependencies.** Transactional enqueue, mutex keys and every other sqlane feature are
  in the same [MIT-licensed package](https://github.com/sqlane/sqlane-node/blob/main/LICENSE).

On PostgreSQL, pg-boss, Graphile Worker and River also support transactional enqueue. Graphile Worker also shares
polling across task names. sqlane's combination is MySQL/MariaDB support, transaction adapters and mutex keys across
job names. The [comparison](https://github.com/sqlane/sqlane-node/blob/main/docs/comparison.md) covers the differences,
licenses and measured idle costs.

Choose pg-boss or Graphile Worker for built-in cron, BullMQ for workflows and its broader ecosystem, or an
established queue when a long production history is your main requirement. Scheduling is on the [roadmap](#roadmap).

## Features

- **Transactional enqueue.** A job commits or rolls back with your data. ([enqueue](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueue))
- **Mutex keys.** Jobs that share a key, such as `order:42`, never run at the same time in the whole cluster, as long as handlers stop when sqlane aborts their `signal`. A job can have up to 10 keys, and the keys work across job names. ([defineJob](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#definejob), [limits](https://github.com/sqlane/sqlane-node/blob/main/README.md#guarantees-and-limits))
- **Retries with backoff.** A failed job runs again after an exponential or fixed wait. A handler can also ask for a given delay, or fail the job at once. ([backoff](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#backoff), [handler errors](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#errors-that-handlers-throw))
- **Delayed and unique jobs.** A job can wait for a `delay` or start at a `runAt` time. A `jobId` blocks a duplicate enqueue while the first job's row exists. By default, the row exists until about 1 hour after the job completes. The `retention` option changes this time. ([enqueue options](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueue))
- **Failure jobs.** When a job fails for good, sqlane adds a job of another name, so you can react, for example with an alert. ([failure jobs](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#failedjobpayload))
- **Concurrency limits.** You can limit the number of handlers that run at the same time in each process. The limit can apply to all handlers, to one job name, or to a lane that several job names share. ([handle](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#handle))
- **Typed payloads.** In TypeScript or JSDoc, `enqueue`, the handler and `mutexKeys` share one payload type. ([typed payloads](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#typed-payloads))
- **Fast start after the commit.** Workers in the same process start a job about 25 ms after the commit, or at the commit with Knex, Sequelize, TypeORM and MikroORM. Workers in other processes start it within a few milliseconds with PostgreSQL NOTIFY (the pg, postgres.js and Drizzle adapters), or about 25 ms after the commit with a [hint](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#hint) over Redis or another publish/subscribe service. Without either, they find the job at their next poll, which comes every 5 seconds by default. ([wake-up](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#wake-up-after-the-commit))
- **Cheap idle job names.** Workers look only at the job names that have pending jobs, so 1000 mostly idle names cost about the same as 10. ([how it works](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#dispatcher-one-loop-per-process))
- **Crash recovery.** If a worker process stops, its leases end within 4 minutes. Another process then finds its unfinished jobs within about 30 seconds and runs them again 30 seconds later. A job with mutex keys waits one more lease (4 minutes), because the old handler may still run. ([leases and stalls](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#leases-and-stalls))
- **Monitoring.** Lifecycle events feed your metrics, and `getStats()` returns job counts per name for alerts. ([events](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#events), [getStats](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#getstats))
- **Graceful shutdown.** `close()` waits for the running handlers, then puts unfinished jobs back in the queue. ([close](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#close))
- **Easy tests.** `drain()` runs the due jobs at once, without a worker loop. ([drain](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#drain))
- **Works with your migration tool.** `migrate()` creates the tables, or `getMigrations()` gives you the SQL for your own tool. ([getMigrations](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#getmigrations))

## Install

```sh
npm install @sqlane/core
```

sqlane needs Node.js 22.12+ and MySQL 8.4+, MariaDB 10.11+ or PostgreSQL 15+. It uses the driver or ORM that your app
already has, so you install nothing else. On MariaDB, tell the adapter: see
[MariaDB](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#mariadb). SQLite is not supported. sqlane is
an ES module. CommonJS apps can load it with
`require()`, which Node.js supports from version 22.12.

## Getting started

These steps build the example above again, step by step, with the same imports. For another library, only the
adapter and the transaction code change, as the
[adapters page](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md) shows.

**1. Define your jobs.** A job name, such as `send_receipt`, identifies one kind of job. It also acts as the queue
name, because sqlane has no separate queue object. Keep the definitions in a module that producers and workers both
import. In TypeScript, `defineJob<{ orderId: number }>(…)` also declares the payload type, and `enqueue` then checks it.

```js
export const sendReceipt = defineJob({ name: 'send_receipt', maxAttempts: 5 });
export const syncOrder = defineJob({ name: 'sync_order', mutexKeys: (order) => [`order:${order.orderId}`], timeout: '2m' });
```

Two `sync_order` jobs of the same order never run at the same time, because they share the mutex key of the order. A
job with mutex keys needs a `timeout`.

**2. Create the instance and the tables.** `migrate()` creates or updates the `sqlane_*` tables, and several processes
can call it at once. If you prefer your own migration tool, use the SQL of `getMigrations()` instead.

```js
const queueDb = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { max: 3 } });
export const sqlane = createSqlane({ adapter: knexAdapter(queueDb), jobs: [sendReceipt, syncOrder] });
await sqlane.migrate();
```

**3. Enqueue in your transaction.** Pass your transaction to `enqueue`. With a `jobId`, a second enqueue with the same
job name and `jobId` adds nothing while the first job's row exists. By default, sqlane deletes a completed job about 1
hour after it completes and a failed job after 30 days. After that, the same `jobId` adds a new job. The `retention`
option changes these times. For a guarantee that lasts longer, record the fact in your own table. Outside a
transaction, pass your knex instance instead. sqlane then runs the enqueue in a transaction of its own and commits the
job before `enqueue` returns.

```js
await db.transaction(async (trx) => {
    await trx('orders').insert({ id: orderId, total });
    await sqlane.enqueue(trx, sendReceipt, { orderId }, { jobId: String(orderId) });
});
```

**4. Handle the jobs, start the worker, and close it on shutdown.** Register the handlers before you call `start()`.
The handler gets an `AbortSignal` named `signal`. It aborts on a timeout or a shutdown, so pass it to the APIs that
accept one, such as `fetch`. `close()` stops taking new jobs and waits for the running handlers until the deadline.

```js
sqlane.handle(sendReceipt, async ({ payload, signal }) => {
    await sendReceiptEmail(payload.orderId, { signal }); // your code
}, { concurrency: 5, timeout: '1m' });
await sqlane.start();
process.once('SIGTERM', () => sqlane.close({ deadline: '30s' }));
```

**5. Test with `drain()`.** In tests, call `drain()` instead of `start()`. It runs the due jobs and returns counts.

```js
await placeOrder(42); // your code that enqueues send_receipt
const { completed, failed } = await sqlane.drain();
```

## Supported drivers and ORMs

| Library     | Import                             | Supported versions                 | Details                                                                                    |
| ----------- | ---------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| mysql2      | `@sqlane/core/adapter-mysql2`      | mysql2 3.11+                       | [mysql2](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#mysql2)          |
| pg          | `@sqlane/core/adapter-pg`          | pg 8.13+                           | [pg](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#pg)                  |
| postgres.js | `@sqlane/core/adapter-postgres-js` | postgres 3.4+ and 4                | [postgres.js](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#postgresjs) |
| Knex        | `@sqlane/core/adapter-knex`        | knex 3, with mysql2, mariadb or pg | [Knex](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#knex)              |
| Kysely      | `@sqlane/core/adapter-kysely`      | kysely 0.28 and 0.29               | [Kysely](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#kysely)          |
| Drizzle     | `@sqlane/core/adapter-drizzle`     | drizzle-orm 0.45 and 1.0 (rc)      | [Drizzle](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#drizzle)        |
| Prisma      | `@sqlane/core/adapter-prisma`      | Prisma 7                           | [Prisma](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#prisma)          |
| Sequelize   | `@sqlane/core/adapter-sequelize`   | Sequelize 6                        | [Sequelize](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#sequelize)    |
| TypeORM     | `@sqlane/core/adapter-typeorm`     | TypeORM 0.3 and 1.x                | [TypeORM](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#typeorm)        |
| MikroORM    | `@sqlane/core/adapter-mikro-orm`   | MikroORM 6 and 7                   | [MikroORM](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#mikroorm)      |

The query builders and ORMs work with MySQL, MariaDB and PostgreSQL. mysql2 is a driver for MySQL and MariaDB, the
mariadb driver (through Knex and Sequelize) is for MariaDB, and pg and postgres.js are PostgreSQL drivers.

## Guarantees and limits

- **At least once.** A committed job runs at least once, even after a crash. It can run twice, for example when a
  process crashes after the work but before it saves the result. So a second run of a handler must be safe.
- **Mutex keys need cooperative handlers.** JavaScript cannot stop a running function. When a timeout or a shutdown
  aborts the `signal`, sqlane keeps the job's keys for a limited time while the handler finishes. A handler that
  ignores its `signal` for longer can overlap with the next job of the same key. For this reason, a job with mutex keys
  needs a timeout.
- **Not included.** sqlane has no cron, no priorities, no strict order across processes, no dashboard, no workflows,
  and no cluster-wide concurrency limit per job name. Built-in scheduling is on the [roadmap](#roadmap). Instead
  of a dashboard, use `getStats()`, or query the tables with SQL, as the [data model](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#data)
  describes. There is no API to run a failed job again.

The [design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#guarantees) explains each guarantee and
how sqlane keeps it.

## Performance

These numbers come from `pnpm bench` in this repository, on a laptop (Apple M1 Pro), with the databases in Docker. Your
numbers will differ.

- **Start after the commit.** The benchmark enqueues with the mysql2 and pg adapters, so the workers wake by re-probes
  (repeated checks after the enqueue) or by a hint. The median time from the commit to the start of the handler is
  20–25 ms. With PostgreSQL NOTIFY, a worker in another process starts the job in about 2.4 ms.
- **Idle job names.** A worker finds the job names with pending jobs in one query. With 1000 job names and pending jobs in
  10 of them, this query takes about 0.3–0.5 ms on MySQL 8.4, MariaDB and PostgreSQL 15.
- **Throughput.** 8 producers that each run `enqueue` in a transaction of its own add about 1,700 jobs/s on MySQL 8.4,
  2,100 on MariaDB 11.8 and 4,100 on PostgreSQL 15. With `enqueueMany` and batches of 100, they add about 51,000, 90,000
  and 114,000 jobs/s. One process runs about 4,200 (MySQL 8.4), 4,300 (MariaDB 11.8) and 6,800 (PostgreSQL 15) empty
  jobs per second at concurrency 50.

The [benchmarks page](https://github.com/sqlane/sqlane-node/blob/main/docs/benchmarks.md) explains each scenario and has the full results.

## Roadmap

- **Scheduling.** Built-in cron and recurring jobs.

## Documentation

- The [API reference](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md) describes every function and option.
- The [adapters page](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md) explains each driver and ORM.
- The [comparison](https://github.com/sqlane/sqlane-node/blob/main/docs/comparison.md) puts sqlane next to other queues.
- The [idle-queue comparison](https://github.com/sqlane/sqlane-node/blob/main/docs/competitor-idle-benchmarks.md) measures competitor overhead in Docker.
- The [design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md) explains how sqlane works inside.
- The [benchmarks](https://github.com/sqlane/sqlane-node/blob/main/docs/benchmarks.md) give the measured numbers.
- The [examples folder](https://github.com/sqlane/sqlane-node/tree/main/examples) has more examples.
- The [changelog](https://github.com/sqlane/sqlane-node/blob/main/CHANGELOG.md) lists the changes of each version.
- The [contributing guide](https://github.com/sqlane/sqlane-node/blob/main/CONTRIBUTING.md) explains the project setup.

## Versioning

sqlane follows [semantic versioning](https://semver.org). The
[changelog](https://github.com/sqlane/sqlane-node/blob/main/CHANGELOG.md) lists the changes of each version.

## Support and contributing

If you find a bug or have a question, open a [GitHub issue](https://github.com/sqlane/sqlane-node/issues). A use case
that sqlane does not cover yet is a good issue too. Please report a vulnerability privately, as
[SECURITY.md](https://github.com/sqlane/sqlane-node/blob/main/SECURITY.md) explains. To work on sqlane, read [CONTRIBUTING.md](https://github.com/sqlane/sqlane-node/blob/main/CONTRIBUTING.md).

## License

sqlane is released under the [MIT license](https://github.com/sqlane/sqlane-node/blob/main/LICENSE).
