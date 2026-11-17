# sqlane

**Status: not production-ready yet.**

[![npm](https://img.shields.io/npm/v/@sqlane/core)](https://www.npmjs.com/package/@sqlane/core)
[![CI](https://github.com/sqlane/sqlane-node/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sqlane/sqlane-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@sqlane/core)](https://github.com/sqlane/sqlane-node/blob/main/LICENSE)

[Getting started](https://github.com/sqlane/sqlane-node/blob/main/README.md#getting-started) ·
[Adapters](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md) ·
[API](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md) ·
[Features vs other libs](https://github.com/sqlane/sqlane-node/blob/main/docs/features_vs_other_libs.md) ·
[Performance vs other libs](https://github.com/sqlane/sqlane-node/blob/main/docs/performance_vs_other_libs.md) ·
[Design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md)

Job queue for Node.js that runs in your SQL database. Jobs commit with your data: no Redis, no lost or orphaned jobs.
Works on PostgreSQL, MySQL and MariaDB.

Most apps save their data, then push a job to a separate queue. A crash between the two loses the job; a rollback after
the push leaves a job for data that never existed. sqlane stores each job as a row that you insert in your own
transaction, so:

- The job exists only if the transaction commits. A rollback removes it with your data.
- Workers can't see the job before the commit, so it never starts before its data is visible.
- A crash after the commit loses nothing: the job is in the database, and a worker runs it.

```js
import knex from 'knex';
import { createSqlane, defineJob } from '@sqlane/core';
import { knexAdapter } from '@sqlane/core/adapter-knex';

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL }); // your app's pool
const queueDb = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { max: 3 } }); // sqlane's own small pool

const sendReceipt = defineJob({ name: 'send_receipt' });
const sqlane = createSqlane({ adapter: knexAdapter(queueDb, { dialect: 'postgres' }), jobs: [sendReceipt] });
await sqlane.migrate(); // creates the sqlane_* tables

// Worker: runs the job after the commit, in this process or another
sqlane.handle(sendReceipt, async ({ payload }) => sendReceiptEmail(payload.orderId));
await sqlane.start();

// Producer: the order and its job commit together, or not at all
await db.transaction(async (trx) => {
    await trx('orders').insert({ id: orderId, total: 42 });
    await sqlane.enqueue(trx, sendReceipt, { orderId });
});
```

sqlane claims jobs through its own small pool, so the queue and your app never wait for each other's connections.

## Why sqlane

- **Atomic with your data.** Enqueue in your existing transaction; the job commits or rolls back with it.
- **Concurrency limits per key, across the cluster.** "At most 2 jobs per client, and 100 in total": a job returns its
  keys, such as `client:42`, and each key runs at most its max of jobs, across job names and processes. A flood on one
  key never holds back the others, and a limit of 1 is a mutex. Handlers must stop when their `signal` aborts
  ([guarantees](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#guarantees)).
- **Rate limits per key.** "5000 calls an hour per GitHub token": each key starts at most `max` jobs per period across
  the cluster, spread evenly. A job over the limit waits without using an attempt, and a handler that gets a 429 throws
  a [`RateLimitedError`](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#errors-that-handlers-throw) to
  pause the key for every job.
- **Idle job names are free.** One query per poll finds the names with pending jobs, so 1000 mostly idle names cost
  about what one does.
- **Fits your stack.** Adapters for mysql2, pg, postgres.js, Knex, Kysely, Drizzle, Prisma, Sequelize, TypeORM and
  MikroORM: enqueue with the transaction object you already have.
- **Not just PostgreSQL.** The same API on PostgreSQL, MySQL and MariaDB.

**Also:** [retries with backoff](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#backoff),
[delayed and unique jobs](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueue),
[cron](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schedule),
[failure jobs](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#failedjobpayload),
[per-process limits](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#defineconcurrencylimit) of
concurrency and [of rate](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#defineratelimit),
[typed payloads](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#typed-payloads),
[crash recovery](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#leases-and-stalls),
[graceful shutdown](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#close),
[events](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#events) and
[stats](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#getstats).

## How it compares

🔬 rows are verified by running each library next to sqlane on PostgreSQL 17; the others come from each library's
documentation ([full comparison](https://github.com/sqlane/sqlane-node/blob/main/docs/features_vs_other_libs.md)).

|                                        | sqlane | pg-boss       | Graphile Worker | BullMQ       | Sidequest    | River | Boring Node Queue | Izi Queue |
| -------------------------------------- | ------ | ------------- | --------------- | ------------ | ------------ | ----- | ----------------- | --------- |
| 🔬 Enqueue in the caller's transaction | ✅     | ✅            | ✅              | ❌           | ❌           | ✅    | ✅                | ✅        |
| 🔬 Multiple mutex keys per job         | ✅     | ❌            | ❌              | ❌           | ❌           | ❌    | ❌                | ❌        |
| 🔬 Timeout that aborts the handler     | ✅     | ✅            | ❌              | ❌           | ✅           | ✅    | ✅                | ✅        |
| 🔬 Priority                            | ❌     | ✅            | ✅              | ✅           | 🟠 per queue | ✅    | ✅                | ✅        |
| Rate limit per key                     | ✅     | 🟠 at enqueue | 🟠 community    | 🟠 per queue | ❌           | ❌    | ❌                | ❌        |
| Cron                                   | ✅     | ✅            | ✅              | ✅           | ✅           | ✅    | ✅                | ✅        |
| Dashboard                              | ❌     | ✅            | ❌              | ✅           | ✅           | ✅    | ❌                | ❌        |

Supported databases, from each library's documentation:

|            | sqlane | pg-boss | Graphile Worker | BullMQ | Sidequest | River | Boring Node Queue | Izi Queue |
| ---------- | ------ | ------- | --------------- | ------ | --------- | ----- | ----------------- | --------- |
| PostgreSQL | ✅     | ✅      | ✅              | ✅     | ✅        | ✅    | ✅                | ✅        |
| MySQL      | ✅     | ❌      | ❌              | ❌     | ✅        | ❌    | ✅ Knex           | ✅        |
| MariaDB    | ✅     | ❌      | ❌              | ❌     | ❌        | ❌    | ✅ Knex           | ❌        |
| SQLite     | ❌     | ❌      | ❌              | ❌     | ✅        | ✅    | ✅                | ✅        |

## Performance

<!-- generated:readme -->

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf_cpu_per_job_dark.svg">
  <img alt="CPU instructions per job at steady load on PostgreSQL with a 1 ms round trip: sqlane 3.4 M, Graphile Worker 9.8 M, River 13.8 M, pg-boss 24.9 M, Izi Queue 6.0 M, Boring Node Queue 9.9 M, BullMQ 9.5 M (after the commit), Sidequest 15.6 M (after the commit), BullMQ on Redis 4.1 M (after the commit)" src="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf_cpu_per_job_light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf_statements_dark.svg">
  <img alt="SQL statements per job at steady load on PostgreSQL, each a 1 ms round trip, without the business INSERT: sqlane 3.0, Graphile Worker 4.1, River 3.7, pg-boss 14.3, Izi Queue 5.1, Boring Node Queue 13.6, BullMQ 8.0 (after the commit), Sidequest 9.4 (after the commit), BullMQ on Redis 60 Redis commands (after the commit)" src="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf_statements_light.svg">
</picture>

<details>
<summary>More charts: idle, latency and schedules</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf_idle_dark.svg">
  <img alt="Database instructions per second while idle with 1000 job names on PostgreSQL: sqlane 0.2 M/s, Graphile Worker 1.9 M/s, River 1.3 M/s, pg-boss 261 M/s, Izi Queue 12.7 M/s, Boring Node Queue 0.8 M/s, BullMQ 0.7 M/s (after the commit), Sidequest 1.8 M/s (after the commit), BullMQ on Redis 2.9 M/s (after the commit)" src="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf_idle_light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf_latency_dark.svg">
  <img alt="Time from enqueue to handler start on PostgreSQL with a 1 ms round trip, one library at a time, p50 and p99: sqlane 4 ms, p99 5 ms, Graphile Worker 4 ms, p99 5 ms, River 6 ms, p99 7 ms, pg-boss 5 ms, p99 202 ms, Izi Queue 6 ms, p99 7 ms, Boring Node Queue 862 ms, p99 2010 ms, BullMQ 3 ms, p99 4 ms (after the commit), Sidequest 59 ms, p99 112 ms (after the commit), BullMQ on Redis 4 ms, p99 4 ms (after the commit)" src="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf_latency_light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf_cron_dark.svg">
  <img alt="CPU instructions per fired slot of 1000 schedules due every minute, 3 worker processes, on PostgreSQL with a 1 ms round trip: sqlane 1.9 M, Graphile Worker 8.5 M, River 5.4 M, pg-boss 10.8 M, Izi Queue 23.7 M, Boring Node Queue 15.5 M, BullMQ 7.5 M (after the commit), Sidequest 24.5 M (after the commit), BullMQ on Redis 3.3 M (after the commit)" src="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf_cron_light.svg">
</picture>

</details>

<!-- /generated:readme -->

[Performance details →](https://github.com/sqlane/sqlane-node/blob/main/docs/performance_vs_other_libs.md)

## Install

```sh
npm install @sqlane/core
```

## Supported databases

| Database   | Versions | Wake-up in other processes                   |
| ---------- | -------- | -------------------------------------------- |
| PostgreSQL | 15+      | NOTIFY (pg, postgres.js, Drizzle), or a hint |
| MySQL      | 8.4+     | A hint                                       |
| MariaDB    | 10.11+   | A hint                                       |

A hint is a message over Redis or another publish/subscribe service
([wake-up](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#wake-up-after-the-commit)). Without NOTIFY
or a hint, other processes find new jobs at their next poll, every 5 seconds by default. SQLite is not supported.

Each adapter takes the database as `dialect`: `'postgres'`, `'mysql'` or `'mariadb'`. The worker and `migrate()` check
it against the server, with its version. On MySQL and MariaDB, they also check its `sql_mode`: the default mode of the
database passes, the default parameter group of Amazon RDS MySQL does not
([server check](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#the-dialect-and-the-server-check)).

## Supported drivers and ORMs

| Library                                                                                    | Import                             | Versions                      | MySQL | MariaDB | PostgreSQL |
| ------------------------------------------------------------------------------------------ | ---------------------------------- | ----------------------------- | ----- | ------- | ---------- |
| [mysql2](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#mysql2)          | `@sqlane/core/adapter-mysql2`      | mysql2 3.11+                  | ✅    | ✅      |            |
| [pg](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#pg)                  | `@sqlane/core/adapter-pg`          | pg 8.13+                      |       |         | ✅         |
| [postgres.js](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#postgresjs) | `@sqlane/core/adapter-postgres-js` | postgres 3.4+ and 4           |       |         | ✅         |
| [Knex](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#knex)              | `@sqlane/core/adapter-knex`        | knex 3                        | ✅    | ✅      | ✅         |
| [Kysely](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#kysely)          | `@sqlane/core/adapter-kysely`      | kysely 0.28 and 0.29          | ✅    | ✅      | ✅         |
| [Drizzle](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#drizzle)        | `@sqlane/core/adapter-drizzle`     | drizzle-orm 0.45 and 1.0 (rc) | ✅    | ✅      | ✅         |
| [Prisma](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#prisma)          | `@sqlane/core/adapter-prisma`      | Prisma 7                      | ✅    | ✅      | ✅         |
| [Sequelize](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#sequelize)    | `@sqlane/core/adapter-sequelize`   | Sequelize 6                   | ✅    | ✅      | ✅         |
| [TypeORM](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#typeorm)        | `@sqlane/core/adapter-typeorm`     | TypeORM 0.3 and 1.x           | ✅    | ✅      | ✅         |
| [MikroORM](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#mikroorm)      | `@sqlane/core/adapter-mikro-orm`   | MikroORM 6 and 7              | ✅    | ✅      | ✅         |

## Getting started

The steps below rebuild the example above. With another library, only the adapter and the transaction code change
([adapters](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md)).

**1. Define your jobs.** A job name, such as `send_receipt`, is also its queue. Keep the definitions in a module that
producers and workers both import; in TypeScript, `defineJob<{ orderId: number }>(…)` types the payload.

```js
export const order = defineConcurrencyLimit({ name: 'order', max: 1 });
export const erpApi = defineRateLimit({ name: 'erp_api', max: 100, per: '1m' });
export const sendReceipt = defineJob({ name: 'send_receipt', maxAttempts: 5, timeout: '1m' });
export const syncOrder = defineJob({
    name: 'sync_order',
    globalConcurrencyLimits: ({ payload }) => [order.key(payload.orderId)],
    globalRateLimits: () => [erpApi],
    timeout: '2m',
});
```

Two `sync_order` jobs for the same order never run at the same time, and at most 100 start per minute in the whole
cluster. A job with global concurrency limits needs a `timeout`.

**2. Create the instance and the tables.** Give sqlane its own pool of 2–3 connections. `migrate()` is safe to run
from several processes at once; to use your own migration tool, take the SQL from `getMigrations()`.

```js
const queueDb = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { max: 3 } });
export const sqlane = createSqlane({
    adapter: knexAdapter(queueDb, { dialect: 'postgres' }),
    jobs: [sendReceipt, syncOrder],
});
await sqlane.migrate();
```

**3. Enqueue in your transaction.** Pass your transaction to `enqueue`. A `jobId` deduplicates enqueues
([enqueue options](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueue)).

```js
await db.transaction(async (trx) => {
    await trx('orders').insert({ id: orderId, total });
    await sqlane.enqueue(trx, sendReceipt, { orderId }, { jobId: String(orderId) });
});
```

**4. Handle jobs, start the worker, close on shutdown.** Pass the handler's `signal` to APIs that accept one, such as
`fetch`: it aborts on a timeout or a shutdown.

```js
sqlane.handle(sendReceipt, async ({ payload, signal }) => {
    await sendReceiptEmail(payload.orderId, { signal }); // your code
});
await sqlane.start();
process.once('SIGTERM', () => sqlane.close({ deadline: '30s' }));
```

**5. Test with `drain()`.** In tests, call `drain()` instead of `start()`. It runs the due jobs and returns counts.

```js
await placeOrder(42); // your code that enqueues send_receipt
const { completed, failed } = await sqlane.drain();
```

## Documentation

- The [API reference](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md) describes every function and option.
- The [adapters page](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md) explains each driver and ORM.
- The [comparison](https://github.com/sqlane/sqlane-node/blob/main/docs/features_vs_other_libs.md) puts sqlane next to other queues, and the
  [performance comparison](https://github.com/sqlane/sqlane-node/blob/main/docs/performance_vs_other_libs.md) measures their cost.
- The [design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md) explains how sqlane works inside.
- The [examples folder](https://github.com/sqlane/sqlane-node/tree/main/examples) has more examples.
- The [changelog](https://github.com/sqlane/sqlane-node/blob/main/CHANGELOG.md) lists the changes of each version, and
  the [migration guide to 6.0](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/6.md) the changes of
  your code from 5.x ([to 5.0](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/5.md) from 4.x).
- The [contributing guide](https://github.com/sqlane/sqlane-node/blob/main/CONTRIBUTING.md) explains the project setup.

## Versioning

sqlane follows [semantic versioning](https://semver.org). The
[changelog](https://github.com/sqlane/sqlane-node/blob/main/CHANGELOG.md) lists the changes of each version. New
[event](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#events) types may come in minor versions, so handle
unknown types in a `default` branch.

## Support and contributing

If you find a bug or have a question, open a [GitHub issue](https://github.com/sqlane/sqlane-node/issues). A use case
that sqlane does not cover yet is a good issue too. Please report a vulnerability privately, as
[SECURITY.md](https://github.com/sqlane/sqlane-node/blob/main/SECURITY.md) explains. To work on sqlane, read [CONTRIBUTING.md](https://github.com/sqlane/sqlane-node/blob/main/CONTRIBUTING.md).

## License

sqlane is released under the [MIT license](https://github.com/sqlane/sqlane-node/blob/main/LICENSE).
