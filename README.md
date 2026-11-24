<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/logo_dark.svg">
    <img alt="sqlane" height="48" src="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/logo_light.svg">
  </picture>
</h1>

**Status: not production-ready yet.**

[![npm](https://img.shields.io/npm/v/@sqlane/core)](https://www.npmjs.com/package/@sqlane/core)
[![CI](https://github.com/sqlane/sqlane-node/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sqlane/sqlane-node/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/@sqlane/core)](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#supported-versions)
[![License: MIT](https://img.shields.io/npm/l/@sqlane/core)](https://github.com/sqlane/sqlane-node/blob/main/LICENSE)

**Background jobs that commit with your data.**

A job queue for Node.js that runs in your PostgreSQL, MySQL or MariaDB database. Enqueue in the transaction you already
have: a rollback removes the job with your data, and a commit hands it to a worker. No Redis. Concurrency and rate
limits per key, across the whole cluster.

```sh
npm install @sqlane/core
```

Node.js 22.12+ · ESM · TypeScript types · zero dependencies · npm provenance

[Getting started](https://github.com/sqlane/sqlane-node/blob/main/README.md#getting-started) ·
[Adapters](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md) ·
[API](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md) ·
[Features vs other libs](https://github.com/sqlane/sqlane-node/blob/main/docs/features_vs_other_libs.md) ·
[Performance vs other libs](https://github.com/sqlane/sqlane-node/blob/main/docs/performance_vs_other_libs.md) ·
[Design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md)

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createSqlane, defineHandler, defineLane } from '@sqlane/core';
import { drizzleAdapter } from '@sqlane/core/adapter-drizzle';
import { createRunner } from '@sqlane/core/runner';
import { orders } from './schema.js';

const url = process.env.DATABASE_URL;
const db = drizzle({ client: new Pool({ connectionString: url }) }); // yours
const queueDb = drizzle({ client: new Pool({ connectionString: url, max: 3 }) }); // sqlane's own

const sendReceipt = defineLane<{ orderId: number }>({ name: 'send_receipt' });
const sqlane = createSqlane({ adapter: drizzleAdapter(queueDb, { dialect: 'postgres' }) });
await sqlane.schema.migrate(); // creates the sqlane_* tables

// Worker: runs the job after the commit, in this process or another
const runner = createRunner(sqlane);
runner.mount([defineHandler(sendReceipt, ({ payload }) => sendReceiptEmail(payload.orderId))]);
await runner.start();

// Producer: the order and its job commit together, or not at all
await db.transaction(async (tx) => {
    const [order] = await tx.insert(orders).values({ total: 42 }).returning();
    await sqlane.enqueue(tx, sendReceipt, { orderId: order.id });
});
```

<details>
<summary>The same with pg, postgres.js, mysql2, Knex, Kysely, Prisma, Sequelize, TypeORM or MikroORM</summary>

Each adapter takes the queue's own pool or instance and the database as `dialect`: `'postgres'`, `'mysql'` or
`'mariadb'`. Pass your transaction to `enqueue`.

[pg](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#pg)

```ts
import { pgAdapter } from '@sqlane/core/adapter-pg';

const adapter = pgAdapter(queuePool, { dialect: 'postgres' });
// client: a PoolClient of your app's pool, after BEGIN
await sqlane.enqueue(client, sendReceipt, { orderId });
```

[postgres.js](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#postgresjs)

```ts
import { postgresJsAdapter } from '@sqlane/core/adapter-postgres-js';

const adapter = postgresJsAdapter(queueSql, { dialect: 'postgres' });
await sql.begin(async (tx) => {
    await sqlane.enqueue(tx, sendReceipt, { orderId });
});
```

[mysql2](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#mysql2)

```ts
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';

const adapter = mysql2Adapter(queuePool, { dialect: 'mysql' }); // or 'mariadb'
// connection: a PoolConnection of your app's pool, after beginTransaction()
await sqlane.enqueue(connection, sendReceipt, { orderId });
```

[Knex](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#knex)

```ts
import { knexAdapter } from '@sqlane/core/adapter-knex';

const adapter = knexAdapter(queueKnex, { dialect: 'postgres' });
await knex.transaction(async (trx) => {
    await sqlane.enqueue(trx, sendReceipt, { orderId });
});
```

[Kysely](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#kysely)

```ts
import { kyselyAdapter } from '@sqlane/core/adapter-kysely';

const adapter = kyselyAdapter(queueDb, { dialect: 'postgres' });
await db.transaction().execute(async (trx) => {
    await sqlane.enqueue(trx, sendReceipt, { orderId });
});
```

[Prisma](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#prisma)

```ts
import { prismaAdapter } from '@sqlane/core/adapter-prisma';

const adapter = prismaAdapter(queuePrisma, { dialect: 'postgres' });
await prisma.$transaction(async (tx) => {
    await sqlane.enqueue(tx, sendReceipt, { orderId });
});
```

[Sequelize](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#sequelize)

```ts
import { sequelizeAdapter } from '@sqlane/core/adapter-sequelize';

const adapter = sequelizeAdapter(queueSequelize, { dialect: 'postgres' });
await sequelize.transaction(async (t) => {
    await sqlane.enqueue(t, sendReceipt, { orderId });
});
```

[TypeORM](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#typeorm)

```ts
import { typeOrmAdapter } from '@sqlane/core/adapter-typeorm';

const adapter = typeOrmAdapter(queueDataSource, { dialect: 'postgres' });
await dataSource.transaction(async (manager) => {
    await sqlane.enqueue(manager, sendReceipt, { orderId });
});
```

[MikroORM](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#mikroorm)

```ts
import { mikroOrmAdapter } from '@sqlane/core/adapter-mikro-orm';

const adapter = mikroOrmAdapter(queueOrm.em, { dialect: 'postgres' });
await orm.em.transactional(async (em) => {
    await sqlane.enqueue(em, sendReceipt, { orderId });
});
```

</details>

## Why sqlane

Most apps save their data, then push a job to a separate queue. A crash between the two loses the job; a rollback after
the push leaves a job for data that never existed. sqlane stores each job as a row that you insert in your own
transaction, so:

- The job exists only if the transaction commits. A rollback removes it with your data.
- Workers can't see the job before the commit, so it never starts before its data is visible.
- A crash after the commit loses nothing: the job is in the database, and a worker runs it.

## Features

- **[PostgreSQL, MySQL and MariaDB](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#the-dialect-and-the-server-check).**
  PostgreSQL 15+, MySQL 8.4+, MariaDB 10.11+. The same API on all three.
- **[Atomic enqueue](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueue).** Enqueue in your own
  transaction: commit → the job runs, rollback → it's gone.
  [`enqueueMany`](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueuemany) adds a batch at once.
- **[Cron and interval schedules](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schedules).** Time zones,
  one job per slot across the cluster, a missed run caught up once, and jitter to spread the runs of many schedules.
- **[Rate limits, global or local](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#defineratelimit).** "100
  calls a second to the mail API", per key, across the cluster or per process. A job over the limit waits without
  using an attempt. A handler that gets a 429 throws
  [`RateLimitedError`](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#errors-that-handlers-throw) to
  pause the key for every job. For APIs that charge points, a job can cost several units of a limit.
- **[Concurrency limits, global or local](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#defineconcurrencylimit).**
  "One sync per order at a time": a job takes several keys, each with its own max, across processes and lanes.
  Local limits cap jobs per process. A flood on one key never blocks the others.
- **[Several limits on one job](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#defineratelimit).**
  Concurrency and rate limits together, each with its own `max`, `per` and `burst`: "5000 calls an hour per token, 10
  a second overall, and 2 at once per repo". Up to 10 global keys per job, plus local limits.
- **[Your driver or ORM](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md).** mysql2, pg, postgres.js,
  Knex, Kysely, Drizzle, Prisma, Sequelize, TypeORM and MikroORM.
- **[Idle lanes cost nothing](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#dispatcher-one-loop-per-process).**
  One query per poll covers all lanes, so 1000 idle lanes cost about what one does.
- **[Fair share across lanes](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#how-free-slots-are-shared).**
  A backlog of one lane never starves the others; weights tune the shares.
- **[Wake-up within milliseconds](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md#wake-up-after-the-commit).**
  NOTIFY on PostgreSQL, or any pub/sub such as Redis as a [hint](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#hint);
  polling as the fallback.
- **[Failure jobs](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#failedjobpayload).** A job of your choice
  runs when another fails for good.
- **[Graceful shutdown](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#close).** Running jobs get a
  deadline; the unfinished ones go back to the queue without using an attempt.
- **And the basics:** [retries with backoff](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#backoff),
  delayed jobs and deduplication by `dedupeKey` ([enqueue](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueue)),
  timeouts that abort the handler ([defineLane](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#definelane)),
  [crash recovery](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#leases-and-stalls),
  [typed payloads](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#typed-payloads),
  [events](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#events) and
  [stats](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#lanesstats), and
  [migrations by version](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schemamigrate), with rollback
  and schema checks.

How sqlane compares with BullMQ, pg-boss and 5 more:
[features](https://github.com/sqlane/sqlane-node/blob/main/docs/features_vs_other_libs.md) ·
[performance](https://github.com/sqlane/sqlane-node/blob/main/docs/performance_vs_other_libs.md).

## Performance

<!-- generated:readme -->

|                                            | sqlane       | 7 other queues  |
| ------------------------------------------ | ------------ | --------------- |
| CPU instructions per job                   | **3.1 M**    | 3.9–29.6 M      |
| SQL statements per job ¹                   | **3.0**      | 3.7–25.8        |
| Idle database CPU, 1000 names              | **0.1 M/s**  | 0.07–350 M/s    |
| Enqueue to handler start, p50 / p99        | **4 / 5 ms** | 3–58 / 3–200 ms |
| Jobs per second, one worker with 8 slots ² | **2,810**    | 69–6,820        |

PostgreSQL 17, 1 ms round trip, empty handlers. Lower is better, except jobs per second.

¹ The queues on PostgreSQL. BullMQ on Redis runs Redis commands, not SQL.

² The backlog of 50,000 jobs ran out before the end of the run for sqlane, BullMQ on Redis, BullMQ on PostgreSQL,
pg-boss and River, so their rates are lower bounds.

<!-- /generated:readme -->

[Charts, method and conditions →](https://github.com/sqlane/sqlane-node/blob/main/docs/performance_vs_other_libs.md)

## Getting started

The steps below build the example above into an app: Drizzle on PostgreSQL. With another library, only the adapter and
the transaction code change ([adapters](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md)).

**0. Install.** sqlane has no dependencies: it runs over the driver or ORM that your app already has.

```sh
npm install @sqlane/core
```

**1. Define your lanes.** A lane, such as `send_receipt`, is the jobs that share a name: also their queue. Keep the
definitions in a module that producers and workers both import. The type parameter types the payload in `enqueue`
and in the handler.

```ts
// jobs.ts
import { defineLane } from '@sqlane/core';

export const sendReceipt = defineLane<{ orderId: number }>({
    name: 'send_receipt',
    maxAttempts: 5,
    timeout: '1m',
});
```

**2. Create the instance and the tables.** Give sqlane a small pool of its own, with 2–3 connections, so the queue and
your app never wait for each other's connections. `schema.migrate()` creates the `sqlane_*` tables and is safe to run
from several processes at once. To run it from your own migration tool, pin a version in each migration file: see
[`schema.migrate`](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schemamigrate).

```ts
// sqlane.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createSqlane } from '@sqlane/core';
import { drizzleAdapter } from '@sqlane/core/adapter-drizzle';

const url = process.env.DATABASE_URL;
const queuePool = new Pool({ connectionString: url, max: 3 }); // sqlane's own
const queueDb = drizzle({ client: queuePool });

export const sqlane = createSqlane({
    // notify: NOTIFY wakes the workers of every process at the commit
    adapter: drizzleAdapter(queueDb, { dialect: 'postgres', notify: true }),
});

await sqlane.schema.migrate();
```

**3. Enqueue in your transaction.** Pass your transaction to `enqueue`: the job commits or rolls back with the order. A
`dedupeKey` deduplicates, and `delay` runs the job later
([enqueue options](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueue)).

```ts
// orders.ts
import { db } from './db.js';
import { sendReceipt } from './jobs.js';
import { orders } from './schema.js';
import { sqlane } from './sqlane.js';

export async function placeOrder(total: number) {
    await db.transaction(async (tx) => {
        const [order] = await tx.insert(orders).values({ total }).returning();
        await sqlane.enqueue(tx, sendReceipt, { orderId: order.id }, {
            dedupeKey: `receipt-${order.id}`, // deduplicates
        });
    });
}
```

**4. Handle jobs, start the runner, close on shutdown.** The runner of a process (`@sqlane/core/runner`) runs the
handlers that it mounts; a process that only enqueues never loads it. Pass the handler's `signal` to APIs that accept
one, such as `fetch`: it aborts on a timeout or a shutdown. A handler must stop when it aborts: one that runs on past its lease can
exceed a concurrency limit ([guarantees](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#guarantees)).

```ts
// worker.ts
import { defineHandler } from '@sqlane/core';
import { createRunner } from '@sqlane/core/runner';
import { sendReceipt } from './jobs.js';
import { sqlane } from './sqlane.js';

const runner = createRunner(sqlane, { localMaxConcurrency: 10 });

runner.mount([
    defineHandler(sendReceipt, async ({ payload, signal }) => {
        await sendReceiptEmail(payload.orderId, { signal }); // your code
    }),
]);
await runner.start();
process.once('SIGTERM', () => sqlane.close({ deadline: '30s' })); // closes the runner, then the hint
```

## Documentation

- The [API reference](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md) describes every function and option.
- The [adapters page](https://github.com/sqlane/sqlane-node/blob/main/docs/adapters.md) explains each driver and ORM.
- The [feature comparison](https://github.com/sqlane/sqlane-node/blob/main/docs/features_vs_other_libs.md) puts sqlane
  next to other queues, and the
  [performance comparison](https://github.com/sqlane/sqlane-node/blob/main/docs/performance_vs_other_libs.md) measures
  their cost.
- The [design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md) explains how sqlane works inside.
- The [examples folder](https://github.com/sqlane/sqlane-node/tree/main/examples) has more examples.
- The [changelog](https://github.com/sqlane/sqlane-node/blob/main/CHANGELOG.md) lists what changed in each version. The
  migration guides show how to upgrade your code to a new major version:
    - [8.x → 9.0](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/9.md)
    - [7.x → 8.0](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/8.md)
    - [6.x → 7.0](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/7.md)
    - [5.x → 6.0](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/6.md)
    - [4.x → 5.0](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/5.md)
- The [contributing guide](https://github.com/sqlane/sqlane-node/blob/main/CONTRIBUTING.md) explains the project setup.

## Versioning

sqlane follows [semantic versioning](https://semver.org). Until sqlane sees production use, major versions may come
often; each one ships a migration guide. New [event](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#events)
types may come in minor versions, so handle unknown types in a `default` branch.

## Support and contributing

If you find a bug or have a question, open a [GitHub issue](https://github.com/sqlane/sqlane-node/issues). A use case
that sqlane does not cover yet is a good issue too. Please report a vulnerability privately, as
[SECURITY.md](https://github.com/sqlane/sqlane-node/blob/main/SECURITY.md) explains. To work on sqlane, read
[CONTRIBUTING.md](https://github.com/sqlane/sqlane-node/blob/main/CONTRIBUTING.md).

## License

sqlane is released under the [MIT license](https://github.com/sqlane/sqlane-node/blob/main/LICENSE).
