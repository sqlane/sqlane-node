# Adapters

An adapter connects sqlane to the database driver or ORM that your app already uses. Each adapter is a subpath of
`@sqlane/core`, so you install no extra package. This page explains how sqlane uses your connections, when workers
wake up after a commit, and the details of each library.

- [Two pools](#two-pools)
- [What `enqueue` accepts](#what-enqueue-accepts)
- [Wake-up after the commit](#wake-up-after-the-commit)
- [Logs and plugins of your ORM](#logs-and-plugins-of-your-orm)
- Drivers: [mysql2](#mysql2), [pg](#pg), [postgres.js](#postgresjs)
- Query builders and ORMs: [Knex](#knex), [Kysely](#kysely), [Drizzle](#drizzle), [Prisma](#prisma),
  [Sequelize](#sequelize), [TypeORM](#typeorm), [MikroORM](#mikroorm)
- [Old import paths](#old-import-paths)

## Two pools

sqlane works with two kinds of connections.

- **Your app's connection.** You pass it to `enqueue`. It is usually the transaction in which you write your business
  data, so the job joins that transaction.
- **The queue's own pool.** You pass it once to the adapter, when you create the sqlane instance. sqlane uses it to
  find and claim jobs, to renew leases, to save results and to run `migrate()`. A lease is the time for which a
  process owns a running job.

Give the queue a small pool of its own, with 2 or 3 connections. Then the queue and your app do not wait for each
other's connections. With the `notify` option, the pg adapter, and the Drizzle adapter over node-postgres, also take
their LISTEN connection from this pool. postgres.js opens a separate connection for LISTEN. Your handlers do not use
the queue's pool. They open their own connections, usually from your app's pool.

```js
import mysql from 'mysql2/promise';
import { createSqlane } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';

const appPool = mysql.createPool({ uri: process.env.DATABASE_URL }); // your app's connection pool
const queuePool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 3 }); // the queue's own pool

const sqlane = createSqlane({ adapter: mysql2Adapter(queuePool), jobs: [buildReport] });
```

`close()` never ends your pools. Close them yourself after `sqlane.close()`.

## What `enqueue` accepts

`enqueue` takes a connection of the same library as the adapter. There are two cases.

- **A transaction, or a connection in a transaction.** The job joins your transaction. It commits or rolls back with
  your data.
- **A pool, or an ORM instance outside a transaction.** sqlane runs the insert in a short transaction of its own and
  commits it before `enqueue` returns. Use this case when the job does not belong to a business transaction.

A raw driver connection, such as a mysql2 `PoolConnection` or a pg `PoolClient`, must be in a transaction when you pass
it. sqlane cannot always detect a transaction on such a connection, so it trusts you. The sections below list what
each adapter accepts.

In the examples below, `buildReport` is the job definition from the [mysql2](#mysql2) example, and `reportId` is a
string id of your app (a `jobId` must be a string). `db`, `sql`, `prisma`, `sequelize`, `dataSource` and `orm` are your app's own instances, and
`reports` and `Report` are your app's table and model.

## Wake-up after the commit

A worker is a process that has called `start()`. Each worker checks the database for due jobs at least once per poll
interval, which is 5 seconds by default. This poll is the safety net, so a job always runs even if nothing wakes the
worker. sqlane adds faster signals on top of it.

**Workers in the same process.** sqlane wakes them in one of two ways.

- If sqlane can see the commit of your transaction, the workers check the database right after the commit.
- If sqlane cannot see the commit, the workers check the database a few times after the enqueue. These checks are
  called re-probes. They come 20 ms, 50 ms, 100 ms, 200 ms, 500 ms, 1 s and 2 s after the enqueue, but only the steps
  that are shorter than the poll interval. So the job usually starts about 25 ms after the commit.

**Workers in other processes.** They need a message to know about a new job. You have two options.

- A **hint** is a message over a publish/subscribe service that you provide, such as Redis. You pass it as the `hint` option of
  `createSqlane`. The receivers then check the database a few times, as above. See [`Hint`](api.md#hint).
- On PostgreSQL, **NOTIFY** does the same without any extra service. Set `{ notify: true }` on the pg, postgres.js or
  Drizzle adapter. PostgreSQL delivers the message at the commit, so other processes start the job within a few
  milliseconds. You cannot combine `notify` with the `hint` option.

Without a hint or NOTIFY, other processes find the job at their next poll. A lost message never loses a job, because
the job is in the database.

This table shows when sqlane can see the commit of your transaction.

| Library     | sqlane sees the commit of your transaction | `notify` option |
| ----------- | ------------------------------------------ | --------------- |
| mysql2      | No                                         | No              |
| pg          | No                                         | Yes             |
| postgres.js | No                                         | Yes             |
| Knex        | Yes, the commit of the outermost one       | No              |
| Kysely      | No                                         | No              |
| Drizzle     | No                                         | Yes, PostgreSQL |
| Prisma      | No                                         | No              |
| Sequelize   | Yes, the commit of the outermost one       | No              |
| TypeORM     | Yes, the commit of the outermost one       | No              |
| MikroORM    | Yes, except for a nested one in MikroORM 7 | No              |

An enqueue with a pool, or with an ORM instance outside a transaction, always wakes the workers at once, because its
own transaction has committed when `enqueue` returns. The [design](design.md#wake-up-after-the-commit) explains the
wake-up in detail.

## Logs and plugins of your ORM

sqlane runs its SQL on the driver connection under Knex, Drizzle and Sequelize. So these libraries do not log the SQL
of sqlane, and they do not change it. MikroORM uses Knex (MikroORM 6) or Kysely (MikroORM 7) underneath, and it does
not log or change the SQL of sqlane either.

With Kysely, sqlane runs its SQL through your Kysely instance, but without its plugins (`withoutPlugins()`). So a
plugin such as `CamelCasePlugin` does not change the SQL or the results. The `log` option of Kysely can still log the
SQL of sqlane.

With Prisma and TypeORM, sqlane uses their raw query APIs. They log the SQL of sqlane like any other raw query, and
Prisma client extensions can see it.

## mysql2

```js
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';
```

The adapter supports mysql2 3.11 and later, with its promise API. `mysql2Adapter(pool)` takes the queue's own `Pool`.

`enqueue` accepts a `Connection` or a `PoolConnection` in a transaction, or a `Pool`.

```js
import mysql from 'mysql2/promise';
import { createSqlane, defineJob } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';

// Shared by producers and workers
export const buildReport = defineJob({
    name: 'build_report',
    maxAttempts: 5,
    backoff: { type: 'exponential', delay: '5s', maxDelay: '1h' },
});

const appPool = mysql.createPool({ uri: process.env.DATABASE_URL }); // your app's connection pool
const queuePool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 3 }); // the queue's own pool
const sqlane = createSqlane({ adapter: mysql2Adapter(queuePool), jobs: [buildReport] });

await sqlane.migrate(); // or getMigrations({ dialect: 'mysql' }) for your own migration tool

// Producer: the report row and its job commit together, or neither does
export async function orderReport(reportId) {
    const connection = await appPool.getConnection();

    try {
        await connection.beginTransaction();
        await connection.query('INSERT INTO reports (id) VALUES (?)', [reportId]);
        await sqlane.enqueue(connection, buildReport, { reportId }, { jobId: reportId });
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

// Worker: in the same process or in another one
sqlane.handle(buildReport, async ({ payload, signal }) => {
    await generateReport(payload.reportId, { signal }); // your code: it stops when the signal aborts
}, { concurrency: 2, timeout: '5m' });
await sqlane.start();

process.once('SIGTERM', () => sqlane.close({ deadline: '30s' }));
```

**Wake-up.** sqlane cannot see the commit of a mysql2 connection. After an enqueue in a transaction, the workers of this
process check the database a few times, and the job starts about 25 ms after the commit. Other processes need a
[hint](api.md#hint), or they find the job at their next poll.

**Caveats.** A connection that you pass to `enqueue` must be in a transaction. MySQL gives sqlane no safe way to check
this.

## pg

```js
import { pgAdapter } from '@sqlane/core/adapter-pg';
```

The adapter supports pg (node-postgres) 8.13 and later. `pgAdapter(pool, { notify })` takes the queue's own `Pool`.

`enqueue` accepts a `Client` or a `PoolClient` in a transaction, or a `Pool`.

```js
import { Pool } from 'pg';
import { createSqlane } from '@sqlane/core';
import { pgAdapter } from '@sqlane/core/adapter-pg';

const appPool = new Pool({ connectionString: process.env.DATABASE_URL }); // your app's connection pool
const queuePool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 }); // the queue's own pool
const sqlane = createSqlane({ adapter: pgAdapter(queuePool, { notify: true }), jobs: [buildReport] });

const client = await appPool.connect();

try {
    await client.query('BEGIN');
    await client.query('INSERT INTO reports (id) VALUES ($1)', [reportId]);
    await sqlane.enqueue(client, buildReport, { reportId }, { jobId: reportId });
    await client.query('COMMIT');
} catch (error) {
    await client.query('ROLLBACK');
    throw error;
} finally {
    client.release();
}
```

**Wake-up.** sqlane cannot see the commit of a pg client, so the workers of this process check the database a few times
after the enqueue. With `{ notify: true }`, sqlane sends a PostgreSQL NOTIFY inside your transaction. PostgreSQL
delivers it at the commit, so workers in every process start the job within a few milliseconds.

**Caveats.** A client that you pass to `enqueue` must be in a transaction. With `notify`, sqlane keeps one connection of
the queue's pool for LISTEN, so give that pool at least 2 connections. Each enqueue that adds a job calls `pg_notify`.
PostgreSQL drops the duplicate notifications of a transaction, so it delivers one notification per transaction and job
name. NOTIFY takes a global lock at the commit, so under a heavy write load it can limit the commit rate of the whole
database.

## postgres.js

```js
import { postgresJsAdapter } from '@sqlane/core/adapter-postgres-js';
```

The adapter supports postgres.js (the `postgres` package) 3.4 and later, including version 4.
`postgresJsAdapter(sql, { notify })` takes the `sql` function that `postgres(…)` returns for the queue's own connection
pool.

`enqueue` accepts the `sql` of a transaction from `sql.begin(…)`, including a savepoint. It also accepts a reserved
connection in a transaction, or the `sql` of `postgres(…)`.

```js
import postgres from 'postgres';
import { createSqlane } from '@sqlane/core';
import { postgresJsAdapter } from '@sqlane/core/adapter-postgres-js';

const sql = postgres(process.env.DATABASE_URL); // your app's connection pool
const queueSql = postgres(process.env.DATABASE_URL, { max: 3 }); // the queue's own pool, which must not transform results

// With { notify: true }, NOTIFY wakes the workers at the commit. This also works after an enqueue in a transaction.
const sqlane = createSqlane({ adapter: postgresJsAdapter(queueSql, { notify: true }), jobs: [buildReport] });

await sql.begin(async (sql) => {
    await sql`INSERT INTO reports ${sql({ id: reportId })}`;
    await sqlane.enqueue(sql, buildReport, { reportId }, { jobId: reportId });
});
```

**Wake-up.** postgres.js has no after-commit hook, so the workers of this process check the database a few times after
an enqueue in a transaction. With `{ notify: true }`, PostgreSQL wakes the workers of every process at the commit.

**Caveats.** The queue's own `postgres(…)` must not transform results, because sqlane reads its own column names.
`postgresJsAdapter` throws a `ConfigError` if it has a `transform` of columns, values or rows. Your app's `sql` can
keep its transform. A reserved connection (`sql.reserve()`) must be in a transaction when you pass it. With `notify`, NOTIFY takes a global lock at the commit, so under a heavy write load it can limit the commit rate of the whole
database.

## Knex

```js
import { knexAdapter } from '@sqlane/core/adapter-knex';
```

The adapter supports knex 3 with the `mysql2` or `pg` client. `knexAdapter(knex)` takes the queue's own knex instance.

`enqueue` accepts a knex instance or a knex transaction. The transaction can be nested.

```js
import knex from 'knex';
import { createSqlane } from '@sqlane/core';
import { knexAdapter } from '@sqlane/core/adapter-knex';

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL }); // your app's connection pool
const queueDb = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { max: 3 } }); // the queue's own pool
const sqlane = createSqlane({ adapter: knexAdapter(queueDb), jobs: [buildReport] });

await db.transaction(async (trx) => {
    await trx('reports').insert({ id: reportId });
    await sqlane.enqueue(trx, buildReport, { reportId }, { jobId: reportId });
});
```

**Wake-up.** sqlane waits for the commit of the outermost knex transaction, then wakes the workers at once. A nested
transaction is a savepoint, and the outer transaction can still roll back, so sqlane ignores its end.

**Caveats.** On PostgreSQL, knex also resolves a transaction when the server turned the `COMMIT` into a `ROLLBACK`.
In that case, the workers check the database once and find nothing. This costs one query and is harmless.

## Kysely

```js
import { kyselyAdapter } from '@sqlane/core/adapter-kysely';
```

The adapter supports kysely 0.28 and 0.29, with a MySQL or PostgreSQL dialect. It also works over postgres.js with
`kysely-postgres-js`. `kyselyAdapter(db, { dialect })` takes the queue's own Kysely instance.

`enqueue` accepts a Kysely instance or a Kysely transaction. The transaction can also be a controlled one, from
`db.startTransaction()`.

```js
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { createSqlane } from '@sqlane/core';
import { kyselyAdapter } from '@sqlane/core/adapter-kysely';

// queueDb is the queue's own Kysely instance. Kysely does not expose its dialect, so you pass it.
const queueDb = new Kysely({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL, max: 3 }) }),
});
const sqlane = createSqlane({ adapter: kyselyAdapter(queueDb, { dialect: 'postgres' }), jobs: [buildReport] });

await db.transaction().execute(async (trx) => {
    await trx.insertInto('reports').values({ id: reportId }).execute();
    await sqlane.enqueue(trx, buildReport, { reportId }, { jobId: reportId });
});
```

**Wake-up.** Kysely has no after-commit hook. After an enqueue in a transaction, the workers of this process check the
database a few times. Other processes need a [hint](api.md#hint).

**Caveats.** The `dialect` option is required and must be `'mysql'` or `'postgres'`. sqlane runs its SQL without your
Kysely plugins, so a `CamelCasePlugin` does not rename the columns that sqlane reads.

## Drizzle

```js
import { drizzleAdapter } from '@sqlane/core/adapter-drizzle';
```

The adapter supports drizzle-orm 0.45 and 1.0 (release candidate), over mysql2, node-postgres or postgres.js.
`drizzleAdapter(db, { notify })` takes the queue's own Drizzle database.

`enqueue` accepts a Drizzle database or a Drizzle transaction. The transaction can be nested.

```js
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createSqlane } from '@sqlane/core';
import { drizzleAdapter } from '@sqlane/core/adapter-drizzle';

// queueDb is the queue's own Drizzle database, and it must use a pool.
const queueDb = drizzle({ client: new Pool({ connectionString: process.env.DATABASE_URL, max: 3 }) });
// On PostgreSQL, you can also pass { notify: true }.
const sqlane = createSqlane({ adapter: drizzleAdapter(queueDb), jobs: [buildReport] });

await db.transaction(async (tx) => {
    await tx.insert(reports).values({ id: reportId });
    await sqlane.enqueue(tx, buildReport, { reportId }, { jobId: reportId });
});
```

**Wake-up.** Drizzle has no after-commit hook. After an enqueue in a transaction, the workers of this process check the
database a few times. On PostgreSQL, `{ notify: true }` wakes the workers of every process at the commit.

**Caveats.** The queue's Drizzle database must be over a pool, not over a single connection. `notify` is for
PostgreSQL only, and the adapter throws a `ConfigError` if you set it on MySQL. NOTIFY takes a global lock at the commit, so under a heavy write load it can limit the commit rate of the whole
database.

## Prisma

```js
import { prismaAdapter } from '@sqlane/core/adapter-prisma';
```

The adapter supports Prisma 7 on MySQL or PostgreSQL. On MySQL, Prisma 7 connects through its
`@prisma/adapter-mariadb` driver adapter, which also works with MySQL servers. sqlane is tested with it, and with
`@prisma/adapter-pg` on PostgreSQL. `prismaAdapter(prisma, { dialect })` takes the queue's own Prisma client.

`enqueue` accepts a Prisma client, or the client of an interactive transaction from
`prisma.$transaction(async (tx) => …)`.

```js
import { PrismaPg } from '@prisma/adapter-pg';
import { createSqlane } from '@sqlane/core';
import { prismaAdapter } from '@sqlane/core/adapter-prisma';
// PrismaClient comes from the output folder of your Prisma generator.
import { PrismaClient } from './generated/prisma/client.js';

// queuePrisma is the queue's own Prisma client, with a small pool.
const queuePrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 3 }) });
// Prisma does not expose its provider, so you pass the dialect.
const sqlane = createSqlane({ adapter: prismaAdapter(queuePrisma, { dialect: 'postgres' }), jobs: [buildReport] });

await prisma.$transaction(async (tx) => {
    await tx.report.create({ data: { id: reportId } });
    await sqlane.enqueue(tx, buildReport, { reportId }, { jobId: reportId });
});
```

**Wake-up.** Prisma has no after-commit hook. After an enqueue in a transaction, the workers of this process check the
database a few times. Other processes need a [hint](api.md#hint).

**Caveats.** List the tables of sqlane as
[external tables](https://www.prisma.io/docs/orm/prisma-schema/data-model/externally-managed-tables). Then Prisma
Migrate leaves them alone, and `sqlane.migrate()` creates them. External tables are a Preview feature of Prisma, so
they need the `externalTables` flag. This example is for PostgreSQL with the default `tablePrefix`:

```ts
// prisma.config.ts
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
    schema: 'prisma/schema.prisma',
    datasource: { url: env('DATABASE_URL') },
    experimental: { externalTables: true },
    tables: { external: ['public.sqlane_jobs', 'public.sqlane_payloads', 'public.sqlane_mutexes', 'public.sqlane_migrations'] },
});
```

Prisma has no connection outside a transaction, so `migrate()` runs in one transaction. The `dialect` option is
required and must be `'mysql'` or `'postgres'`.

## Sequelize

```js
import { sequelizeAdapter } from '@sqlane/core/adapter-sequelize';
```

The adapter supports Sequelize 6 with MySQL (mysql2) or PostgreSQL (pg). `sequelizeAdapter(sequelize)` takes the
queue's own Sequelize instance.

`enqueue` accepts a Sequelize instance or a Sequelize transaction. The transaction can be nested.

```js
import { createSqlane } from '@sqlane/core';
import { sequelizeAdapter } from '@sqlane/core/adapter-sequelize';

// queueSequelize is the queue's own Sequelize instance.
const sqlane = createSqlane({ adapter: sequelizeAdapter(queueSequelize), jobs: [buildReport] });

await sequelize.transaction(async (t) => {
    await Report.create({ id: reportId }, { transaction: t });
    await sqlane.enqueue(t, buildReport, { reportId }, { jobId: reportId });
});
```

**Wake-up.** sqlane uses the `afterCommit` hook of the outermost transaction, so the workers wake at once after the
commit. Sequelize also runs this hook when the `COMMIT` fails. In that case, the workers check the database once and
find nothing.

**Caveats.** With CLS (`Sequelize.useCLS()`), `enqueue` follows the same rule as the queries of Sequelize. If you pass
the instance while a CLS transaction runs, the job joins that transaction.

```js
import { createNamespace } from 'cls-hooked';

Sequelize.useCLS(createNamespace('app')); // You set it on the class, so all instances share it.

await sequelize.transaction(async () => {
    await Report.create({ id: reportId }); // This query runs in the CLS transaction.
    // This job joins the CLS transaction, so it commits or rolls back with the report.
    await sqlane.enqueue(sequelize, buildReport, { reportId });
});

// Outside a CLS transaction, sqlane uses a transaction of its own.
await sqlane.enqueue(sequelize, buildReport, { reportId });
```

A CLS transaction belongs to one Sequelize instance. The queue has its own instance, so always pass your app's
instance, or its transaction, to `enqueue`.

## TypeORM

```js
import { typeOrmAdapter } from '@sqlane/core/adapter-typeorm';
```

The adapter supports TypeORM 0.3 and 1.x, with MySQL (mysql2) or PostgreSQL. `typeOrmAdapter(dataSource)` takes the
queue's own `DataSource`, which must be initialized.

`enqueue` accepts the `EntityManager` of a transaction, a `QueryRunner` in a transaction, or a `DataSource`. An
`EntityManager` outside a transaction gets a transaction of its own.

```js
import { createSqlane } from '@sqlane/core';
import { typeOrmAdapter } from '@sqlane/core/adapter-typeorm';

// queueDataSource must be initialized.
const sqlane = createSqlane({ adapter: typeOrmAdapter(queueDataSource), jobs: [buildReport] });

await dataSource.transaction(async (manager) => {
    await manager.save(Report, { id: reportId });
    await sqlane.enqueue(manager, buildReport, { reportId }, { jobId: reportId });
});
```

**Wake-up.** The workers wake at once after the commit of the outermost transaction. The release of a savepoint does
not count as a commit.

**Caveats.** To see the commit, the adapter adds a subscriber to the `DataSource` of your transaction, for its
`afterTransactionCommit` event. It adds this subscriber once per `DataSource`.

## MikroORM

```js
import { mikroOrmAdapter } from '@sqlane/core/adapter-mikro-orm';
```

The adapter supports MikroORM 6 and 7, with `@mikro-orm/mysql` or `@mikro-orm/postgresql`.
`mikroOrmAdapter(em, { dialect })` takes the `EntityManager` of the queue's own MikroORM instance.

`enqueue` accepts an `EntityManager`. If it is in a transaction, the job joins that transaction. Otherwise, the enqueue
runs in a transaction of its own.

```js
import { createSqlane } from '@sqlane/core';
import { mikroOrmAdapter } from '@sqlane/core/adapter-mikro-orm';

// queueOrm is the queue's own MikroORM instance. The dialect must match its driver.
const sqlane = createSqlane({ adapter: mikroOrmAdapter(queueOrm.em, { dialect: 'postgres' }), jobs: [buildReport] });

await orm.em.transactional(async (em) => {
    em.persist(em.create(Report, { id: reportId }));
    await sqlane.enqueue(em, buildReport, { reportId }, { jobId: reportId });
});
```

**Wake-up.** The workers wake at once after the commit of the outermost transaction. In MikroORM 7, an enqueue in a
nested transaction (a savepoint) cannot see the outer commit, so the workers check the database a few times instead.

**Caveats.** Inside `em.transactional()`, the global `EntityManager` refers to the current transaction, as it does
for MikroORM's own queries. So `sqlane.enqueue(orm.em, …)` there commits or rolls back with that transaction. `em.begin()` and
`em.commit()` on a fork work too. The `dialect` option is required and must match the driver of MikroORM.

## Old import paths

Before version 0.4, the mysql2, pg and Knex adapters had the shorter import paths `@sqlane/core/mysql2`,
`@sqlane/core/pg` and `@sqlane/core/knex`. These paths will keep working until version 1.0. New code should use the `adapter-` paths, such as
`@sqlane/core/adapter-mysql2`.
