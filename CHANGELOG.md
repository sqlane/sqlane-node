# @sqlane/core

## 0.9.0

### Minor Changes

- [#74](https://github.com/sqlane/sqlane-node/pull/74) [`a11a898`](https://github.com/sqlane/sqlane-node/commit/a11a89828bf80772c03197c0d73d9376e3edd8d9) - Breaking: `wake()` takes no job name. It always checked all the names that the process handles, so a name had no effect.
  JavaScript calls that still pass a name keep working; TypeScript reports them.

    The `stalled` and `failed` events of stall recovery now have the attempt of the run that stalled, instead of `0`. The
    `failed` event also has the time since that run started as `durationMs`.

    `FailedJobPayload.error` now lists `code`: the string `code` of the thrown error, if it had one.

    `close()` now logs a warning for every invalid option, including an unknown one, and uses its default. Before, an invalid
    `deadline` or `mode` silently became the default. `close()` still never rejects because of its options.

- [#72](https://github.com/sqlane/sqlane-node/pull/72) [`4ed7412`](https://github.com/sqlane/sqlane-node/commit/4ed741275ca99367aad2996471eb034062c4b7e1) - Breaking: the import paths from before 0.4 are gone. Use `@sqlane/core/adapter-mysql2` instead of `@sqlane/core/mysql2`,
  `@sqlane/core/adapter-pg` instead of `@sqlane/core/pg`, and `@sqlane/core/adapter-knex` instead of `@sqlane/core/knex`.

### Patch Changes

- [#69](https://github.com/sqlane/sqlane-node/pull/69) [`f7a8423`](https://github.com/sqlane/sqlane-node/commit/f7a8423a429118a33bd0aba95536ce9819cf69a1) - A handler is now aborted with a `LeaseLostError` (and `lease_lost` is emitted) before its lease ends when the lease renewal fails or hangs, for example when the database is unreachable or the pool has no free connection. Before, a renewal that threw or never returned skipped this check, so the handler kept running after another process could take its job.

- [#73](https://github.com/sqlane/sqlane-node/pull/73) [`4436868`](https://github.com/sqlane/sqlane-node/commit/443686844efab6c1b98597f632614e4774d0d246) - The leases of running jobs are now also renewed while `close()` waits for the handlers and during `drain()`. Before, a
  handler that ran longer than a lease (4 minutes) during a long `close()` deadline or a `drain()` could lose its job to
  another process without being aborted.

- [#71](https://github.com/sqlane/sqlane-node/pull/71) [`27ea7c3`](https://github.com/sqlane/sqlane-node/commit/27ea7c3b398768c434607f24531981782a4e7b15) - A new README: what sqlane is and when to use it, a short example, getting started, and links to the new API reference,
  adapter guide and comparison with other queues.

## 0.8.1

### Patch Changes

- [#66](https://github.com/sqlane/sqlane-node/pull/66) [`29da43c`](https://github.com/sqlane/sqlane-node/commit/29da43ce792e761b8c4037be1164c60e53a86148) - README: badges, the versioning policy until 1.0 (a minor can break, a patch cannot, schema changes are migrations), and
  where to get support or report a vulnerability.

## 0.8.0

### Minor Changes

- [#64](https://github.com/sqlane/sqlane-node/pull/64) [`1a02e09`](https://github.com/sqlane/sqlane-node/commit/1a02e09772937659802f549fa9832020f80bc24a) - Typed payloads, optional: `defineJob<{ reportId: string }>(…)` (or the JSDoc type `JobDefinition<{ reportId: string }>`)
  declares the payload of a job. `enqueue` and `enqueueMany` then check the payload against it, and the handler's
  `payload` and the argument of `mutexKeys` have its type. A definition without one, and a job by name, work as before:
  any JSON payload, `any` in the handler. `JobOptions`, `JobDefinition`, `Handler` and `HandlerContext` take the payload
  as an optional type parameter.

### Patch Changes

- [#61](https://github.com/sqlane/sqlane-node/pull/61) [`0d4c222`](https://github.com/sqlane/sqlane-node/commit/0d4c222aa0e7a89ccad5af18728613939a422855) - README: sqlane is not ready for production yet (0.x, in active development). The latency and mutex key claims now say
  when they hold.

- [#63](https://github.com/sqlane/sqlane-node/pull/63) [`03f8bc9`](https://github.com/sqlane/sqlane-node/commit/03f8bc9cdbb4af35ae5009cce88a4752a778bf65) - README: a link to the runnable quickstart, and a usage example that defines all it uses.

- [#65](https://github.com/sqlane/sqlane-node/pull/65) [`bb1dee8`](https://github.com/sqlane/sqlane-node/commit/bb1dee856e917c3f95cb69803c6d443dddd811e9) - The repository is a single package now, at its root: the npm page links to the repository root, and the README is the
  one of the repository. No change of the code.

## 0.7.0

### Minor Changes

- [#59](https://github.com/sqlane/sqlane-node/pull/59) [`60d8ddb`](https://github.com/sqlane/sqlane-node/commit/60d8ddb1700ee8aa05156ef50cd48b3a8a8998b9) - The postgres.js adapter: `import { postgresJsAdapter } from '@sqlane/core/adapter-postgres-js'`, then
  `postgresJsAdapter(sql)`. `enqueue` takes the `sql` of postgres.js (a transaction of its own) or the `sql` of a
  transaction (`sql.begin`, also a savepoint). `{ notify: true }` sends the hints by NOTIFY. postgres.js 3.4 and 4.

    The Drizzle adapter takes Drizzle over postgres.js too (`drizzle-orm/postgres-js`). Kysely over postgres.js
    (`kysely-postgres-js`) works with the Kysely adapter.

    On PostgreSQL, the JSON parameters of sqlane's SQL are sent as text (`$1::text::jsonb`): a driver that serializes a
    `jsonb` parameter itself (postgres.js) gets the JSON string as it is.

## 0.6.0

### Minor Changes

- [#56](https://github.com/sqlane/sqlane-node/pull/56) [`4b85db2`](https://github.com/sqlane/sqlane-node/commit/4b85db23811a34b518b30b21f7c321b632fc64f5) - Faster claims of job names without mutex keys: the due jobs are found, claimed and read at once. On PostgreSQL, one
  statement replaces four statements and a transaction; on MySQL, one locking read replaces two queries. Throughput with
  an empty handler: +30–90% on PostgreSQL, +10–25% on MySQL (docs/benchmarks.md).

    The keys in the rows of a name whose definition (in the claiming process) has no mutex keys are no longer taken: the
    definition decides. This matters only while a deploy removes the mutex keys of a definition.

## 0.5.0

### Minor Changes

- [#39](https://github.com/sqlane/sqlane-node/pull/39) [`d69da6c`](https://github.com/sqlane/sqlane-node/commit/d69da6c7926087b3ef4681156d45566d9acfb8eb) - The Drizzle adapter: `import { drizzleAdapter } from '@sqlane/core/adapter-drizzle'`, then `drizzleAdapter(db)`.
  `enqueue` takes a Drizzle database (a transaction of its own) or a Drizzle transaction, also nested. drizzle-orm 0.45
  and 1.0 (beta), with mysql2 or node-postgres; with node-postgres, `{ notify: true }` sends the hints by NOTIFY.

- [#47](https://github.com/sqlane/sqlane-node/pull/47) [`856f710`](https://github.com/sqlane/sqlane-node/commit/856f710932ba4c39f82ea35c03df5b7589097686) - The MikroORM adapter: `import { mikroOrmAdapter } from '@sqlane/core/adapter-mikro-orm'`, then
  `mikroOrmAdapter(orm.em, { dialect })`. `enqueue` takes an EntityManager: of a transaction (also the global one inside
  `em.transactional()`), or outside one (a transaction of its own). The workers wake at once after the commit of the
  outermost transaction. MikroORM 6 and 7, with `@mikro-orm/mysql` or `@mikro-orm/postgresql`.

- [#41](https://github.com/sqlane/sqlane-node/pull/41) [`d3ab433`](https://github.com/sqlane/sqlane-node/commit/d3ab433e99ae73560dbaebd340fe6b95f7074b83) - The Prisma adapter: `import { prismaAdapter } from '@sqlane/core/adapter-prisma'`, then
  `prismaAdapter(prisma, { dialect })`. `enqueue` takes a Prisma client (a transaction of its own) or the client of an
  interactive transaction. `sqlane.migrate()` works through Prisma too. Prisma 7, with MySQL or PostgreSQL.

    On MySQL, the failure job of a failed job is inserted without a savepoint: some drivers (Prisma) cannot run
    `SAVEPOINT`. A partial insert is undone; the job still fails without it, as before.

- [#42](https://github.com/sqlane/sqlane-node/pull/42) [`1fef51e`](https://github.com/sqlane/sqlane-node/commit/1fef51e911723fa8e2b8d91cfc5249146bc2729f) - The Sequelize adapter: `import { sequelizeAdapter } from '@sqlane/core/adapter-sequelize'`, then
  `sequelizeAdapter(sequelize)`. `enqueue` takes a Sequelize instance (a transaction of its own) or a Sequelize
  transaction, also nested: the workers wake at once after the commit of the outermost one. Sequelize 6, with MySQL or
  PostgreSQL.

- [#44](https://github.com/sqlane/sqlane-node/pull/44) [`4a08c26`](https://github.com/sqlane/sqlane-node/commit/4a08c26be1eaaac240d2a20129eeef4d7fb7f308) - Sequelize with CLS: `enqueue(sequelize, …)` inside a CLS transaction joins it, as the queries of Sequelize do. Before,
  it ran in a transaction of its own: the job committed even when the app's transaction rolled back.

- [#46](https://github.com/sqlane/sqlane-node/pull/46) [`5b5d2df`](https://github.com/sqlane/sqlane-node/commit/5b5d2df96b0b7d992d0e75b0ede5bcc31cef07d6) - The TypeORM adapter: `import { typeOrmAdapter } from '@sqlane/core/adapter-typeorm'`, then
  `typeOrmAdapter(dataSource)`. `enqueue` takes a DataSource (a transaction of its own), or the EntityManager or
  QueryRunner of a transaction, also with savepoints: the workers wake at once after the commit of the outermost one.
  TypeORM 0.3 and 1.x, with MySQL (mysql2) or PostgreSQL.

### Patch Changes

- [#43](https://github.com/sqlane/sqlane-node/pull/43) [`b5d8d84`](https://github.com/sqlane/sqlane-node/commit/b5d8d840ecd5504946e0153639798d77328259a5) - Retry the deadlocks and write conflicts that Prisma reports (`P2034`, or `P2010` with the database code in its driver
  adapter error), as those of the drivers: `drain()` failed on one with the Prisma adapter.

## 0.4.0

### Minor Changes

- [#36](https://github.com/sqlane/sqlane-node/pull/36) [`3581140`](https://github.com/sqlane/sqlane-node/commit/3581140e69703d81ca8039c8afd53fd15e990d98) - The adapters are imported from `@sqlane/core/adapter-<name>`: `adapter-mysql2`, `adapter-pg`, `adapter-knex`,
  `adapter-kysely`. The paths before (`@sqlane/core/mysql2`, `/pg`, `/knex`) still work, until 1.0.

- [#36](https://github.com/sqlane/sqlane-node/pull/36) [`3581140`](https://github.com/sqlane/sqlane-node/commit/3581140e69703d81ca8039c8afd53fd15e990d98) - The Kysely adapter: `import { kyselyAdapter } from '@sqlane/core/adapter-kysely'`, then `kyselyAdapter(db, { dialect })`.
  `enqueue` takes a Kysely instance (a transaction of its own) or a Kysely transaction, also a controlled one. The SQL of
  sqlane runs without the plugins of the instance (a `CamelCasePlugin` does not rename its columns). Kysely 0.28 and
  0.29, with its MySQL or PostgreSQL dialect.

## 0.3.0

### Minor Changes

- [#34](https://github.com/sqlane/sqlane-node/pull/34) [`733cda4`](https://github.com/sqlane/sqlane-node/commit/733cda476c2f44e875a6b0501d32d8abbdd100aa) - The knex adapter is now part of the core: `import { knexAdapter } from '@sqlane/core/knex'`. It replaces
  `@sqlane/adapter-knex` (deprecated): same API, and no other package to install. No ORM is a peer dependency of the
  core: the adapter checks the knex instance that it gets.

## 0.2.0

### Minor Changes

- [#32](https://github.com/sqlane/sqlane-node/pull/32) [`746ecac`](https://github.com/sqlane/sqlane-node/commit/746ecaceb73fef34f2f80aef4072d0469524e3bc) - An adapter can tell when the transaction of an enqueue commits (`afterCommit`): the processes wake at once after the
  commit, and still re-probe after it. With `mysql2Adapter` and `pgAdapter`, an enqueue on a pool wakes at once. The
  hint of an enqueue in a transaction of an ORM adapter is sent after the commit.

## 0.1.3

### Patch Changes

- [#30](https://github.com/sqlane/sqlane-node/pull/30) [`47db15c`](https://github.com/sqlane/sqlane-node/commit/47db15cbee74d696e9b6674e6fb1b67918fa8c3b) - The repository is now a monorepo: the package is in `packages/core`. No change of the code.

## 0.1.2

### Patch Changes

- [#29](https://github.com/sqlane/sqlane-node/pull/29) [`c465aa1`](https://github.com/sqlane/sqlane-node/commit/c465aa1bede1edf6703e66ad90a69c85039f895a) - Complete the finished jobs of a process in batches: one transaction for the jobs that finish during the previous
  write. 2–3× the jobs per second for short jobs.

- [#29](https://github.com/sqlane/sqlane-node/pull/29) [`c465aa1`](https://github.com/sqlane/sqlane-node/commit/c465aa1bede1edf6703e66ad90a69c85039f895a) - `close()` no longer keeps the process alive until its deadline: its timers end with it.

- [#27](https://github.com/sqlane/sqlane-node/pull/27) [`8408a0c`](https://github.com/sqlane/sqlane-node/commit/8408a0cd8c949fa8e808ad48b9def7852269142e) - Start a job within milliseconds of its commit under steady traffic too. An enqueue made while the re-probes of an
  earlier one were running waited for their late steps (up to 1 s); now each enqueue restarts the re-probes. A
  PostgreSQL NOTIFY now wakes the workers at once, with no re-probe.

## 0.1.1

### Patch Changes

- [#24](https://github.com/sqlane/sqlane-node/pull/24) [`cc72758`](https://github.com/sqlane/sqlane-node/commit/cc7275887261b61ff817d70ecda94f56c2748704) - TypeScript declarations: the package ships `types/*.d.ts`, generated from its JSDoc, with a `types` condition for `.`,
  `./mysql2` and `./pg`. A strict TypeScript project no longer needs `allowJs`. The `pg` adapter types come from
  `@types/pg`.

## 0.1.0

The first usable version: jobs are enqueued in the caller's transaction and run by the workers, on MySQL 8.4+ and
PostgreSQL 15+. It includes the versions 0.0.3 and 0.0.4, which were not published.

### Minor Changes

- [#19](https://github.com/sqlane/sqlane-node/pull/19) [`5a71cf7`](https://github.com/sqlane/sqlane-node/commit/5a71cf7bd81bb0db0ed171a4f2e83f60f3962a8b) - `getStats()` gives the pending, due, running, stuck and failed counts and the oldest due age of each job name. Hints wake
  the other processes: a `hint: { publish, subscribe }` over any pub/sub, or `pgAdapter(pool, { notify: true })` for
  PostgreSQL LISTEN/NOTIFY (delivered on commit). The README shows the usage.

### Patch Changes

- [#22](https://github.com/sqlane/sqlane-node/pull/22) - `drain()` retries a round after a deadlock or a lock wait timeout instead of rejecting, and
  `drain({ includeDelayed })` updates the due times in a `READ COMMITTED` transaction (no gap locks on MySQL).

- [#15](https://github.com/sqlane/sqlane-node/pull/15) [`37221b6`](https://github.com/sqlane/sqlane-node/commit/37221b61d2bb6d6e47a515fe75d1f17aac8111be) - Internal: the worker side of the store (probe, candidates, claim with mutex keys). The lock and enqueue tokens are
  `varchar(26)` in the schema.

- [#17](https://github.com/sqlane/sqlane-node/pull/17) [`2946241`](https://github.com/sqlane/sqlane-node/commit/2946241dbac858276663a4c9c309f79d799e2e38) - Internal: the final writes of the store (lease renewal, complete, retry, fail with the failure job, release, stall
  recovery, mutex sweeps, cleanup).

- [#18](https://github.com/sqlane/sqlane-node/pull/18) [`f290097`](https://github.com/sqlane/sqlane-node/commit/f29009721aa7da35bae23220ad0094a404ba5e7e) - Jobs run: `handle()`, `start()`, `drain()`, `close()` and `wake()` work. Handlers get `{ payload, job, signal }`; jobs
  retry by their backoff, fail into their failure job, respect the lanes, the process `concurrency` and the mutex keys,
  and time out with an aborted `signal`. `close()` releases or abandons the unfinished jobs; `drain()` runs the due jobs
  for tests.

- [#9](https://github.com/sqlane/sqlane-node/pull/9) [`555bb6c`](https://github.com/sqlane/sqlane-node/commit/555bb6ce6e2c7cd48c11f589fdb9385d7b84bffa) - `defineJob()` checks its options and throws a `ConfigError` for a bad name, an unknown option, or a bad
  `maxAttempts`, `maxStalls`, `backoff`, `retention`, `timeout`, `mutexKeys` or `failureJob`.

- [#12](https://github.com/sqlane/sqlane-node/pull/12) [`27473e5`](https://github.com/sqlane/sqlane-node/commit/27473e5439a926e5f544d451cb77373c47dc56d1) - `enqueue()` and `enqueueMany()` add jobs with the caller's connection, in its transaction (or a transaction of their own
  with a pool). A `jobId` adds one job while its row exists: a duplicate resolves to `{ created: false }` and changes
  nothing. `createSqlane` checks its options: unknown options, `jobs`, `unknownJobs`, `maxPayloadBytes`, `defaults`.

- [#11](https://github.com/sqlane/sqlane-node/pull/11) [`6dc3637`](https://github.com/sqlane/sqlane-node/commit/6dc3637de28a0ca725d5c0700ab67f7997a0e05c) - Add the schema for MySQL and PostgreSQL: `sqlane.migrate({ lockTimeout })` applies the missing migrations under a DB
  lock and resolves to `{ applied }`; `getMigrations({ dialect, tablePrefix })` gives the SQL for your own migration tool.
  `createSqlane` checks `tablePrefix`. New error: `MigrationLockTimeoutError`.

## 0.0.2

### Patch Changes

- [#7](https://github.com/sqlane/sqlane-node/pull/7) [`46010b7`](https://github.com/sqlane/sqlane-node/commit/46010b7d6471d2fba61774185d6de6562c0a0327) - Add the public API as typed stubs: `createSqlane`, `defineJob`, `getMigrations`, the error classes, and the
  `@sqlane/core/mysql2` and `@sqlane/core/pg` adapters. The methods throw "not implemented" until the implementation lands.

## 0.0.1

### Patch Changes

- [#2](https://github.com/sqlane/sqlane-node/pull/2) [`bd16a88`](https://github.com/sqlane/sqlane-node/commit/bd16a889b6f8c5abe0e8e928adadd32f88af1cca) - First release, published by the release workflow: it checks the release pipeline (changesets, trusted publishing with
  provenance, GitHub release). The package has no API yet; [the design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md)
  describes the planned v0.1.
