# sqlane

Transactional SQL job queue for Node.js, backed by MySQL or PostgreSQL.

> **Warning: not ready for production.** sqlane is in active development (0.x) and not stable yet: the API and the database
> schema can still change in any minor version, and no production deployment has proven it yet. Try it, give feedback,
> but do not run production workloads on it yet. See the [design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md).

- Enqueue a job in your business transaction: no commit, no job.
- Many job names at low cost: idle names add no load to the database.
- Low latency: a job starts milliseconds after the commit in the same process, and in other processes with PostgreSQL
  NOTIFY or a `hint` transport. Without them, other processes see it at their next poll (default 5 s). See
  [wake after commit](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#wake-after-commit).
- Mutex keys: jobs with a common key do not run at the same time, in the whole cluster, as long as handlers stop on
  their `signal` (lease lost, shutdown). See [guarantees](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md#guarantees).
- MySQL 8.4+ and PostgreSQL 15+, with mysql2, pg, postgres.js, Knex, Kysely, Drizzle, Prisma, Sequelize, TypeORM or
  MikroORM. Node.js 22+. MIT license.

## Quickstart

Needs Docker and Node.js 22+. On MySQL:

```sh
git clone https://github.com/sqlane/sqlane-node.git
cd sqlane-node/examples/quickstart
npm install
docker compose up --detach --wait mysql
npm run mysql
```

On PostgreSQL: `docker compose up --detach --wait postgres`, then `npm run postgres`. The output (MySQL):

```text
1. Commit: order 1 and its job
   send_receipt of order 1 ran 26 ms after the commit
2. Rollback: order 2 and its job
   rolled back: payment declined
   order 2: 0 rows in orders, 0 jobs
3. Mutex keys: 3 syncs of order 1, 1 sync of order 3
     0 ms  sync of order 1 starts
     0 ms  sync of order 3 starts
   201 ms  sync of order 1 ends
   201 ms  sync of order 3 ends
   227 ms  sync of order 1 starts
   427 ms  sync of order 1 ends
   451 ms  sync of order 1 starts
   653 ms  sync of order 1 ends
   order 1: at most 1 sync at a time; order 3 ran alongside: yes
```

What happened, in [`mysql.js`](https://github.com/sqlane/sqlane-node/blob/main/examples/quickstart/mysql.js):

1. The order and its `send_receipt` job were inserted in one transaction. The worker, in the same process here, ran
   the job right after the commit.
2. The second transaction threw after its enqueue: the rollback removed the order and the job. No job runs for data
   that does not exist.
3. `sync_order` has the mutex key `order:<id>`: the three syncs of order 1 ran one after another, the sync of order 3
   alongside the first.

Down: `docker compose down --volumes`.

## Usage

```sh
npm install @sqlane/core mysql2   # or pg, postgres (postgres.js); or the adapter of your ORM, below
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

const appPool = mysql.createPool({ uri: process.env.DATABASE_URL }); // your app's pool
const queuePool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 3 }); // the queue's own
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

// Worker: in the same process or another one
sqlane.handle(buildReport, async ({ payload, signal }) => {
    await generateReport(payload.reportId, { signal }); // your code: stops when signal aborts
}, { concurrency: 2, timeout: '5m' });
await sqlane.start();

process.once('SIGTERM', () => sqlane.close({ deadline: '30s' }));
```

TypeScript: `defineJob<{ reportId: string }>({ name: 'build_report' })` declares the payload (in JSDoc:
`/** @type {JobDefinition<{ reportId: string }>} */` on the constant). `enqueue` then checks it, and the handler and
`mutexKeys` get it typed. Without one, any JSON payload, and the handler gets `any`.

In tests, run the due jobs without `start()`: `await sqlane.drain()`. More in [`examples/`](https://github.com/sqlane/sqlane-node/tree/main/examples).

## Adapters

| Import                             | `enqueue` takes                                                          | Supported                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `@sqlane/core/adapter-mysql2`      | a mysql2 `Connection` or `PoolConnection` (in a transaction), a `Pool`   | mysql2 3.11+                                                                 |
| `@sqlane/core/adapter-pg`          | a pg `Client` or `PoolClient` (in a transaction), a `Pool`               | pg 8.13+                                                                     |
| `@sqlane/core/adapter-postgres-js` | the `sql` of a transaction (also a savepoint), the `sql` of `postgres()` | postgres.js 3.4, 4                                                           |
| `@sqlane/core/adapter-knex`        | a knex transaction (also nested), a knex instance                        | knex 3, with mysql2 or pg                                                    |
| `@sqlane/core/adapter-kysely`      | a Kysely transaction (also controlled), a Kysely instance                | kysely 0.28, 0.29: MySQL and PostgreSQL dialects (also `kysely-postgres-js`) |
| `@sqlane/core/adapter-drizzle`     | a Drizzle transaction (also nested), a Drizzle database                  | drizzle-orm 0.45, 1.0 (rc): mysql2, node-postgres or postgres.js             |
| `@sqlane/core/adapter-prisma`      | the client of an interactive transaction, a Prisma client                | Prisma 7: MySQL or PostgreSQL                                                |
| `@sqlane/core/adapter-sequelize`   | a Sequelize transaction (also nested), a Sequelize instance              | Sequelize 6: MySQL or PostgreSQL                                             |
| `@sqlane/core/adapter-typeorm`     | the EntityManager or QueryRunner of a transaction, a DataSource          | TypeORM 0.3, 1.x: MySQL (mysql2) or PostgreSQL                               |
| `@sqlane/core/adapter-mikro-orm`   | an EntityManager: of a transaction, or outside one                       | MikroORM 6, 7: `@mikro-orm/mysql` or `/postgresql`                           |

The paths before 0.4 (`@sqlane/core/mysql2`, `/pg`, `/knex`) still work, until 1.0.

With a pool (also the `sql` of `postgres()`), or a knex, Kysely, Drizzle, Prisma, Sequelize or TypeORM instance, or a
MikroORM EntityManager outside a transaction, the enqueue runs in a transaction of its own and the workers wake at once.
With a knex, Sequelize, TypeORM or MikroORM transaction, they wake at once after the commit of the outermost one
(MikroORM 7: unless the enqueue ran in a nested one). With a connection of a driver (also a postgres.js transaction),
or a Kysely, Drizzle or Prisma transaction, sqlane cannot see the commit: the workers re-probe after the enqueue (about
20 ms). On PostgreSQL, `{ notify: true }` of the pg, postgres.js and Drizzle adapters wakes them at the commit.

```js
import { postgresJsAdapter } from '@sqlane/core/adapter-postgres-js';

// The queue's own postgres(…), without a `transform` of results. { notify: true }: NOTIFY wakes the workers at the
// commit, also after an enqueue in a transaction.
const sqlane = createSqlane({ adapter: postgresJsAdapter(queueSql, { notify: true }), jobs: [buildReport] });

await sql.begin(async (sql) => {
    await sql`INSERT INTO reports ${sql({ id: reportId })}`;
    await sqlane.enqueue(sql, buildReport, { reportId }, { jobId: reportId });
});
```

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

With CLS, `enqueue` follows the rule of Sequelize's own queries: the instance means the CLS transaction, if one runs.

```js
import { createNamespace } from 'cls-hooked';

Sequelize.useCLS(createNamespace('app')); // on the class: all the instances share it

await sequelize.transaction(async () => {
    await Report.create({ id: reportId }); // in the CLS transaction
    await sqlane.enqueue(sequelize, buildReport, { reportId }); // in it too: commits or rolls back with the report
});

await sqlane.enqueue(sequelize, buildReport, { reportId }); // no CLS transaction: a transaction of its own
```

The CLS transaction of another Sequelize instance does not count: with a queue instance of its own, enqueue with the
app's instance (or its transaction).

```js
import { typeOrmAdapter } from '@sqlane/core/adapter-typeorm';

const sqlane = createSqlane({ adapter: typeOrmAdapter(queueDataSource), jobs: [buildReport] }); // initialized

await dataSource.transaction(async (manager) => {
    await manager.save(Report, { id: reportId });
    await sqlane.enqueue(manager, buildReport, { reportId }, { jobId: reportId });
});
```

The adapter adds a subscriber to the DataSource of a transaction, for its `afterTransactionCommit`.

```js
import { mikroOrmAdapter } from '@sqlane/core/adapter-mikro-orm';

// The EntityManager of the queue's own MikroORM; the dialect: its driver, @mikro-orm/mysql or @mikro-orm/postgresql
const sqlane = createSqlane({ adapter: mikroOrmAdapter(queueOrm.em, { dialect: 'postgres' }), jobs: [buildReport] });

await orm.em.transactional(async (em) => {
    em.persist(em.create(Report, { id: reportId }));
    await sqlane.enqueue(em, buildReport, { reportId }, { jobId: reportId });
});
```

As MikroORM's own queries, the global EntityManager inside `em.transactional()` means its transaction:
`sqlane.enqueue(orm.em, …)` there commits or rolls back with it. `em.begin()` and `em.commit()` work too.

The SQL of sqlane runs on the driver connection under knex, Drizzle and Sequelize, through Kysely without its plugins
(also under MikroORM: knex in MikroORM 6, Kysely in 7), and through the raw queries of Prisma and TypeORM: they do not
log it or transform it.

## Guarantees and limits

- **At least once.** A committed job runs at least once, also after a crash; it can run twice. Handlers must be
  idempotent.
- **Mutex keys** hold while handlers stop on their `signal` (timeout, lease lost, shutdown).
- **Not included:** cron, priorities, a dashboard, workflows, a cluster-wide concurrency limit per job name. MariaDB
  and SQLite.
- **Supported:** Node.js 22.12+, MySQL 8.4+, PostgreSQL 15+.

The details: [design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md) (guarantees, leases, wake-up,
schema).

## Performance

On a laptop (M1 Pro, Docker, default config), details in [benchmarks](https://github.com/sqlane/sqlane-node/blob/main/docs/benchmarks.md):

- 1000 handled job names, 10 with pending jobs: the probe takes under 1 ms. Idle names cost nothing.
- From commit to handler start: about 25 ms (re-probe or hint), about 5 ms with PostgreSQL NOTIFY.
- `enqueueMany`: 58,000–110,000 jobs/s. Empty jobs, one process: 1,000–1,800 jobs/s at concurrency 10,
  3,800–5,800 at concurrency 50.

## Contributing

See [CONTRIBUTING.md](https://github.com/sqlane/sqlane-node/blob/main/CONTRIBUTING.md): setup, commands, commits and
changesets.

## License

[MIT](https://github.com/sqlane/sqlane-node/blob/main/LICENSE)
