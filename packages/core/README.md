# @sqlane/core

Transactional SQL job queue for Node.js, backed by MySQL or PostgreSQL.

> Early version (0.x): the API can still change. See the [design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md).

- Enqueue a job in your business transaction: no commit, no job.
- Many job names at low cost: idle names add no load to the database.
- Low latency: a job starts in milliseconds after the commit.
- Mutex keys: jobs with a common key never run at the same time, in the whole cluster.
- MySQL 8.4+ and PostgreSQL 15+, with `mysql2` or `pg`. Node.js 22+. MIT license.

## Usage

```sh
npm install @sqlane/core mysql2   # or pg
```

```js
import mysql from 'mysql2/promise';
import { createSqlane, defineJob } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2'; // or pgAdapter from '@sqlane/core/adapter-pg'

// Shared by producers and workers
export const buildReport = defineJob({
    name: 'build_report',
    maxAttempts: 5,
    backoff: { type: 'exponential', delay: '5s', maxDelay: '1h' },
});

const queuePool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 3 });
const sqlane = createSqlane({ adapter: mysql2Adapter(queuePool), jobs: [buildReport] });

await sqlane.migrate(); // or getMigrations({ dialect: 'mysql' }) for your own migration tool

// Producer: with the connection of your transaction
await connection.beginTransaction();
await connection.query('INSERT INTO reports (id) VALUES (?)', [reportId]);
await sqlane.enqueue(connection, buildReport, { reportId }, { jobId: reportId });
await connection.commit();

// Worker
sqlane.handle(buildReport, async ({ payload, signal }) => {
    await build(payload.reportId, { signal });
}, { concurrency: 2, timeout: '5m' });
await sqlane.start();

process.once('SIGTERM', () => sqlane.close({ deadline: '30s' }));
```

In tests, run the due jobs without `start()`: `await sqlane.drain()`. More in [`examples/`](https://github.com/sqlane/sqlane-node/tree/main/packages/core/examples).

## Adapters

| Import                           | `enqueue` takes                                                        | Supported                                             |
| -------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| `@sqlane/core/adapter-mysql2`    | a mysql2 `Connection` or `PoolConnection` (in a transaction), a `Pool` | mysql2 3.11+                                          |
| `@sqlane/core/adapter-pg`        | a pg `Client` or `PoolClient` (in a transaction), a `Pool`             | pg 8.13+                                              |
| `@sqlane/core/adapter-knex`      | a knex transaction (also nested), a knex instance                      | knex 3, with mysql2 or pg                             |
| `@sqlane/core/adapter-kysely`    | a Kysely transaction (also controlled), a Kysely instance              | kysely 0.28, 0.29: MySQL and PostgreSQL dialects      |
| `@sqlane/core/adapter-drizzle`   | a Drizzle transaction (also nested), a Drizzle database                | drizzle-orm 0.45, 1.0 (beta): mysql2 or node-postgres |
| `@sqlane/core/adapter-prisma`    | the client of an interactive transaction, a Prisma client              | Prisma 7: MySQL or PostgreSQL                         |
| `@sqlane/core/adapter-sequelize` | a Sequelize transaction (also nested), a Sequelize instance            | Sequelize 6: MySQL or PostgreSQL                      |

The paths before 0.4 (`@sqlane/core/mysql2`, `/pg`, `/knex`) still work, until 1.0.

With a pool, or a knex, Kysely, Drizzle, Prisma or Sequelize instance, the enqueue runs in a transaction of its own and
the workers wake at once. With a knex or Sequelize transaction, they wake at once after the commit of the outermost one. With a connection of a
driver, or a Kysely, Drizzle or Prisma transaction, sqlane cannot see the commit: the workers re-probe after the enqueue
(about 20 ms).

```js
import { knexAdapter } from '@sqlane/core/adapter-knex';

const sqlane = createSqlane({ adapter: knexAdapter(queueKnex), jobs: [buildReport] }); // the queue's own knex

await knex.transaction(async (trx) => {
    await trx('reports').insert({ id: reportId });
    await sqlane.enqueue(trx, buildReport, { reportId }, { jobId: reportId });
});
```

```js
import { kyselyAdapter } from '@sqlane/core/adapter-kysely';

// The queue's own Kysely; Kysely does not tell its dialect
const sqlane = createSqlane({ adapter: kyselyAdapter(queueDb, { dialect: 'postgres' }), jobs: [buildReport] });

await db.transaction().execute(async (trx) => {
    await trx.insertInto('reports').values({ id: reportId }).execute();
    await sqlane.enqueue(trx, buildReport, { reportId }, { jobId: reportId });
});
```

```js
import { drizzleAdapter } from '@sqlane/core/adapter-drizzle';

// The queue's own Drizzle database, over a pool. With node-postgres, also { notify: true }.
const sqlane = createSqlane({ adapter: drizzleAdapter(queueDb), jobs: [buildReport] });

await db.transaction(async (tx) => {
    await tx.insert(reports).values({ id: reportId });
    await sqlane.enqueue(tx, buildReport, { reportId }, { jobId: reportId });
});
```

```js
import { prismaAdapter } from '@sqlane/core/adapter-prisma';

// The queue's own Prisma client; Prisma does not tell its provider
const sqlane = createSqlane({ adapter: prismaAdapter(queuePrisma, { dialect: 'postgres' }), jobs: [buildReport] });

await prisma.$transaction(async (tx) => {
    await tx.report.create({ data: { id: reportId } });
    await sqlane.enqueue(tx, buildReport, { reportId }, { jobId: reportId });
});
```

With Prisma, list the tables of sqlane as
[external tables](https://www.prisma.io/docs/orm/prisma-schema/data-model/externally-managed-tables): Prisma Migrate
leaves them alone, and `sqlane.migrate()` creates them.

```ts
// prisma.config.ts
export default defineConfig({
    schema: 'prisma/schema.prisma',
    tables: { external: ['public.sqlane_jobs', 'public.sqlane_payloads', 'public.sqlane_mutexes', 'public.sqlane_migrations'] },
});
```

```js
import { sequelizeAdapter } from '@sqlane/core/adapter-sequelize';

const sqlane = createSqlane({ adapter: sequelizeAdapter(queueSequelize), jobs: [buildReport] }); // the queue's own

await sequelize.transaction(async (t) => {
    await Report.create({ id: reportId }, { transaction: t });
    await sqlane.enqueue(t, buildReport, { reportId }, { jobId: reportId });
});
```

With CLS (`Sequelize.useCLS()`), pass the transaction to `enqueue`: an instance means a transaction of its own.

The SQL of sqlane runs on the driver connection under knex, Drizzle and Sequelize, through Kysely without its plugins,
and through the raw queries of Prisma: they do not log it or transform it. TypeORM and MikroORM: later.

## Performance

On a laptop (M1 Pro, Docker, default config), details in [benchmarks](https://github.com/sqlane/sqlane-node/blob/main/docs/benchmarks.md):

- 1000 handled job names, 10 with pending jobs: the probe takes under 1 ms. Idle names cost nothing.
- From commit to handler start: about 25 ms (re-probe or hint), about 5 ms with PostgreSQL NOTIFY.
- `enqueueMany`: 58,000–110,000 jobs/s. Empty jobs, one process: 1,000–1,800 jobs/s at concurrency 10,
  3,800–5,800 at concurrency 50.

## License

[MIT](LICENSE)
