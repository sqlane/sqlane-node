# @sqlane/core

## 7.0.0

### Major Changes

- [#125](https://github.com/sqlane/sqlane-node/pull/125) [`bc10ffa`](https://github.com/sqlane/sqlane-node/commit/bc10ffa567fac824e58515f5a8b2db2f82ef15f0) - Every adapter requires `dialect`: `'mysql'`, `'mariadb'` or `'postgres'`. There is no default any more, so a MariaDB
  server can no longer run the SQL of MySQL by mistake. Where the library tells its database (Knex, Drizzle, Sequelize,
  TypeORM, MikroORM), a mismatch throws a `ConfigError`. The first `start()` or `migrate()` of an instance checks the
  server: another database, or a version below MySQL 8.4, MariaDB 10.11 or PostgreSQL 15, rejects with a `ConfigError`.
  On MySQL and MariaDB, it also reads the `sql_mode` of the session. A mode without strict mode or another flag of the
  database's default mode, or with `ALLOW_INVALID_DATES` or `NO_BACKSLASH_ESCAPES`, rejects with a `ConfigError`. The
  default mode of each database passes; the default parameter group of Amazon RDS MySQL does not.

    To migrate, add `dialect` to your adapter call, for example `pgAdapter(pool, { dialect: 'postgres' })`,
    `mysql2Adapter(pool, { dialect: 'mysql' })` or `typeOrmAdapter(dataSource, { dialect: 'mariadb' })`. The options
    argument is now required on every adapter. To run on an older server, pass `allowUnsupportedDbVersion: true` to the
    adapter: sqlane then logs a warning through the `logger` of `createSqlane` instead of throwing. On MySQL and MariaDB,
    make `sql_mode` strict (on RDS and Aurora, in the DB parameter group), or pass `allowUnsupportedDbConfiguration: true`
    for a warning instead. `NO_BACKSLASH_ESCAPES` has no option: remove it.

## 6.1.0

### Minor Changes

- [#123](https://github.com/sqlane/sqlane-node/pull/123) [`dc8be37`](https://github.com/sqlane/sqlane-node/commit/dc8be376f5afb244735fb8c75ec45441a1e8a701) - PostgreSQL: the Knex, Sequelize and MikroORM adapters take `{ prepare: true }`, to run sqlane's SQL as named prepared
  statements, as the pg adapter does by default: each connection parses and plans a statement once. It is off by default,
  for poolers in transaction mode without prepared statement support. In MikroORM 7 (7.2 and later), it covers the
  queue's own SQL; an enqueue still runs through Kysely, unnamed. On MySQL and MariaDB, `prepare` throws a `ConfigError`.

### Patch Changes

- [#121](https://github.com/sqlane/sqlane-node/pull/121) [`a078aa2`](https://github.com/sqlane/sqlane-node/commit/a078aa200232e2788a386c319ad63e62f4ee1f9a) - MySQL and MariaDB: a worker that handles more than 100 job names no longer runs a job twice. A turn that probed more
  than 100 names could request a name twice, and the claim then locked and started its due jobs twice, in the same
  process. The worker now requests each name once, the store ignores a repeated name, and a job given twice by one claim
  runs once, with an `error` event.

- [#124](https://github.com/sqlane/sqlane-node/pull/124) [`e214916`](https://github.com/sqlane/sqlane-node/commit/e21491689fb6dacfc13e6cb8594bc72548db180f) - The stall recovery, about every 30 s, starts with one read of its work: the stale jobs, and whether there are ended
  lingers, orphan slots, blocked jobs or expired rate rows. Only the parts with work run, so an idle recovery is one
  statement instead of 9 (PostgreSQL) or 11 (MySQL, MariaDB), with their two transactions.

- [#123](https://github.com/sqlane/sqlane-node/pull/123) [`dc8be37`](https://github.com/sqlane/sqlane-node/commit/dc8be376f5afb244735fb8c75ec45441a1e8a701) - PostgreSQL: `migrate({ lockTimeout })` sets the timeout of its lock with one SQL text and a parameter
  (`set_config('lock_timeout', $1, true)`), no longer with the value in the SQL. Each distinct timeout made a new named
  prepared statement on the connection.

- [#121](https://github.com/sqlane/sqlane-node/pull/121) [`a078aa2`](https://github.com/sqlane/sqlane-node/commit/a078aa200232e2788a386c319ad63e62f4ee1f9a) - The stall recovery no longer reports deadlocks of its sweep of the concurrency slots as `error` events under load. On
  MySQL the sweep skips the slots that claims and releases hold instead of waiting for them, and on all databases a
  deadlock of the sweep runs it again at once, up to 3 times, as the dispatcher does for its claims.

## 6.0.0

### Major Changes

- [#112](https://github.com/sqlane/sqlane-node/pull/112) [`eeefafc`](https://github.com/sqlane/sqlane-node/commit/eeefafc5911240ac418720fadf5254459cc835d5) - Concurrency limits replace mutex keys and concurrency groups. `defineConcurrencyLimit({ name, max })` declares a limit
  once; a job definition lists it in `localConcurrencyLimits` (per process, in memory) or returns it, or its keys, from
  `globalConcurrencyLimits({ payload })` (per key, in the whole cluster). A key of a global limit runs at most `max` jobs
  at once; a job whose key is full is blocked out of the due jobs until a job of the key ends, so a flood on one key no
  longer holds back the others. All the options of a job name move to its definition: `handle()` takes none, and
  `createSqlane`'s `maxConcurrency` is now `localMaxConcurrency`. The migrations `0005_concurrency_limits` and
  `0006_concurrency_slots` convert the mutex keys of existing jobs to limits with max 1. See
  [Migrating from 5.x to 6.0](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/6.md).

### Minor Changes

- [#116](https://github.com/sqlane/sqlane-node/pull/116) [`2c08deb`](https://github.com/sqlane/sqlane-node/commit/2c08debbd087036390ca7e0186ef2b264082f378) - Rate limits. `defineRateLimit({ name, max, per, burst })` declares a limit of job starts: `max` per `per`, spread
  evenly, with bursts of up to `burst`. A job definition lists it in `localRateLimits` (per process, in memory) or returns
  it, its keys or a cost of it from `globalRateLimits({ payload })` (per key, in the whole cluster, with GCRA in one row
  per key). A job over the quota of a key is blocked out of the due jobs, without using an attempt, until the key allows
  its start, so a flood on one key does not hold back the others. A handler that gets a 429 throws
  `new RateLimitedError({ limit, retryAfter })`: the key starts no job before `retryAfter`, and the job waits without
  using an attempt; each wait emits a `rate_limited` event. The migration `0007_rate_limits` adds the table
  `sqlane_rate_limits` and a column of `sqlane_jobs`.

### Patch Changes

- [#117](https://github.com/sqlane/sqlane-node/pull/117) [`0be7c02`](https://github.com/sqlane/sqlane-node/commit/0be7c02f5359bb281114935529faef84186644e8) - PostgreSQL keeps one plan per connection for the statements of the claim, the unblock and the rate keys: their array
  parameters no longer make it plan each call again. With `pg` and `postgres.js` (whose adapter now sends named prepared
  statements, unless the pool was created with `prepare: false`), a job with global limits costs the database about 40%
  fewer instructions. An idle worker of many job names polls with fewer instructions.

- [#118](https://github.com/sqlane/sqlane-node/pull/118) [`33ad612`](https://github.com/sqlane/sqlane-node/commit/33ad61289e4a22a02f5a519dcaa5b822fb325b7b) - The unblock of a rate key reads as many blocked jobs as its quota lets start, not up to 501: with a large backlog on a
  key, it takes about 1 ms instead of tens of milliseconds.

- [#119](https://github.com/sqlane/sqlane-node/pull/119) [`dff589a`](https://github.com/sqlane/sqlane-node/commit/dff589ab7c1f308df018399ddadb4c7197255b15) - Internal: the runner is split into modules (the dispatcher, the job runs, the unblocks of keys, the leases, the
  maintenance and the local limits). No change of behaviour or API.

## 5.0.2

### Patch Changes

- [#110](https://github.com/sqlane/sqlane-node/pull/110) [`aa71aab`](https://github.com/sqlane/sqlane-node/commit/aa71aab6717883c485e69483fa985649d2174031) - README: performance charts from the redesigned benchmarks, with 1 ms of network round trip and SQL statements per job.

- [#108](https://github.com/sqlane/sqlane-node/pull/108) [`f9bbafe`](https://github.com/sqlane/sqlane-node/commit/f9bbafe772bb63d1f1785d9515e3c98fe4b3372f) - Fix the drain chart of the README: its description no longer ends the image tag early.

## 5.0.1

### Patch Changes

- [#106](https://github.com/sqlane/sqlane-node/pull/106) [`6267e5e`](https://github.com/sqlane/sqlane-node/commit/6267e5e7c16b9364410c131727002e014a8df370) - Rewrite the README as a short landing page, with tables of supported databases and of drivers and ORMs, and charts
  from the Linux benchmark run.

## 5.0.0

### Major Changes

- [#101](https://github.com/sqlane/sqlane-node/pull/101) [`efcaa89`](https://github.com/sqlane/sqlane-node/commit/efcaa890ce240a0e6623e40c23788d298b00179e) - Fair sharing of slots across job names, and concurrency groups. See the
  [migration guide](https://github.com/sqlane/sqlane-node/blob/main/docs/migrating-to-5.md).

    Breaking:

    - `createSqlane({ concurrency })` and `handle()`'s `concurrency` are now `maxConcurrency`.
    - `lanes` and `lane` are removed: define a group with `defineConcurrencyGroup({ name, maxConcurrency })`, and pass it
      to `handle()` as `concurrencyGroup`.
    - A free slot goes to the due job name with the lowest `running / fairShareWeight` (new `handle()` option, 1–1000,
      default 1), no longer to the oldest due job across names. FIFO within a name and per mutex key is kept.
    - A handler or group `maxConcurrency` above the instance's throws a `ConfigError` at `start()` and `drain()`. 4.x
      capped it silently.
    - Types: `Sqlane`, `SqlaneOptions` and `HandleOptions` lose their lane parameter, and `LaneOptions` is removed.
    - The errors of `drain()` begin with `drain():`.

### Patch Changes

- [#103](https://github.com/sqlane/sqlane-node/pull/103) [`b2701c0`](https://github.com/sqlane/sqlane-node/commit/b2701c0c41eb56441aa7e2346235a61b1096eee7) - Claims on MariaDB 11.8 (and any MariaDB with `innodb_snapshot_isolation=ON`) no longer fail with `ER_CHECKREAD`
  (errno 1020) while jobs are enqueued concurrently: the claim statement turns snapshot isolation off for itself, and
  reads again the payloads that it did not see, as on MariaDB 10.11 and MySQL. A deadlock, serialization failure or
  `ER_CHECKREAD` (1020) of a claim is now retried at once, up to 3 times, without an `error` event; only an error that
  persists is reported and backed off. A lock wait timeout is still reported and backed off at once.

## 4.0.3

### Patch Changes

- [#99](https://github.com/sqlane/sqlane-node/pull/99) [`8a22cf0`](https://github.com/sqlane/sqlane-node/commit/8a22cf02809c58d105795a31ced5ce95e7bde270) - On MySQL and MariaDB, a job enqueued while a worker was claiming could be claimed without its payload: the worker
  released it for 1 s and claimed it again (an extra `claimed` event), or, with the worker's clock more than 60 s ahead of
  the database's, failed it with `MissingPayloadError`. The claim now reads such payloads again in the same transaction.
  On MariaDB 11.8 and later (`innodb_snapshot_isolation`), the same race could fail the claim with "Record has changed
  since last read" (errno 1020); that error is now transient: `drain()` retries its round instead of rejecting.

## 4.0.2

### Patch Changes

- [#95](https://github.com/sqlane/sqlane-node/pull/95) [`8d50376`](https://github.com/sqlane/sqlane-node/commit/8d50376f99424c34731c20daad9af54956b7d9d9) - README: the performance chart and the comparison table include Boring Node Queue and Izi Queue, and the chart BullMQ
  and Sidequest too. The other queues that enqueue in your transaction use about 1.7–6.2× as many CPU instructions per job
  as sqlane on PostgreSQL. Two exceptions: BullMQ on Redis uses 1.3×, but enqueues outside your transaction; on MySQL,
  Izi Queue uses about a third fewer than sqlane. pg-boss's 1000 idle queues take about 4% of a core, not a quarter.

## 4.0.1

### Patch Changes

- [#93](https://github.com/sqlane/sqlane-node/pull/93) [`9fb7a41`](https://github.com/sqlane/sqlane-node/commit/9fb7a41f86ca0685d005d2b44387b0d2b02445f7) - README: the performance chart and its bullet compare sqlane with River and pg-boss at the throughput settings of their
  documentation; Graphile Worker, River and pg-boss use 2.3–5.8× as many CPU instructions per job.

## 4.0.0

### Major Changes

- [#91](https://github.com/sqlane/sqlane-node/pull/91) [`848154d`](https://github.com/sqlane/sqlane-node/commit/848154d81681ee731b5f39e40af7586fd5e8f816) - Cron and repeatable jobs, with three small breaking changes.

    Breaking:

    - `enqueue` and `enqueueMany` reject a `jobId` that starts with `schedule:`. This prefix now marks the slots of
      schedules. To run a slot by hand, use the new option `slot: { at, key? }`.
    - `JobInfo.scheduledAt: Date | null` is a new required field. A `HandlerContext` that you build by hand in tests
      needs `scheduledAt: null`.
    - `SqlaneEvent` has a new type, `schedule_fired`. An exhaustive `switch` on `event.type` needs a case for it. From now
      on, new event types may come in minor versions: handle unknown types in a `default` branch.

    New:

    - `sqlane.schedule(job, { cron, timezone })` or `{ every }` adds a job at each slot. Each slot adds at most one job
      in the cluster, without a leader, and the database clock decides. A slot missed during a short downtime runs once
      (`missed: 'once' | 'skip'`), and `overlap: 'skip'` skips a slot while the previous run is not done. `jitter`
      spreads the runs of many schedules over a window.
    - Handlers get `job.scheduledAt`, `getSchedules()` gives the next and the last slot, and the event `schedule_fired`
      reports each slot.

    Migration: if you use schedules, run `migrate()` after the upgrade. It adds the table `sqlane_schedules` (migration
    `0004_schedules`). Apps without schedules need nothing: they run no new query.

### Patch Changes

- [#91](https://github.com/sqlane/sqlane-node/pull/91) [`006e717`](https://github.com/sqlane/sqlane-node/commit/006e7171ad90a457c003e9b9d30aec8d8e7f7011) - Deadlocks and serialization failures wrapped by Sequelize (`original`, `parent`), TypeORM (`driverError`) and Prisma
  raw queries (`meta.code`) are now recognized as transient: `drain()` retries its round, and the failure-job insert on
  MySQL and MariaDB takes its retry path, as with the plain driver errors.

## 3.0.1

### Patch Changes

- [#89](https://github.com/sqlane/sqlane-node/pull/89) [`4f6cf53`](https://github.com/sqlane/sqlane-node/commit/4f6cf535ed098afef833268a11bedad808305b39) - README and package description: lead with MySQL and MariaDB.

## 3.0.0

### Major Changes

- [#83](https://github.com/sqlane/sqlane-node/pull/83) [`3d918e5`](https://github.com/sqlane/sqlane-node/commit/3d918e5f2325973b474557d328cc6ec4f2ec0e25) - Lower the CPU cost of each job: about 70% less on PostgreSQL, 35–40% less on MySQL and MariaDB.

    - A wake checks only the job names it concerns: a NOTIFY, a commit or a completion no longer probes every job name.
      The poll interval still checks all names.
    - On PostgreSQL, a wake for job names without mutex keys claims their jobs at once: the claim also reports when the
      next job of each name is due, so no separate probe runs.
    - The pg adapter uses named prepared statements (new option `prepare`, default `true`; set `false` behind PgBouncer
      before 1.21 in transaction mode). A claim of one name and a completion of one job use scalar parameters, so
      PostgreSQL reuses a cached plan.
    - An enqueue on PostgreSQL is one statement that also sends its NOTIFY; on a pool it runs without `BEGIN`/`COMMIT`.
    - New PostgreSQL migration `0002_pending_order`: the pending-jobs index becomes `(job_name, run_at, id)`, so claims read
      jobs in order without a sort. Run `migrate()` after the upgrade.
    - MySQL and MariaDB: the checks that follow a hint probe only the names enqueued within their steps, and claim only
      names with due jobs. Under a steady load they no longer probe every job name.
    - Mutex keys: a release wakes the jobs that wait for its keys (a NOTIFY or hint `#<key>`), not every job name. The
      FIFO of a key reads a new table, `sqlane_job_keys`: a row per key of each pending job, in the order of `run_at`
      (migrations `0003_job_keys` on PostgreSQL, `0002_job_keys` on MySQL and MariaDB). It no longer reads the due jobs of
      every name with mutex keys. Per job with mutex keys: about 25% fewer instructions on PostgreSQL, 85–90% fewer on
      MySQL and MariaDB; with a long queue on one key, 80–97% fewer. MariaDB no longer stalls with thousands of due jobs
      that wait for a held key. Processes of an older version ignore `#<key>` hints: during a rolling upgrade, their jobs
      with mutex keys can wait for the poll.

### Patch Changes

- [#87](https://github.com/sqlane/sqlane-node/pull/87) [`3ece593`](https://github.com/sqlane/sqlane-node/commit/3ece593ada68402695bc44025b93c3b150fc774f) - README: a "How it compares" section with a table of the checked capabilities, a chart of the CPU cost per job next to
  pg-boss, Graphile Worker and River, and the headline numbers of the performance comparison. The performance section
  is shorter, with ranges across the databases.

- [#85](https://github.com/sqlane/sqlane-node/pull/85) [`6a6bdad`](https://github.com/sqlane/sqlane-node/commit/6a6bdad13970e805b8d1aaad03be0bc65cd5a58c) - Drain a backlog over many job names much faster: 10,000 due jobs over 1000 names, 8 slots and empty handlers, from
  18.6 s to 1.4 s on PostgreSQL, 258 s to about 5 s on MySQL and 175 s to 16 s on MariaDB, with 90 to 98% less CPU per
  job.

    - A claim requested every due job name and locked up to the free slots of each: with 1000 due names, thousands of rows
      to start a few jobs. It now requests at most 4 names per free slot, the next names at the next turn, and a full claim
      no longer reads the next due time of each name.
    - The first completion write waits for one turn of the event loop: the jobs whose handlers finish in it, such as those
      whose I/O completes in the same poll, are completed in one write, and their slots free together for one claim. In a
      drain on MariaDB with handlers that hash and read a file: a third fewer commits per job and about 20% less time,
      which matters where a commit waits for the disk.

- [#86](https://github.com/sqlane/sqlane-node/pull/86) [`d5791f2`](https://github.com/sqlane/sqlane-node/commit/d5791f24706e52fdee5081303682f8271f3fd7f1) - README: link the rebuilt comparison with other job queues. Its features are now checked by running each library
  (`pnpm bench:compare`), and a new page compares the CPU cost, latency and idle cost of the queues that enqueue in
  your transaction.

- [#88](https://github.com/sqlane/sqlane-node/pull/88) [`ea879fc`](https://github.com/sqlane/sqlane-node/commit/ea879fc16c79b56c5d53761d326bc200c429506a) - README: the performance comparison also measures pg-boss and River with the throughput settings of their
  documentation. sqlane uses 2.4–6× fewer CPU instructions per job than the others, with their defaults or tuned.

## 2.0.1

### Patch Changes

- [#81](https://github.com/sqlane/sqlane-node/pull/81) [`3a5bb78`](https://github.com/sqlane/sqlane-node/commit/3a5bb78f078e2fdb64233d584390757d2ec31881) - Clarify when to choose sqlane, compare queue features and licenses, document measured idle-queue overhead, and add scheduling to the roadmap.

## 2.0.0

### Major Changes

- [#80](https://github.com/sqlane/sqlane-node/pull/80) [`39e4011`](https://github.com/sqlane/sqlane-node/commit/39e4011fdd437343474b6044600ee4ce8d1c726c) - Remove all runtime npm dependencies by internalizing monotonic ULID generation and duration parsing.

    Duration strings now require explicit lowercase short units in descending order (`w`, `d`, `h`, `m`, `s`, `ms`), each at most once. Spaces may separate components: `1h 1m 1s` and `1d1h1ms` are valid. Full names (`2 days`), reversed or repeated units (`1ms 1d`, `1s 2s`), inferred units, clock notation, signs, exponents and extraneous text are rejected. Replace full names with short units and reorder components before upgrading. Numeric safe integer milliseconds and fractional string quantities remain supported.

    Generated job IDs and internal tokens retain the 26-character ULID format; no database migration is required.

### Minor Changes

- [#77](https://github.com/sqlane/sqlane-node/pull/77) [`0dab45a`](https://github.com/sqlane/sqlane-node/commit/0dab45ac362192d3715de81db11153805b1c4889) - Support MariaDB 10.11 and later. Over mysql2, tell the adapter: `mysql2Adapter(pool, { dialect: 'mariadb' })`, the same `dialect` option on the Knex, Drizzle and Sequelize adapters, `dialect: 'mariadb'` on the Kysely, Prisma and MikroORM adapters, and `type: 'mariadb'` in a TypeORM DataSource. The mariadb driver works too: the `mariadb` client of Knex, the `mariadb` dialect of Sequelize and `@mikro-orm/mariadb` (MikroORM 6 and 7). `getMigrations({ dialect: 'mariadb' })` gives its schema. MySQL is unchanged.

### Patch Changes

- [#79](https://github.com/sqlane/sqlane-node/pull/79) [`894fac9`](https://github.com/sqlane/sqlane-node/commit/894fac9a1c53dcea5774b51d350d66bf6755b96f) - README: the performance numbers of a new benchmark run, with MariaDB.

## 1.0.0

### Major Changes

- [#75](https://github.com/sqlane/sqlane-node/pull/75) [`72e2c61`](https://github.com/sqlane/sqlane-node/commit/72e2c616b0160e01589e307f657743b758f0fd00) - sqlane 1.0: the API and the database schema are stable, and sqlane now follows semantic versioning. Only a major version breaks the API or the schema. Nothing changed in the code since 0.9.0, so no migration or code change is needed.

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
