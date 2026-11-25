# sqlane design

> Status: implemented, as published on npm. The API and the schema follow semantic versioning since 1.0. sqlane has no
> known production use yet. The [changelog](../CHANGELOG.md) lists what each version added.

sqlane runs background jobs that are rows in the application's own SQL database (MySQL, MariaDB or PostgreSQL). The
application adds a job in its business transaction, so the job exists only if the transaction commits. In this document,
MySQL also stands for MariaDB, except in [MariaDB](#mariadb), which lists the differences.

## Goals

1. **Transactional enqueue.** sqlane inserts a job with the connection of the caller's transaction. The job exists only
   if that transaction commits, and it never starts before its data is visible.
2. **Cheap idle lanes.** 1000 lanes, most of them idle, cost about the same as 10. The database load of a
   process does not grow with the number of handled lanes. It grows only with the lanes that have pending jobs.
3. **Low latency.** In the same process, a job starts right after the commit when the adapter sees the commit, and
   about 25 ms after it otherwise. In another process, a job starts within a few milliseconds with PostgreSQL NOTIFY,
   and about 25 ms after the commit with a hint. Without either, it starts within the poll interval, which is 5 s by
   default. See [Wake-up after the commit](#wake-up-after-the-commit).
4. **At-least-once execution.** A committed job runs at least once, also after a crash, a stall or a deploy.
5. **MySQL, MariaDB and PostgreSQL.** All three databases get the same features and the same API. Only the NOTIFY
   wake-up is PostgreSQL's: on MySQL and MariaDB, other processes wake by a hint or at their poll.
6. **Concurrency limits.** At most `max` jobs of a key of a global limit run at the same time in the cluster, and a
   flood on one key does not hold back the others. [Guarantees](#guarantees) gives the exact condition.
7. **Rate limits.** A key of a global rate limit starts at most `max` jobs per `per` in the cluster, spread evenly, and
   a job over the limit waits without using an attempt.
8. **Failure jobs.** When a job fails for good, sqlane adds a job of another lane, in the same transaction that marks the job as failed.
9. **Fair groups.** One group of a lane (a tenant) with a big backlog does not starve the other groups of the lane:
   a runner gives the lane's slots to its due groups in turn.
10. **Library hygiene.** sqlane has no global state, does not read `process.env`, writes nothing to the console and never
    exits the process. The app injects the connections, the logger and the metrics.

## Non-goals

- Exactly-once execution. Handlers must be idempotent.
- A dashboard. `lanes.stats()` gives the counts per lane, and the tables are plain SQL (see [Data](#data)).
- Priorities, or a strict order across processes.
- Workflows, batches, job dependencies.
- SQLite, other databases.
- An ORM. Adapters wrap the transaction objects of the drivers and ORMs.

## Terms

| Term                  | Meaning                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job**               | One row: a payload, a state, attempts, a lease.                                                                                                                                                                                                   |
| **Lane**              | The jobs that share a name, e.g. `build_report`, with the default options of its definition. It is also the "queue": there is no separate queue. Lanes share the table and the workers, with fair sharing between them; a lane is not a priority. |
| **Lane definition**   | The name and the options of a lane. Producers and workers import it.                                                                                                                                                                              |
| **Handler**           | How a process runs the jobs of a lane: its function and its local settings (`defineHandler`). Only runners mount handlers.                                                                                                                        |
| **Runner**            | The part of a process that runs jobs and fires schedules (`createRunner`). Producers have none.                                                                                                                                                   |
| **Concurrency limit** | The most jobs that run at once: local (per process, in memory) or global (per key, in the cluster).                                                                                                                                               |
| **Rate limit**        | The most job starts per period: local (per process, in memory) or global (per key, in the cluster).                                                                                                                                               |
| **Fair share weight** | A lane's share of the free slots against the other due lanes.                                                                                                                                                                                     |
| **Fair group**        | A string of a job, from its lane's `fairGroup` at enqueue. A runner whose definition of the lane has `fairGroup` gives the lane's slots to its due groups in turn.                                                                                |
| **Key**               | A string (`order:42`): a global limit counts the running jobs of each key.                                                                                                                                                                        |
| **Rate key**          | A key of a global rate limit, `@<name>` or `@<name>:<value>`: it counts the starts of its jobs.                                                                                                                                                   |
| **Slot of a key**     | One of the `max` places of a key. A running job holds one slot of each of its keys.                                                                                                                                                               |
| **Blocked job**       | A due job with a full key, or a rate key without quota: out of the due jobs until the key has room or quota.                                                                                                                                      |
| **Failure job**       | A job that sqlane adds, to the failure lane, when another job fails for good.                                                                                                                                                                     |
| **Adapter**           | Wraps a driver: the dialect, the queue's pool, and the raw connections given to `enqueue`.                                                                                                                                                        |
| **Hint**              | A message "jobs of this lane are ready" between processes. Only an optimization.                                                                                                                                                                  |
| **Schedule**          | A cron in a time zone, or a fixed interval, that adds a job at each of its times (`defineSchedule`, id `<lane>:<key>`).                                                                                                                           |
| **Slot**              | One time of a schedule. It adds at most one job.                                                                                                                                                                                                  |

## API

The [API reference](api.md) describes every function, option, default, error and event. This section keeps only the
reasons behind the shape of the API.

- **Definition apart from the handler.** Producers import a small lane definition, not the handler and its
  dependencies. A lane says what a job is (`defineLane`); a handler says how a process runs it (`defineHandler`); a
  schedule says when one is added (`defineSchedule`), next to its lane. They are frozen values, with no instance.
- **Two scopes.** `sqlane` (`createSqlane`) acts on the database, for every process; the runner (`createRunner`) acts on
  this process: its mounts, its local pauses, `start`, `drain`, `close`. A producer creates no runner, so a web process
  cannot start a worker by mistake. A runner takes only a sqlane of its own copy of the package. The pauses say their
  scope in their names: `runner.pauseLocally` (memory, this process, sync) and `sqlane.lanes.pauseGlobally` (a row,
  every process, async).
- **Mounts at runtime.** A runner mounts and unmounts handlers and schedules at any time, so a process can change
  what it runs (a feature flag, a tenant, a test) without a restart. A claim and a fire keep the parts they began with;
  a job that runs keeps its handler, and counts toward the lane, by name, after an unmount.
- **Payload types, no validation.** A definition can declare its payload type, so the compiler checks `enqueue`, the
  handler, `globalConcurrencyLimits` and `globalRateLimits`. sqlane does not validate payloads at runtime, because the app knows its own rules. A
  payload is plain JSON without revivers. sqlane refuses a NUL character on both databases, because PostgreSQL `jsonb`
  refuses it.
- **No enqueue by name.** `enqueue` takes a definition only. An enqueue by name took the options of whatever
  definition the process knew, else the defaults: a producer without the definition silently enqueued jobs with other
  options (attempts, limits, retention) than the lane's. A producer imports the module of the lanes, which holds no
  handler code, so the definition costs it nothing. The reads and the admin methods (`jobs.list`, `retry`, `cancel`,
  `remove`, `runner.pauseLocally`, `getStatus`) keep a name: they change no option of a job.
- **One adapter, raw connections.** The adapter gives the dialect and the queue's pool. `enqueue` takes the driver's
  own connection, so the job joins the app's transaction. A connection must be in a transaction, because MySQL cannot
  detect one safely.
- **Adapters are subpaths of the core**, not packages. None needs a dependency of its own, because each one uses the
  ORM instance that it gets. The core does not list the ORMs as peer dependencies. npm checks the range of an optional
  peer that the app has, so a new major version of any ORM would break the install of the core for all its users.
  Instead, an adapter checks the ORM it gets and throws a `ConfigError` with the supported versions. CI tests each
  supported major version. An ORM adapter runs sqlane's SQL on the driver connection under the ORM, or through its
  raw-SQL API, so there is one SQL per dialect. [Adapters](adapters.md) describes each one.
- **What a job is in its definition; how a process runs it in its handler.** The options stored on the row
  (`maxAttempts`, `maxStalls`, `retention`, the global limits) are fixed at enqueue, from the producer's definition.
  `timeout`, `backoff` and `failureLane` take effect in the process that runs or fails the job, from the definition
  mounted there. The local limits and the weight are per process: they are options of the handler, so each worker
  sets its own caps, and the producers never see them.
- **Limits are objects.** `defineConcurrencyLimit()` and `defineRateLimit()` return a frozen object, which a
  definition lists or keys. A typo in a string cannot create a new limit, and the max is declared once, so two lanes
  cannot disagree on it.
- **Maxes frozen with the keys.** A worker cannot see the limit behind the key of a row: the definition's function
  runs at enqueue. So the row stores each key with its max, and each rate key with its settings, as it stores
  `maxAttempts`. A deploy that changes a max applies to the new jobs.
- **A 429 is not a failure.** A handler that the other side refuses throws a `RateLimitedError`: the key pauses for
  every job, and the job waits without using an attempt. A retry would use attempts for an error that is not the
  job's, and the other jobs of the key would each get their own 429.
- **Handlers own their transactions.** sqlane does not wrap a handler in a transaction or any other app wrapper. It
  stores no result.
- **AbortSignal** for timeouts and close, instead of a hidden race. The lease is renewed while the handler runs, so a
  long job needs no timeout. A job with global limits needs one (see [Global limits](#global-limits)).
- **No implicit work.** `createSqlane` connects, migrates and starts nothing.

## Data

Each table prefix (default `sqlane_`) has seven tables: the six tables below and `sqlane_migrations`. The names of
the tables and columns use snake_case. All times come from the database clock (`UTC_TIMESTAMP(3)` on MySQL,
`clock_timestamp()` on PostgreSQL), so clock skew between processes does not matter. Schedules compute their slots in
the process, but they decide each slot with the database clock ([Schedules](#schedules)).

In the tables below, `ts(3)` means `DATETIME(3)` with UTC values on MySQL, and `timestamptz(3)` on PostgreSQL. The
MySQL type does not depend on the session time zone, and it has no 2038 limit. sqlane sends a `runAt: Date` as a UTC
string on MySQL and as a `timestamptz` on PostgreSQL, never in the session time zone. It reads times back as epoch
milliseconds that SQL computes, and it computes every due time and wait time (`run_at - now`) in SQL. So sqlane does
not depend on the `timezone` or `dateStrings` settings of the pool.

### `sqlane_jobs`

| Column                                                                | Type              | Notes                                                                                                              |
| --------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`                                                                  | varchar(255), PK  | `<lane>:<dedupeKey>`, or a new ULID without `dedupeKey`. `<lane>:schedule:[<key>:]<ISO>` for a slot of a schedule. |
| `lane`                                                                | varchar(128)      |                                                                                                                    |
| `status`                                                              | varchar(16)       | `pending`, `blocked`, `running`, `completed`, `failed`.                                                            |
| `run_at`                                                              | ts(3)             | Due time.                                                                                                          |
| `attempts`, `max_attempts`                                            | int               |                                                                                                                    |
| `stalls`, `max_stalls`                                                | int               |                                                                                                                    |
| `limit_keys`, `limit_maxes`                                           | json / array null | The keys of the global limits and their maxes, frozen at enqueue, sorted by key. Written with the job row.         |
| `rate_limits`                                                         | json null         | The rate keys with their settings, `[{ key, max, per_us, burst, cost }]`, frozen at enqueue, sorted by key.        |
| `blocked_on`                                                          | varchar(255) null | The full key, or the rate key, of a `blocked` job.                                                                 |
| `fair_group`                                                          | varchar(255) null | The fair group, from the lane's `fairGroup` at enqueue. Since `0011_fair_groups`; written only when a job has one. |
| `enqueue_token`                                                       | varchar(26)       | Per enqueue call: tells created rows from duplicates.                                                              |
| `lock_token`                                                          | varchar(26) null  | Set by the claim. Every final write checks it.                                                                     |
| `locked_by`                                                           | varchar(255) null | `<host>:<pid>:<ULID>`.                                                                                             |
| `locked_until`                                                        | ts(3) null        | The lease.                                                                                                         |
| `timed_out_at`                                                        | ts(3) null        | Set on a timeout, cleared by the claim and by every transition out of `running`. For `stuck`.                      |
| `last_error`                                                          | json null         |                                                                                                                    |
| `completed_retention_ms`, `failed_retention_ms`                       | bigint            | Frozen at enqueue.                                                                                                 |
| `failure_lane`                                                        | varchar(128) null | Not written since 10.0: the definition of the process that fails the job decides its failure lane.                 |
| `created_at`, `started_at`, `finished_at`, `expires_at`, `updated_at` | ts(3)             |                                                                                                                    |

`attempts` counts the finished attempts: a completion, a retry and a failure each add one. A stall, a release, a
wait on a rate limit and the fail of a job past its `maxStalls` at its claim add none; the stalls have their own
count.

`id`, `lane` and the keys are case-sensitive: `ascii_bin` on MySQL, `COLLATE "C"` on PostgreSQL.

Indexes:

- MySQL: `(status, lane, run_at)`, `(status, blocked_on, run_at, id)`, `(expires_at)`, `(lane, created_at, id)`,
  `(status, lane, fair_group, run_at, id)`.
- PostgreSQL: partial `(lane, run_at, id) WHERE status = 'pending'`, partial `(locked_until) WHERE status =
  'running'`, partial `(blocked_on, run_at, id) WHERE status = 'blocked'`, `(expires_at)`, `(lane, created_at, id)`,
  partial `(lane, fair_group, run_at, id) WHERE status = 'pending'`.

The index of the fair groups (`0011_fair_groups`) serves the claim of a lane with fair groups: the skip from one group
to the next with pending jobs, and the oldest due jobs of a group. It covers the pending rows of every lane (MySQL and
MariaDB have no partial index: their status changes too), so it costs every enqueue a few blocks: the statement
snapshot records it.

`(lane, created_at, id)` serves `sqlane.jobs.list()`: the jobs of a lane, newest first, of any status. Its columns
never change after the insert, so the index costs one entry per insert, and an update never moves it.

### `sqlane_payloads`

`id` (PK), `payload` (json). Apart from the hot table: the claim and the probe do not read it. Deleted when the job
completes; kept for a failed job.

The keys are columns of the job row: they commit with the job even in autocommit, and a duplicate cannot add keys to
an existing job.

### `sqlane_concurrency_slots`

`limit_key`, `slot` (PK in this order), `job_id`, `lock_token`, `held_until` (null: held by a running job),
`created_at`; an index on `job_id`. One row per slot that a job holds, or that lingers after a release on close or a
stall. The primary key keeps two jobs out of one slot; there is no counter row, so the claims of a busy key do not
queue on one row. The held slots of a key are one range of the primary key.

### `sqlane_rate_limits`

`limit_key` (PK), `tat` (`ts(6)`: `DATETIME(6)`, `timestamptz(6)`); an index on `tat`. One row per rate key: its
theoretical arrival time, in microseconds of the database clock (`UTC_TIMESTAMP(6)`, `clock_timestamp()`). A claim
inserts a missing row at the current time. A row whose `tat` has passed is the same as no row, so the sweep of the stall
recovery deletes them in batches, with SKIP LOCKED: the keys of a limit per client do not pile up.

### `sqlane_paused_lanes`

`lane` (PK; the type and the collation of `sqlane_jobs.lane`), `paused_at` (`ts(3)`). One row per globally paused lane
([Global pauses](#global-pauses)); no row: not paused. The claims read it by its primary key.

### `sqlane_schedules`

| Column                     | Type              | Notes                                                                                         |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `id`                       | varchar(255), PK  | `<lane>` or `<lane>:<key>`. ASCII and case-sensitive.                                         |
| `lane`                     | varchar(128)      |                                                                                               |
| `spec`                     | varchar(512)      | The normalized spec: `cron <fields> <timezone>` or `every <ms>`. A late catch-up compares it. |
| `last_slot_at`             | ts(3)             | The cursor: the last decided slot. It only moves forward. Slots at or before it never run.    |
| `last_job_id`              | varchar(255) null | The job of the last enqueued slot. `overlap: 'skip'` reads it.                                |
| `created_at`, `updated_at` | ts(3)             |                                                                                               |
| `paused_at`                | ts(3) null        | The global pause of the schedule: no process fires it. Null: not paused.                      |

One small row per schedule, and no secondary index: each access is by primary key, or reads the whole table
(`schedules.list`). An app without schedules never touches it. sqlane deletes a row only at `schedules.remove()`:
services that share the table each know only their own schedules.

### Migrations

sqlane ships its schema as versioned migrations for each dialect. `sqlane.schema` applies them, reverts them, drops
their tables and checks them ([API](api.md#schemamigrate)). `sqlane_migrations` records the id of each applied
migration, with `applied_at`.

**Tags.** Each migration is tagged in code with the lowest version of sqlane that ships it, per dialect. The ids differ
between dialects, so the tags do too. Order is id order, and the tags never decrease with the ids (a unit test checks
it).

| Migration                 | PostgreSQL | MySQL  | MariaDB |
| ------------------------- | ---------- | ------ | ------- |
| `0001_initial`            | 0.1.0      | 0.1.0  | 2.0.0   |
| `0002_pending_order`      | 3.0.0      | -      | -       |
| `0002_job_keys`           | -          | 3.0.0  | 3.0.0   |
| `0003_job_keys`           | 3.0.0      | -      | -       |
| `0004_schedules`          | 4.0.0      | 4.0.0  | 4.0.0   |
| `0005_concurrency_limits` | 6.0.0      | 6.0.0  | 6.0.0   |
| `0006_concurrency_slots`  | 6.0.0      | 6.0.0  | 6.0.0   |
| `0007_rate_limits`        | 6.0.0      | 6.0.0  | 6.0.0   |
| `0008_job_list`           | 7.1.0      | 7.1.0  | 7.1.0   |
| `0009_lanes`              | 9.0.0      | 9.0.0  | 9.0.0   |
| `0010_pause`              | 10.0.0     | 10.0.0 | 10.0.0  |
| `0011_fair_groups`        | 10.1.0     | 10.1.0 | 10.1.0  |

A migration merged before its release is tagged with the version that its changeset gives: the next minor, or the next
major. If the release turns out higher, because a major is cut after it, the tag stays lower than the real release.
This is harmless: every pin at or above the real version includes it, and it counts as part of that major's base.

**What each method does.**

- `schema.migrate({ targetVersion })` applies the known migrations tagged at or below `targetVersion` that are not
  recorded, in id order. By default it applies every known migration.
- `schema.rollback({ targetVersion })` reverts the recorded migrations tagged above `targetVersion`, newest first: the
  down statements of each, then the delete of its record. It rejects when a recorded migration is unknown to this
  version, because its down is not in this code. Every migration tagged after 6.0.0 has a down: today `0008_job_list`,
  `0009_lanes` and `0010_pause`, then every new one. A down that drops a column or a table loses its data; its comment
  and the changelog say so.
- `targetVersion` goes from `6.0.0` up to the higher of the installed version and the highest tag. `0005` and `0006`
  turned the mutex keys of 5.x into concurrency slots, which have no faithful reverse, so `6.0.0` is the floor.
- `schema.drop()` drops every table that sqlane created under the prefix in any version, `IF EXISTS`: the current
  tables, the legacy `sqlane_mutexes` and `sqlane_job_keys`, then `sqlane_migrations` last, in one `DROP TABLE` (atomic
  on MySQL 8.4). It drops only if `sqlane_jobs` has `enqueue_token` and `lock_token` (every version since
  `0001_initial`), or `sqlane_migrations` records `0001_initial`. Else it rejects and drops nothing.
- `schema.rollback()` and `schema.drop()` reject while their instance is started or draining. Other processes on the
  prefix are the app's concern.

**Locks.** All three methods hold the migration lock of the prefix, and wait for it up to `lockTimeout` (default
`'10m'`). They run on one connection of the queue's pool.

- On PostgreSQL, the whole run is one transaction under `pg_advisory_xact_lock`, because PostgreSQL can run DDL in a
  transaction. It sets `statement_timeout = 0` for its transaction, so a long migration of a big table is not
  cancelled.
- On MySQL and MariaDB, the lock is `GET_LOCK`, and each DDL statement commits on its own.
- Some ORMs, such as Prisma, have no connection outside a transaction. With them, the run is a transaction of the ORM
  (the adapter sets `transactionalConnection`), and sqlane does not begin or commit a transaction of its own. sqlane
  calls `pg_advisory_xact_lock` in a `FROM` clause, because the function returns `void`, and Prisma cannot read this
  type.
- For `schema.rollback()` and `schema.drop()`, `lockTimeout` also bounds each statement's wait for the lock of its
  table: PostgreSQL `lock_timeout`, MySQL and MariaDB `lock_wait_timeout`, restored after use. A timeout rejects with a
  `MigrationLockTimeoutError`. While a DDL waits for its table lock, the queue's own queries on that table wait behind
  it, as with `schema.migrate()`. So pass a short `lockTimeout`, such as `'10s'`, while processes run.
  `schema.migrate()` sets no lock timeout after its own lock.

**A cut run.** On PostgreSQL, a cut run leaves nothing: its transaction rolls back. On MySQL and MariaDB, each DDL
commits, so a run can stop between two statements.

- Each down statement is safe to run again: `IF EXISTS`, or a check of the catalog where the dialect has none (MySQL
  has no `DROP INDEX IF EXISTS`, and neither MySQL nor MariaDB has `RENAME COLUMN IF EXISTS`). So a cut rollback is
  finished by running it again. Every up migration after `0008_job_list` follows the same rule.
- The older up migrations keep their own rules: not every one of their statements can run again. On MariaDB, they use
  `IF NOT EXISTS`, all but `0005_concurrency_limits`: one `ALTER TABLE` without guards. On MySQL,
  `0005_concurrency_limits` and `0008_job_list` are each one `ALTER TABLE`, and `0007_rate_limits` ends with an
  `ADD COLUMN`. Each `ALTER TABLE` is atomic, but a crash after it and before the record makes the next
  `schema.migrate()` fail: record the id by hand (see `0008_job_list` below).

**The migration ids** are matched, never counted. MySQL and MariaDB have no `0003`. The migrations of 6.0 drop the
tables of 5.x, `sqlane_job_keys` and `sqlane_mutexes`. The schedules migration has the same id on every dialect. It is
needed only with schedules: `start()` throws a `ConfigError` that asks for `schema.migrate()` when a process has
schedules and the table is missing.

**The reads.** `schema.getMigrationStatus()` tells what `schema.migrate()` would do, by the records.
`schema.findSchemaProblems()` tells whether the queries of this version find what they need, by the catalog. They can
disagree: records written by hand, an index built beforehand, or a cut run.

- Both only read, run outside any transaction, and never throw on a mismatch. sqlane never calls them by itself.
- They look in the current schema only: MySQL and MariaDB `TABLE_SCHEMA = DATABASE()`, PostgreSQL the `search_path`
  (`to_regclass`). A missing `sqlane_migrations` is read from the catalog, never by a failing `SELECT`, which would
  abort a PostgreSQL transaction.
- `findSchemaProblems()` compares with the definitions in `src/schema/expected.js`, written by hand from the
  migrations, per dialect. A test on every supported server checks them: no problem after a fresh `schema.migrate()`,
  after an upgrade from 8.0.0, and after the 5.x path.
- A migration is required when it is tagged at or below the base of the installed major, `X.0.0`. Within a major,
  the later migrations serve features that only fail on their own SQL without them (see [Versions](#versions)).

**The prefix.** A prefix must not share a table name with the app. A collision on any one table already breaks sqlane,
and `schema.drop()` drops it too. A `schema.migrate()` cut before its first table leaves only an empty
`sqlane_migrations`, which `schema.drop()` refuses: run `schema.migrate()` again.

`0008_job_list` builds the index `(job_name, created_at, id)` on the jobs: `(lane, created_at, id)` once `0009_lanes`
renames the column. `sqlane.jobs` requires it: on MySQL and
MariaDB, `jobs.list()` names it in an index hint and rejects without it.

- The build waits for the open transactions that wrote the jobs, and the writes that come after it wait for the build.
  On PostgreSQL, the migration sets no lock timeout after its lock, and `CREATE INDEX` blocks the writes of the table
  while it builds, because a migration is one transaction and `CREATE INDEX CONCURRENTLY` cannot run in one. MySQL and
  MariaDB build it online, but `ALTER TABLE` waits for the metadata lock, up to `lock_wait_timeout`.
- On a large PostgreSQL table, build the index before the migration, with the name and the columns of the migration,
  on a database before `0009_lanes`:
  `CREATE INDEX CONCURRENTLY <prefix>jobs_list ON <prefix>jobs (job_name, created_at, id)`, where `<prefix>` is the
  `tablePrefix` (`sqlane_` by default). The `IF NOT EXISTS` of the migration then skips it. A failed or cancelled
  concurrent build leaves an invalid index of that name, which `IF NOT EXISTS` would also skip: check
  `SELECT indisvalid FROM pg_index WHERE indexrelid = '<prefix>jobs_list'::regclass`, and drop and rebuild an invalid
  one.
- On MySQL, the `ALTER TABLE` commits before the id of the migration is recorded. A crash between the two makes the
  next `schema.migrate()` fail with `ER_DUP_KEYNAME` (1061), as with `0007_rate_limits`: record the id by hand
  (`INSERT INTO <prefix>migrations (id, applied_at) VALUES ('0008_job_list', UTC_TIMESTAMP(3))`). MariaDB has
  `ADD KEY IF NOT EXISTS`, so it runs again.

`0009_lanes` renames the columns of the lane: `job_name` to `lane` in `<prefix>jobs` and `<prefix>schedules`, and
`failure_job` to `failure_lane`; on MySQL and MariaDB, the index `<prefix>jobs_status_name_run_at` to
`<prefix>jobs_status_lane_run_at` too, which the hints of the queries name. The other indexes keep their names, and
their columns follow the rename. A rename changes only the metadata: no row is copied.

- PostgreSQL runs the renames in the transaction of the migration. MySQL and MariaDB run one `ALTER TABLE` for the jobs
  and one for the schedules, without an `ALGORITHM` clause, so the server picks; each runs only while the catalog has
  its old column, so a cut run runs again. The down renames back, with the same checks.
- On MySQL and MariaDB, `0009_lanes` also renames the index `<prefix>jobs_status_name_run_at`: if it was dropped or
  renamed by hand, restore it before `schema.migrate()` (`findSchemaProblems()` shows it).
- Each rename takes the lock of its table, as any DDL: it waits for the open transactions on the table, and the
  queries that come after it wait for it. Run `schema.migrate()` with no open transaction on the jobs table: the 8.x
  processes stopped.

`0010_pause` creates `<prefix>paused_lanes` and adds `<prefix>schedules.paused_at` (nullable, no default: metadata
only, no row is written). PostgreSQL runs both in the transaction of the migration. MySQL adds the column in a step of
its own that runs only while the catalog lacks the column (it has no `ADD COLUMN IF NOT EXISTS`), so a cut run runs
again; MariaDB has `IF NOT EXISTS`. The down drops both, with the pauses in them: the paused lanes and schedules run
again. `runner.start()` and `runner.drain()` read the records of the migrations once per runner and reject without
`0010_pause`: every claim and fire reads its table or its column. The check is not in the server check that
`schema.migrate()` shares, which must work on a schema without it. A read of the pauses on a schema without it (a
missing table or column: `42P01`, `42703`, `1146`, `1054`) is a `ConfigError` that asks for `schema.migrate()`.

`0011_fair_groups` adds `<prefix>jobs.fair_group` (nullable, no default: metadata only) and the index of the fair
groups. PostgreSQL runs both in the transaction of the migration: the build of the index holds the lock of the table,
so on a large table build it `CONCURRENTLY` beforehand, under its name. MySQL runs two steps, each only while the
catalog lacks its part (a new kind of step, `unlessIndexExists`): the column first (a nullable column at the end:
INSTANT), then the index (in place: the table stays writable); one `ALTER` with both would rebuild the table. MariaDB
has `IF NOT EXISTS`. The down drops the index, then the column, and the groups with it. It is optional in 10.x: a
runner reads its record with the check of `0010_pause`, and without it claims its lanes with `fairGroup` FIFO, adds
its own jobs (failure jobs, slots) without a group and reads no group in its claims. While it lacks it and has a lane, a
schedule or a failure lane with `fairGroup`, it reads the records again at `start()`, `drain()` and each poll interval,
so a later `schema.migrate()` takes effect without a restart. An enqueue with a group on a schema without it, and
`lanes.groupStats()`, are a `ConfigError` (a missing column: `42703`, `1054`); an enqueue without a group writes no
`fair_group` column, with the statement of 10.0.

### Versions

sqlane follows semantic versioning, and its schema follows these rules.

- Within a major, migrations only add. The code of a minor runs on the schema of its major's base, `X.0.0`. Only the
  feature that a later migration serves needs it, and that feature fails on its own SQL without it.
- To upgrade within a major, run `schema.migrate()` before or after the deploy.
- To upgrade to a new major, stop the processes of the old major, run `schema.migrate()`, then deploy. 8.0 is an
  exception: it changes no table. Once `schema.migrate()` has run (it adds `0008_job_list` where a 7.0.x database lacks
  it), 7.x and 8.0 processes can share a prefix during a rolling deploy.
- Run `schema.rollback()` only when no process of a newer version uses the prefix.
- One place runs `schema.migrate()` for a prefix. The processes on one prefix run the same major.

## Job states

```text
┌─ RateLimitedError on a rate key ────────────────────────────┐
▼                                                             │
blocked ◀─claim: a full key, no quota── pending ──claim──▶ running ──OK──▶ completed ──retention──▶ (deleted)
 │ └─ a slot frees, or its next start ────▶▲ │ ▲              │
 │                                         │ │ └── retry, stall,
 │                                         │ │     release ───┤
 │                                         │ │                └──no attempts left, fatal ───▶ failed (+ failure job) ──▶ …
 │                                         │ └── jobs.cancel ────────────────────────────────▶ failed (no failure job)
 └── jobs.cancel ──────────────────────────┼─────────────────────────────────────────────────▶ failed (no failure job)
                                           └── jobs.retry ◀──────────────────────────────── failed
```

`jobs.remove` deletes a job in any status but `running`.

A stall past `maxStalls` goes back to `pending` as any stall (running → pending), with its due time kept; its next
claim fails it at once, without a run (pending → running → failed, with its failure job; see
[Leases and stalls](#leases-and-stalls)).

A `RateLimitedError` on local rate limits only sends the job back to `pending`, like a release.

## How it works

### Enqueue

In the caller's transaction, with its connection (with a pool: in a transaction of sqlane):

1. Check the payload (JSON, at most `maxPayloadBytes`, default 256 KiB) and the options (`dedupeKey`, `delay` or `runAt`,
   `maxAttempts`, `maxStalls`, `retention`, `globalConcurrencyLimits`, `globalRateLimits`).
2. The global limits: the enqueue option if given, else the definition's function of the payload; as keys, sorted,
   with their maxes. The same for the rate limits, as rate keys with their settings and costs.
3. `INSERT` the jobs, with their keys, in the order of their ids. This order prevents deadlocks between concurrent
   enqueues. Then `INSERT` the payloads of the rows that have this call's `enqueue_token`. With a `dedupeKey`, an existing
   row means a duplicate. In this case, the enqueue returns `{ id, created: false }` and changes nothing, so it also
   skips the payload. Deduplication lasts while the row exists, in any state, so the retention is the deduplication
   window. After cleanup has deleted the row, the same `dedupeKey` adds a new job. On PostgreSQL, all of this is one
   statement (a CTE), which is atomic even outside a transaction.
4. PostgreSQL with the NOTIFY hint: `pg_notify` in the same transaction, delivered on commit.

Frozen in the row at enqueue: `maxAttempts`, `maxStalls`, both retentions, the keys and their maxes, the rate keys and
their settings. Any process can then retry or stall the job without its definition. Read from the worker's definition
at run time: `backoff`, `timeout`, `fairShareWeight`, the local limits, of concurrency and of rate, and `failureLane`
(at the fail, [Failure jobs](#failure-jobs)). The column `failure_lane` stays, but sqlane no longer writes it: the
rows of 9.x keep their value, which nothing reads.

`enqueueMany` inserts many jobs in one statement per table and returns `{ id, created }[]` in input order. `created`
comes from the call's `enqueue_token` (MySQL has no `RETURNING`): the payloads are inserted only for the rows with
this token, never for a duplicate committed by another transaction. A `dedupeKey`
repeated in one batch: the first is created, the rest are `created: false`.

### Dispatcher: one loop per process

Each process runs one dispatcher loop. The loop finds the due jobs of the lanes that the process added, claims as
many as the free slots allow, and starts their handlers. The pseudo-code below shows its steps.

```text
loop while started
  lanes = handled lanes, not paused here, with a free slot (under each of its local limits and the runner's cap),
    and quota in each of their local rate limits
  if no lanes: wait for a wake, or the poll
  probe: the next run_at of each lane that has pending jobs and no global pause (one statement)
  if nothing due: wait until the next run_at (at most the poll interval) or a wake
  turn = the due lanes, the lowest running / weight first, at most 4 per free slot and 4 per free slot of each of
    their local limits; the others at the next turn
  lanes with global limits in the turn: their candidates (due jobs whose keys have room), and their due jobs with a
    full key, once per turn; a plan with fill() leaves them their share of the free slots, of the instance and of
    their local limits
  plain lanes with fair groups (a runner definition with fairGroup): their groups with pending jobs (one statement)
  plain lanes: lock the oldest due jobs of each, up to min(the rooms of its local limits, the free slots), and take
    them by share (fill(): the lowest running / weight first, ties round-robin); a lane with fair groups locks the
    oldest due jobs of its groups instead, in the order of its groups
  lanes with global limits: claim their candidates whose keys have room, by share; block those with a full key
  claimed: start the handlers, loop at once
  none (other processes took them): back off 10–200 ms, with ±50 % jitter
  none (all due jobs blocked): wait for the end of a job of a key, the timer of a rate key, or the poll interval
  a deadlock, a serialization failure, ER_CHECKREAD: the turn again at once, after 5–30 ms, up to 3 times
  another error (a lock wait timeout too), or a 4th such error in a row: an `error` event, then wait
    min(poll interval, 1 s)
```

**Deadlocks of a turn are retried at once.** A deadlock, a serialization failure or a 1020 of a claim says nothing
about the next claim, so the turn runs again after a 5–30 ms jitter, logged at debug level, with no `error` event. A
lock wait timeout is not: the lock is likely still held, and 4 tries would wait 4 × `innodb_lock_wait_timeout` (200 s
by default) with no event; it is reported and backed off at once. After 3 such retries in a
row, the error is reported (`error` event, `logger.error`) and the loop backs off, as for any other error; a turn that
succeeds, or the back-off, resets the count. The retries are bounded, so a database that keeps failing costs 4 turns
per back-off, not a busy loop.

**The probe is the key to cheap idle lanes.** The probe is one statement, and it reads only the lanes that have
pending rows.

- On MySQL, the probe is
  `SELECT lane, MIN(run_at) FROM sqlane_jobs WHERE status = 'pending' GROUP BY status, lane`. With the index
  `(status, lane, run_at)`, MySQL uses a loose index scan, which makes one index lookup per pending lane. The
  `GROUP BY` names the whole index prefix, because `GROUP BY lane` alone gets a full index scan.
- PostgreSQL has no loose index scan. Instead, a recursive CTE skips from one pending lane to the next on the partial
  index. It makes two index lookups per pending lane.

**Free slots are shared by weight.** A free slot goes to the eligible due lane with the lowest
`running / fairShareWeight`, under its caps; ties go round-robin from a pointer that starts at a random lane in each
process, so a fleet does not send every process to the same lanes. The chooser, `fill()` in `fair_share.js`, is a heap
with exact integer comparisons (`a.running × b.weight` against `b.running × a.weight`). Each event changes one count by
one: a free slot raises the lowest share by `1 / weight`, and a finished job lowers its own lane's count. So after each
dispatch, for two lanes with due jobs and room, `running_a / w_a − running_b / w_b ≤ 1 / w_a`: the running counts stay
within one slot of the water-filling target at every moment, with no state but the counts and the pointer. The odd
remainder slot goes by ties, not by time, so it favors long jobs (see
[How free slots are shared](api.md#how-free-slots-are-shared)).

**Which lanes a claim requests.** A claim locks up to the free slots of each lane that it requests, so a claim of all
1000 due lanes would lock thousands of rows to start a few jobs. A claim requests at most 4 lanes per free slot: the
lanes furthest under their share first (`rankNames()`), and at most 4 per free slot of each of their local limits: a
full limit takes no more lanes, so the lanes after it get their turn. The lanes that the rule serves are always a prefix of that
order, and the other lanes are a margin for lanes whose jobs other processes hold. A claim that fills the free slots does not read the
next due times of its lanes: they stay in the backlog, and the next turn claims them again.

**Each lane once.** On MySQL and MariaDB, each requested lane is one branch of the `UNION ALL` that locks the due
jobs, and `SKIP LOCKED` does not skip the transaction's own locks: a lane requested twice would lock its jobs twice,
and the process would run each of them twice. A probe of more than 100 lanes reads all lanes (a long list makes a slow
range plan), so it also gives the lanes that the turn claims at once: the turn keeps each lane once. The store drops a
repeated lane as well (its first request counts), and the process does not start a job that the same claim gave
twice: an `error` event instead. On PostgreSQL the `UPDATE … FROM` of the claim updates a row once, however many
times it is locked, so there a repeated lane could only skew the share.

**The lanes with global limits** find their candidates once per turn, before the plain claim. A plan over all the
lanes of the turn gives them their share of the free slots, on their candidate counts, and the plain claim leaves
those slots free: in the instance, and in their local limits (the plain claim gets the rooms of the limits minus the
reserved slots, and a `maxJobs` within them). If other processes take the candidates first, the reserved slots stay
free for one turn, which comes at once.

The process ignores the lanes that it does not handle. An idle lane has no pending row, so it costs nothing. With 1000
lanes and pending jobs in 10 of them, the probe reads 10 index entries. A probe with one query per handled lane (a
`UNION`) would grow with the number of all lanes.

These events wake the dispatcher:

- An enqueue in this process, or a hint from another process. See
  [Wake-up after the commit](#wake-up-after-the-commit).
- A finished job, which frees a slot. A job that finishes in a full local limit wakes every lane of the limit, not only
  its own: the slot it frees can go to any of them. A job with global limits first unblocks the jobs of its keys, and
  wakes their lanes, here and in the other processes.
- The timer of a rate key on which this process blocked jobs, and the time at which a local rate limit allows a start
  again (see [Rate limits](#rate-limits)).
- The poll interval (5 s by default). It is the fallback, and it also finds jobs whose delay has ended.

### Wake-up after the commit

A raw driver has no after-commit event, so `enqueue` does not know when the job becomes visible. The business logic
does not need to call anything, because sqlane uses the following signals.

- **Re-probes, the default for any driver.** After an enqueue of a handled lane, the dispatcher of this process probes
  again a few times. The steps are 20, 50, 100, 200 and 500 ms, 1 s and 2 s after the enqueue, and only the steps that
  are shorter than the poll interval count. A probe reads all the lanes, so a process has one series of re-probes. Each
  enqueue restarts the series from its own time, but a re-probe that is already due within the next 20 ms is kept. The
  series then goes on from the time of the new enqueue. So a burst of enqueues gives at most one re-probe per 20 ms. The hint transport sends the lane to the other processes
  at enqueue time, and it does not wait for an answer. The other processes then re-probe in the same way. The latency
  is the commit time plus at most one step, and it is never more than the poll interval. A rolled-back transaction
  costs only the re-probes.
- **PostgreSQL NOTIFY.** `pg_notify` runs in the transaction, and PostgreSQL delivers it at the commit. The receivers
  probe at once, without re-probes.
- **After-commit hooks.** An adapter can have an `afterCommit(connection, fn)` function. The ORM adapters build it from
  the after-commit hook or promise of the ORM. An `enqueue` on a pool runs in a transaction of its own, which has
  committed when `enqueue` returns, so it works the same way. After the commit, the process wakes at once and sends the
  hint. Then it re-probes as above, counted from the commit.
- **No `wake()`.** An enqueue in the process and the hints wake the runner; the poll is the fallback. A runner mounted
  after `start()` claims at once.

The commit event of an ORM is a signal, not a proof, so a probe of the table decides. The cases below were checked with
knex 3.3 and Sequelize 6.37, against MySQL 8.4 and PostgreSQL 18.

- **A late event is harmless, but an early event is not.** An event without a commit costs one probe. An event that
  comes before the job is visible would leave the job to the poll. The re-probes that follow the event cover this case.
- **Events without a commit.** Sequelize runs its `afterCommit` hooks in a `finally` block, so it also runs them when
  `COMMIT` fails. On PostgreSQL, a `COMMIT` after a failed statement whose error the app caught returns `ROLLBACK`. In
  that case, knex resolves its transaction and Sequelize runs its hooks, although nothing was committed.
- **Early events.** A nested transaction (a savepoint) completes before the outer `COMMIT`, and the outer transaction
  can still roll back. So the adapters hook the top-level transaction (knex `parentTransaction`, Sequelize `parent`).
  They never read the state flags of the ORM, because Sequelize sets `finished = 'commit'` when it sends `COMMIT`,
  before the server answers.
- **The server.** MySQL and PostgreSQL make a transaction visible before they answer `COMMIT`, also with semi-synchronous
  or synchronous replication. The queue's pool should connect to the server that the app writes to. On a replica, or on
  another member of a multi-primary cluster, the commit can become visible later.

### Hints

A hint is a message between processes. It says that jobs of a lane are ready. The app implements the generic
publish/subscribe interface below, for example with Redis or NATS. The [API reference](api.md#hint) shows an
implementation for ioredis.

```js
/**
 * @typedef {object} Hint
 * @property {(channel: string, message: string) => Promise<void>} publish
 * @property {(channel: string, onMessage: (message: string) => void) => Promise<() => Promise<void>>} subscribe
 *     Resolves to the unsubscribe function.
 */
```

- With `hint: null`, other processes find new jobs at their next poll. Re-probes in the same process and NOTIFY still
  work.
- With `hint: { publish, subscribe }`, the channel is `<tablePrefix>ready`, and the message is a lane, or `*`
  to wake all lanes (after a sweep). sqlane
  publishes the hint after an enqueue, and `enqueue` does not wait for `publish`. A failed publish never rejects
  `enqueue`. Instead, sqlane emits an `error` event. A process sends a hint only for the jobs that it cannot start
  itself. When a job frees slots of global limits, the message is the lane of each job that it unblocked. A
  receiver re-probes
  for a short while, as after its own enqueue, because the hint can arrive before the commit.
- With `{ notify: true }` on the pg, postgres.js or Drizzle adapter (PostgreSQL), sqlane listens on a dedicated
  connection. With pg, and with Drizzle over node-postgres, this connection comes from the queue's pool. postgres.js
  opens its own connection with `sql.listen`. The enqueue sends `pg_notify` in its transaction, so the hint arrives
  only after the commit. Each enqueue that adds a job calls `pg_notify`. PostgreSQL drops the duplicate notifications
  of a transaction, so it delivers one notification per transaction and lane. NOTIFY takes a global lock at the
  commit, so under a heavy write load it can limit the commit rate of the whole database.
- Hints are throttled. A process sends at most one message per lane in each interval of 100 ms.

A lost hint delays a job until the next poll. It never loses a job.

### Claim

**Names without global limits** (in the definition of the claiming process): the due jobs are found, claimed and read
at once, without candidates. A locked row with global limits or rate limits (from its enqueue options) is not taken:
the claim returns its lane, and the process claims that lane with its limits from then on. A row past its `maxStalls`
counts as one without limits, here and in the claim of lanes with global limits: its claim fails it
([Leases and stalls](#leases-and-stalls)).

- PostgreSQL: one statement, a transaction of its own. A `LATERAL` per due lane locks its oldest due jobs
  (`FOR UPDATE SKIP LOCKED`, at most `min(the rooms of its local limits, free)`). The k-th locked row of a lane gets
  the share `(running + k − 1) / weight`, its share just before it takes the row. Ordering all rows by `(share, tie)`
  is the greedy of `fill()`, row by row. Without local limits, `LIMIT` keeps the instance's cap. With them, a
  recursive CTE walks the rows in that order and takes a row while the instance and each of its limits have room: a
  lane can have several limits, so one `ROW_NUMBER` per limit would not do. The shares
  are `float8`: equal rationals give the same double, and different ones (weights ≤ 1000) differ far above its
  precision. An integration test checks the choice against `fill()` on random claims. The statement also
  returns `unpicked`, the lanes with a locked row that the claim did not take. The runner replays the choice with
  `replayTie()` (`fill()` over the claimed rows, plus one row of each unpicked lane, under the counts and limit rooms
  that the claim was given) and moves the tie pointer as `fill()` would. The replay leaves out the lanes with no
  claimed row and a share above every claimed share: they never took a slot, nor tied. A property test checks the
  replay against `fill()` over all the locked rows.
  An `UPDATE … RETURNING` in a CTE claims the rows, joined with their payloads.
- MySQL: one short transaction. One `UNION ALL` locks the oldest due jobs of each lane with their payloads
  (`FOR UPDATE OF j SKIP LOCKED`); `fill()` chooses among them in JS, and one `UPDATE` claims them. The others are
  unlocked at the commit. The payloads are not locked: they are a consistent read, from the read view of the
  statement's first read, while the job rows are the latest committed ones. A job whose enqueue committed during the
  statement is locked without its payload. Before the `UPDATE`, one more statement of the same READ COMMITTED
  transaction, which gets a new read view, reads the payloads of the chosen jobs that came back without one. Only then:
  the usual claim keeps its statements. A test of each MySQL-family adapter checks that the queue transaction is READ
  COMMITTED.

So one turn of a process makes 2 round trips to the database on PostgreSQL: the probe and the claim statement. On
MySQL with the mysql2 adapter, it makes 6 round trips: the probe, and 5 for the claim transaction (the isolation level, `BEGIN`, the locking
read, the `UPDATE` and `COMMIT`).

**Lanes with fair groups.** A lane whose runner definition has `fairGroup` (with `0011_fair_groups`, and no job of it
with global limits) is a plain lane whose rows come in the order of its groups: the share between lanes, the caps and
the tie pointer of the lanes are those of the plain claim. Before the claim, one statement reads its groups with pending
jobs and the first due time of each: on PostgreSQL a recursive CTE skips from one group to the next on the index of the
groups (`min(fair_group) > the last one`), plus the null group; on MySQL and MariaDB a loose index scan, `GROUP BY
status, lane, fair_group`. A lane with no due group leaves the claim (with only delayed groups, its next due time is
scheduled). `fair_groups.js` ranks the due groups: the fewest jobs running in this runner first, then the rotation of
the groups (byte order, the null group last) from a pointer after the last group that won a tie, random at first. The
claim requests at most `min(4 × maxJobs, maxJobs + 8)` of them: the extra groups cover rows that other claims hold.
Each group locks its water-fill share of the lane's `maxJobs`, plus one for a group with fewer due rows than its share.
The probe does not count the due rows of a group: with many slots, one big group and many groups of one job, the slots
that the small groups cannot fill stay free for one turn, which comes at once. The walk over the groups costs each turn: with empty
handlers and 10 slots, a lane with 10, 100 and 1000 groups with pending jobs (half of them delayed) ran at about 80 %,
50–70 % and 30–50 % of the same lane without groups (PostgreSQL 18 and MySQL 8.4, 2000 jobs). Jobs that take seconds
hide it.

- PostgreSQL: the claim statement of grouped lanes (the plain one is unchanged) locks the groups in two CTEs, one for a
  group (`fair_group = $grp`), one for the null group (`fair_group IS NULL`), each a LATERAL with `ORDER BY fair_group,
  run_at, id … FOR UPDATE SKIP LOCKED`: the group is fixed per branch, and that order makes the generic plan read the
  index of the groups; `ORDER BY run_at, id` would read the old index and filter out the backlog of the other groups,
  and an `OR` would lose the ordered scan. PostgreSQL rejects `FOR UPDATE` in a `UNION`: the CTEs are united after
  their locks. The rows of a grouped lane rank by `running of the group + rank in the group − 1`, then the tie of the
  group: the order of `fill()` over its groups, row by row. Its rows past its `maxJobs` are cut; then the lane share of
  the k-th row and the pick, as for plain lanes. The statement also returns the groups with locked rows left: the
  runner replays the choice of the groups (`movedPointer`) for the pointer of the lane.
- MySQL and MariaDB: a branch of the `UNION ALL` per group, on the index of the groups (`FORCE INDEX`); the null group
  orders by `run_at, id`, which MySQL 8.4 reads from the index, where `ORDER BY fair_group, …` with `fair_group IS NULL`
  sorts every due row of the group. The runner orders the locked rows of each grouped lane by its groups before the
  choice by share. One lane alone takes at most its `maxJobs` of them: it locks more.
- Rows with global limits in a grouped lane (from another definition of the lane, or older enqueue options) make the
  lane a lane with global limits, FIFO, until the runner restarts, as any lane: with a warning.
- The claimed rows of a grouped lane are a prefix of the order of its groups: the walk of the local limits skips every
  later row of a lane once a limit is full, and `LIMIT` cuts a prefix. The pointer of the groups relies on it.

**Names with global limits** (concurrency or rate): the candidates, then one short transaction on the queue's pool. The
candidates are the oldest 500 due jobs of each lane, split by the held slots and the quota of their keys: those whose
keys have room, at most twice the free slots of the lane, and those with a full key or a rate key without quota.

1. `SELECT … WHERE id IN (candidates) AND status = 'pending' AND run_at <= now ORDER BY run_at, id FOR UPDATE SKIP
   LOCKED`.
2. Read the held slots of their keys. Block the jobs with a key whose held slots reach the max of the job:
   `status = 'blocked'`, `blocked_on` = that key.
3. Lock the rows of the rate keys of the others, in the order of the keys (a missing row is inserted first), and read
   their debts and their oldest blocked jobs. Block the jobs over the quota of a key, or behind an older job of the key
   ([Rate limits](#rate-limits)).
4. Choose among the others by share, FIFO within a lane, counting the slots and the quota that the choice takes
   (`pick()`).
5. Take a slot of each key of the chosen jobs (below). Drop the jobs that did not get all their slots.
6. Move the `tat` of each rate key by the costs of the jobs that start.
7. `UPDATE` to `running` with a new `lock_token`, `locked_by`, `locked_until = now + lease` (4 minutes).
8. Read the payloads.

**The start time.** Each claim writes one time to `started_at` of its jobs and to `created_at` of their new slots: the
start of the run, which `JobInfo.startedAt`, the `claimed` event and `JobRecord.startedAt` show. On PostgreSQL, the
insert of the slots takes `clock_timestamp()` once, in a materialized CTE, and returns it (`RETURNING`) as epoch µs; the
claim's last statement writes it to `started_at` as a parameter, and without slots takes `clock_timestamp()` itself.
It returns the stored value, rounded to the millisecond. No statement is added to the hot path, but the time comes
before the insert's waits: a wait on another claim's insert of the same slot makes `startedAt` early by that wait
(milliseconds: the rest of the other claim's transaction). Taking it after the inserts would cost one more statement,
as an `UPDATE` of the slots in the last statement did. MySQL and
MariaDB have no `UPDATE … RETURNING`: the claim reads the database time in its latest read before the write (the lock
read, the read of the slots or of the rate keys, the read of the acquired slots), and writes it back as epoch µs
(`'1970-01-01' + INTERVAL ? MICROSECOND`, never a `Date`, which a driver's time zone would shift). The jobs `UPDATE`
reaches the new slots in the same statement, through a derived table of the acquired holds joined by the slots'
primary key: one row per hold, and no lock waits on the slots of other jobs. Its columns are `ascii`/`ascii_bin`, as
those of the join: with the utf8mb4 of a bare parameter, the join cannot use a key on the derived table and reads it
once per job, and MariaDB 11.8 fails on the collation mix.

Then the handlers start. A job without its payload (a broken enqueue outside a transaction, a manual change) goes back
to `pending` with a 1 s delay and no attempt used, while it is younger than 60 s (its payload can still be on the way).
After that it fails for good with a `MissingPayloadError`, without retries; its failure job runs.

### Leases and stalls

A lease is the time for which a process owns a running job. A lease lasts 4 minutes, and you cannot configure it.

- The process renews the leases of its running jobs about every 30 s, in one statement. It also renews them while
  `close()` waits for the handlers and during `drain()`.
- Every final write (complete, retry, fail or release) has the condition `WHERE lock_token = :own`. So a process that
  lost its lease changes nothing.
- Completions go in batches. A process runs one write at a time, and the jobs that finish during a write go together
  in the next one. That write is one transaction with one commit, for at most 100 jobs. A lone job does not wait for
  other jobs. A commit flushes the log to disk, so one commit per job would limit the throughput.
- The renewal can fail, for example when the database is unreachable or the pool is exhausted. If the process cannot
  renew a lease until 30 s before it ends, it aborts the handler's `signal` with a `LeaseLostError` and emits
  `lease_lost`. The job no longer belongs to the process.
- Each process runs stall recovery about every 30 s. It handles at most 100 jobs per run, and one transaction per
  job. Its first statement is one read without locks: the stale jobs, and whether there is work for each part of the
  sweep (ended lingers, orphan slots, blocked jobs, rate rows whose `tat` passed). Only the parts with work run, so an
  idle recovery is that one statement. A row that commits after the read waits for the next recovery, about 30 s; the
  unblocks after the claims and releases, and the timers of the rate keys, do not wait for it. On PostgreSQL the read
  compares the leases and the `tat`s with the start of the statement, so their indexes find them; the recovery of a
  job checks its lease again. A `running` job whose lease has ended gets one more stall. It goes back to `pending` with a delay of
  30 s × 2^stalls, which is at most 1 h. So the first stall delays the job by 30 s, and the second stall by 60 s.
- **Past `maxStalls`.** After `maxStalls` stalls (2 by default), the next stall releases the job the same way, with
  `stalls = maxStalls + 1`, but keeps its due time: it is due at once, in its place in line, not behind the backlog of
  its lane. Its next claim, in a process that adds its lane, fails it at once, as a `FatalJobError` would (a
  `StalledError`, no retry), without a run and without an attempt used, with the failure job of the definition of that
  process. That claim treats the row as one without global limits and rate limits: never blocked, it takes no global
  slot and no global quota, and the process takes no quota of its local rate limits for it. It still counts toward the
  local concurrency of the process while its fail is written. The process emits `claimed`, then `failed`; `drain()`
  counts it, and `close()` waits for its write. The recovery locks the job row only: it reads neither the payload nor
  the failure lane. The recovery runs in every process, for every
  lane, and adds no failure job: only a process with the definition of the lane knows its failure lane. A job of a
  lane that no process adds waits `pending`, as any job of that lane, and holds no slot once its linger ends.
- The keys of a stalled job linger for one more lease (4 minutes, in `held_until`) instead of being deleted, because
  the old handler may still run. So a job with global limits runs again only after this time.
- So after a crash, the leases of the process end within 4 minutes. Another process finds the jobs within about 30 s,
  and it runs them again 30 s later. A job with global limits waits one more lease (4 minutes).
- When a database write of a result fails, the process retries it for up to 10 minutes and renews the lease meanwhile.

### Global limits

A global limit counts the running jobs of each of its keys in the whole cluster: `order:42`, or the limit's name for a
limit without keys. A key of a limit of 1 is a mutex.

- **Format.** A job has at most 10 keys. A key has at most 255 printable ASCII characters. sqlane removes duplicate keys
  at enqueue, before it counts them. The keys are global strings, so jobs of different lanes can share them. Each key
  is stored with the max of its limit, frozen at enqueue.
- **Slots.** A running job holds one row of `sqlane_concurrency_slots` per key: `(key, slot)`, the lowest slot that no
  job holds. A job starts if, for each of its keys, fewer slots are held than its own max. The claim inserts the rows in
  the order of `(key, slot)`, so the transactions of the queue cannot deadlock on them, and a job holds all its slots
  or none: two claims that race for one slot conflict on the primary key, and the loser drops the slots it took. Every
  transition out of `running` deletes the rows in the same transaction, except when they linger (see below).
- **Two maxes for one key.** Jobs enqueued before and after a deploy that changed a max carry different maxes. Each job
  checks its own: after a lowering, new jobs wait until the held slots drop below the new max. Two claims that race
  during the change can overshoot the lower max for a moment; with one max, the slots are exact.
- **Blocked jobs.** A claim blocks a due job whose key is full: `status = 'blocked'`, `blocked_on` = the key. It leaves
  the due jobs, so the 500 candidates of a lane are never all jobs of one full key, and a flood of one client does not
  hold back the others. Jobs of a key start in FIFO order among those that can start; a job with several keys waits
  only for its full keys, so under contention it can wait longer than a newer job with fewer keys.
- **Unblock.** After the end of a job with keys, and after a claim that blocked jobs, the process unblocks the keys: the
  oldest jobs blocked on each key, as many as its free slots by the max of its oldest blocked job, go back to
  `pending`, and their lanes are woken here and by a hint. The release and the claim each unblock after their own
  commit, so the later of the two sees both: a job is not left blocked on a key with room. An unblocked job that is
  still blocked by another key is blocked again on that key. The stall recovery sweeps the keys with blocked jobs about
  every 30 s, for a process that stopped before its unblock and for the slots whose linger ended.
- **Which jobs count.** A claim reads the keys of the rows, not the definition: a job of any lane with keys from its
  enqueue options counts. A worker claims a lane through the global limits when its definition has
  `globalConcurrencyLimits` or `globalRateLimits`, or once a plain claim met a row of the lane with limits.
- **Fair share.** A lane whose due jobs all have full keys has no candidates: it takes no slot and banks nothing.
- **Timeout.** JavaScript cannot stop a handler. On a timeout, sqlane aborts the `signal` with a `JobTimeoutError` and
  emits a `timed_out` event. The job stays `running`, and its lease is renewed. It keeps its slots and its slot of the
  process until the handler settles, but for at most one more lease. During this time, `lanes.stats()` counts it as
  `stuck`. Then the attempt fails with the `JobTimeoutError`. The job is retried after its backoff, or it fails for
  good, and its slots are freed. This applies to all jobs, with or without keys.
- **Linger.** The slots outlive their job row only in two cases, as rows with a `held_until` time. The first case is a
  release on close while the handler still runs. The slots then stay until `exitsBy` plus 2 s (see [Close](#close)).
  The second case is a stall. The slots then stay for one lease, because the old handler may still run. So the old run
  and the new run do not overlap, unless a handler ignores its `signal` past the lease or past `exitsBy`.
- **Sweep.** A claim takes over an ended linger; the stall recovery deletes the others, 100 at a time, then the orphan
  slots, then unblocks. On MySQL it locks the ended lingers first, in the order of `(key, slot)`, with SKIP LOCKED, and
  deletes them by primary key: a `DELETE … LIMIT` scans the table, waits for the slots that claims and releases hold,
  and holds the lingers that it already deleted, which they may wait for. A locked linger goes at the next sweep.
  PostgreSQL deletes them with SKIP LOCKED too. MariaDB keeps the one `DELETE`: the two statements deadlocked between
  concurrent sweeps on 10.11, the `DELETE` did not under the same load. A deadlock, a serialization failure or a 1020
  that is left runs the sweep again at once, after 5–30 ms, up to 3 times, as a turn of the dispatcher; then it is an
  `error` event.
- **A job with global limits needs a timeout.** The lease is renewed while a handler runs. Without a timeout, a hung
  handler would hold its slots in the whole cluster forever. So `runner.mount()` throws a `ConfigError` if the definition has
  `globalConcurrencyLimits` and no timeout, from the definition or from `defaults`. A job can also get limits only from its enqueue options. If its handler has
  no timeout, the job fails for good at the claim with a `FatalJobError` ("a job with global concurrency limits needs a
  timeout"), and its failure job runs.

### Rate limits

A rate limit counts the starts of jobs: `max` per `per`, with bursts of up to `burst`. A global limit counts per key in
the cluster, in `sqlane_rate_limits`; a local limit counts in the memory of each process. A rate key is `@<name>` or
`@<name>:<value>`: the `@` keeps it apart from the concurrency keys, whose names start with a letter.

- **GCRA, one row per key.** A key has one time, its `tat` (theoretical arrival time). With `T = per / max` and
  `τ = (burst − 1) × T`, a job of cost `c` may start at `t` if `max(tat, t) + c × T − T − τ ≤ t`, and its start sets
  `tat = max(tat, t) + c × T`. The times are whole microseconds: the increments are rounded up and the allowances down,
  so the rounding delays a start by microseconds, never adds one. Any window of length `per` sees at most
  `max + burst − 1` starts, counted by cost; with `burst: 1`, the starts are `per / max` apart. The next allowed time is
  exact, so a blocked job needs no polling, and there is no counter to reset, nor a refill to run.
- **Why not a fixed window, a log, or a retry.** A fixed window lets `2 × max` start across its boundary, and its
  counter needs a reset. A log of the starts needs a row per start. Turning a job over the limit into a failed attempt
  uses its attempts on a limit that is not an error, and its backoff grows. Pushing its `run_at` would keep the waiting
  jobs in the due index, where every claim reads them again, and would lose their order.
- **In the claim.** The claim locks the rows of the rate keys of its jobs: an `INSERT` of the missing rows at the
  current time, which locks the existing ones, in the order of the keys. On PostgreSQL, the statement that locks the
  jobs does it, when their lanes are known to have rate keys; else a statement of its own. Then a read of the rows,
  with the oldest job blocked on each key, in a statement after the lock: it sees the jobs that another claim blocked
  while it held a row (a single statement would read them in its snapshot, taken before it waited). The order of the
  locks is the same everywhere: the job rows, the rate rows, then the slots. So the claims, the releases and the
  writes of a `RateLimitedError` cannot deadlock. `pick()` counts the quota as it counts the slots, and the `tat` moves
  only for the jobs that also got all their slots: a job takes its quota only when it starts, and nothing is given
  back. A job whose concurrency key and rate key are both full is blocked on the concurrency key: its release unblocks
  it without a timer.
- **Blocked, with a timer.** A job over the quota is blocked on the rate key, with `run_at` unchanged and no attempt
  used, so a flood on one key does not hold back the others. The process that blocks it arms a timer at the time when
  the oldest blocked job of the key may start: one timer per process, over a heap of keys. The timer unblocks the
  oldest jobs of the key, as many as the quota allows now (at most 500), wakes their lanes here and by a hint, and arms
  itself for the next one. The unblock does not take the quota, the claims do: until they catch up, the next unblock
  of the key in the process counts the jobs that it made pending as if they started then. So a full batch is followed
  at once by the next one only while the quota admits more, and a long pause does not turn the whole queue pending.
  The unblock reads the oldest blocked job of the key first: by its settings and the debt, `n` jobs fit, and it
  locks `n + 1`, skipping the locked ones (on MySQL and MariaDB, in the transaction of the update). So its cost follows
  the jobs that it makes pending, not the length of the queue: a saturated key with 1,000 blocked jobs reads 2 rows,
  not 501. With `n = 0` it locks none, and waits for the oldest job, even if a cheaper one after it would fit. A job of
  other settings after the first `n` (a deploy changed the limit) waits for the next unblock, at once, like the one
  after a full batch. An unblock that finds all of them locked, by an unblock of the key in another process, checks
  the key again in 1 s. One that finds some of them locked reads past them, and does not count the jobs that the other
  one makes pending: it may make pending jobs that the quota does not admit yet. Their claims block them again, so the
  quota holds. An unblock that leaves no blocked job on its key arms one more, a check at the next start (in 1 s at
  the earliest): a claim that blocked a job behind the ones that it made pending, while it ran, saw them blocked and
  armed no timer.
  A newer job behind a blocked one arms no timer either: the timer of the key's queue covers it. The sweep of the
  stall recovery, about every 30 s, unblocks the due keys whose process stopped and takes over their timer. So a
  process that dies delays the jobs of its keys by up to about 30 s. A timer that fires after `drain()` returned keeps
  its key for the next `start()` or `drain()`; `close()` waits for an unblock that runs, and arms no timer after.
- **FIFO per key.** A job waits behind an older job blocked on any of its rate keys, even if the quota would let it
  start. So a job of a high cost, or with several keys, is not overtaken forever by cheaper jobs. The order is
  `run_at`, then the id.
- **A 429.** A `RateLimitedError` on rate keys of the job sets, in one transaction,
  `tat = max(tat, now + retryAfter + τ)` for each of them: it only extends, and `τ` makes the next start come at
  `retryAfter`, without a burst, then one per `per / max`. The job is blocked on its first key, with no attempt used,
  and its slots are freed. All the jobs of the key wait, as the other side refuses them all. There is no cap on the
  bounces of a job.
- **Local limits.** The same GCRA in memory, on the monotonic clock of the process. A local limit has no keys, and a
  start costs 1. A lane over one of its local rate limits gets no slot, and its jobs stay pending; the process wakes it
  when the limit allows a start. A `RateLimitedError` on a local limit pauses it in this process, and the job is
  pending again at once: another process may take it.
- **Settings frozen with the keys.** The `rate_limits` of a job hold `max`, `per`, `burst` and the cost of each key.
  After a deploy that changes a limit, each job checks its own settings against the one `tat` of the key.
- **Retries count.** A retry, or a run after a stall, starts the job again, so it takes its quota again: the other side
  sees every call.

### Failure jobs

When a job fails for good (no attempts left, a claim past `maxStalls`, or a `FatalJobError`), it gets a failure job if
the definition of its lane in the process that fails it has a `failureLane`. That definition decides, not the row: a job
enqueued under another definition gets the failure job of this one, or none. A job that fails after the unmount of its
handler uses the definition of that handler.

- The fail and the insert of the failure job commit together. If the database refuses the insert, the job still fails,
  but without its failure job. sqlane then logs an error and emits a `failure_job_not_added` event.
    - On PostgreSQL, the insert runs under a savepoint, because an error aborts the whole transaction.
    - On MySQL, an error rolls back only the failed statement. So sqlane deletes the job row of the insert, if it exists,
      by its enqueue token. sqlane uses no savepoint on MySQL, because some drivers, such as Prisma, prepare every
      statement, and MySQL cannot prepare `SAVEPOINT`.
    - A deadlock rolls back the whole transaction on both databases, so the write runs again.
- Payload (`FailedJobPayload`): `{ job: { id, lane, payload, attempt, maxAttempts }, error: { name, message, stack } }`.
  Exempt from `maxPayloadBytes`; `error.stack` is cut to 8 KiB.
- A `FatalJobError` fails the job at once, with the same failure job.
- The failure job is an ordinary job. Its options come from the definition of its lane, a definition object:
  `defineLane` and `runner.mount()` refuse a failure lane that has a `failureLane` of its own (`ConfigError`). It has
  no failure job of its own (no chains).
- A replayed fail (lost acknowledgment) or a lost lease adds no second failure job.

### Close

`close({ deadline, mode, exitsBy })` stops claiming and waits for the running handlers until the deadline. At the
deadline, sqlane aborts the `signal` of each handler that still runs. The `mode` option decides what happens to these
unfinished jobs.

| `mode`    | Effect                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `release` | The job goes back to `pending`, and no attempt is used. Its `run_at` is `exitsBy` + 2 s, and its keys linger until then. |
| `abandon` | sqlane writes nothing. The lease ends, and stall recovery counts one stall. This mode is for crashes.                    |

`deadline` and `exitsBy` are durations counted from the `close()` call. `exitsBy` is the latest time at which the
process exits, and its default is the deadline plus one lease. After this time, the old run has surely ended. Set
`exitsBy` lower if the app exits sooner.

`close()` never rejects because of its options, so a shutdown always releases the jobs. Each invalid option logs a
warning, and `close()` uses its default. This includes an unknown option, and an `exitsBy` that is earlier than the
deadline. A handler that throws
after the abort counts as unfinished, so its attempt is not used. `close()` resolves when the handlers have settled or
the deadline has passed, and the releases are written. It ends only what sqlane opened, such as the LISTEN connection
and the hint subscription. It never ends the app's pool.

### Drain

`drain({ timeout, includeDelayed })` claims and runs jobs until none is left, without `start()`:

- Only the lanes this instance added, and only the due jobs. Pending jobs of other lanes are not waited for, nor those
  of a paused lane (local or global): its probe skips them, so a drain ends.
- `includeDelayed: true` also runs the delayed jobs and the retries in backoff at once (each round makes the pending
  jobs of the mounted lanes due now, but those of the globally paused lanes): for tests like "fails 3 times, then the
  failure job runs".
- Returns counts: `completed`, `retried` (failed attempts that were retried), `failed` (jobs that failed for good).
  On timeout it rejects with `DrainTimeoutError`.
- It waits for the timers of the rate keys on which it blocked jobs, when they are due before the timeout, but not for
  the check after a key's last unblock.

### Schedules

`defineSchedule(lane, options)` defines a schedule next to its lane, and a runner fires it while it mounts it, before or
after `start()`. A schedule produces **slots**: the instants of a 5-field cron in an IANA time zone, or of a fixed
`every` interval counted from the Unix epoch. Its id is `<lane>:<key>`: the key is required, so the id of a schedule
never changes when a second schedule of its lane comes. A mount after `start()` fires its schedules at once; an unmount
stops them, and a fire in flight completes. `sqlane.schedules.runSlot()` enqueues a slot by hand, with the job id of the
slot, without a runner.

**The timer.** Each started process keeps one timer for the earliest slot of all its schedules. It sleeps at most 1
minute, which covers wall-clock jumps and the `setTimeout` limit. While no slot is due, a schedule costs no query,
whatever the number of schedules. With no schedules, `start()` runs no new statement and arms no timer.

**The fire.** At a slot, every process that has the schedule opens one short queue transaction for up to 100 due
slots:

1. It locks the schedule rows in id order with `SELECT … FOR UPDATE SKIP LOCKED` (`FORCE INDEX (PRIMARY)` on MySQL and
   MariaDB). The same statement reads the database clock.
2. It decides each slot in JS, with that database time: a slot wins if it is after the row's cursor (`last_slot_at`)
   and it is on time (the database time minus the slot is at most 1 minute), or it is a late catch-up. A slot more
   than 1 s ahead of the database time is deferred. A slot of a paused row (`paused_at`) is decided, not fired: no job,
   no event, and the cursor stays.
3. With `overlap: 'skip'`, it reads the status of the last job of each winner.
4. It inserts the jobs of all winners, of all lanes, in one statement on PostgreSQL, with one NOTIFY per lane. On
   MySQL and MariaDB, it uses the enqueue insert. On-time jobs get `runAt` = their due time (the slot, plus the
   jitter), late ones are due now (plus the jitter's offset).
5. It moves the cursors of the winners in one `UPDATE`.

A row that another process holds is skipped, never waited for: it is **busy**. About 1 s later, the process reads the
cursor with one plain `SELECT`. If the cursor moved, the slot is taken. If not, the holder rolled back or still holds
the row, and the process fires again, with a backoff of up to 60 s. A row that stays locked longer than 1 minute logs
a warning. A missing row (after `schedules.remove()`) is inserted again by an on-time slot only, not paused. The busy
fires of the later slots of the schedule do not put the pending recheck off: a schedule faster than the recheck would
never read its row again.

**Why at most one job per slot.** A slot is decided only while the transaction holds the row lock, and the lock pass
reads the latest committed row. The cursor and the jobs commit together, so a crash leaves neither. The cursor
outlives the job's retention, so the dedupe is permanent. The deterministic job id `<lane>:schedule:[<key>:]<ISO>` is
a second guard, and it makes a manual run with the `slot` enqueue option dedupe with the scheduler.

**The clock.** The decisions use the database time of the fire transaction, so the clock of a process changes only when
it tries, never what it writes. The process estimates its skew from the statements that it runs anyway: it keeps the
sample with the smallest round trip of the last 10 minutes, and only round trips up to 50 ms count. While none counts, a
slower sample stands in, once per 10 minutes. A step of the process clock (NTP), seen against a monotonic clock, drops
the older samples. A backward step moves the estimate by the step. A forward jump is a step or a suspend (the monotonic
clock stops in a sleep or a VM pause), so the estimate stays, and the next fire corrects it. It logs a warning above
5 s. The cursor of a new row is the plain database time, so slots before the first registration never run.

**Missed slots.** Each tick adds at most one job per schedule: the latest due slot. A stall never makes a burst. With
`missed: 'once'`, a late slot runs if the stored spec equals the spec of the process and the cursor is at most one
period plus 1 day older than the slot (the catch-up reach).

**DST.** A spec with all 24 hours counts elapsed time: it skips a skipped hour and fires at both passes of a repeated
hour. Any other spec is an appointment: a time in a gap fires once at the end of the gap, and a repeated time fires at
its first pass. The search works on wall-clock times from `Intl.DateTimeFormat`, and it is checked against a
brute-force oracle around every transition of 2026 in 10 zones.

**Jitter.** With `jitter`, the scheduler fires each slot at `slot + offset`, where the offset is clamped below the next
slot, so the jobs never wait as future pending rows and the slots stay in order. The offset is a hash of the schedule
id and the slot, so every process agrees. The slot stays the identity: the cursor, the job id and `scheduledAt`.

**Errors.** A transient error retries the chunk once. A connection error fails the whole chunk and the rest of the
tick, with one error log per outage. Any other error splits the chunk in halves, down to the bad schedule, so one bad
schedule does not block the others. A bad schedule logs one error until a slot of it succeeds. Failed slots back off
from 5 s to 60 s.

**Why no leader, and no chained pending job.** A leader adds a moving part, and the row lock already picks one
process per slot. A future pending job per schedule (as BullMQ does) would make every probe read one index entry per
scheduled lane, and it breaks when that job is deleted or a deploy changes the spec.

### Global pauses

`sqlane.lanes.pauseGlobally(lane)` writes a row of `<prefix>paused_lanes` (an upsert that keeps the first `paused_at`);
`resumeGlobally` deletes it. Every statement that chooses a lane skips the paused ones, with a filter
`NOT EXISTS (SELECT 1 FROM <prefix>paused_lanes WHERE lane = …)`:

- the probe; the search of candidates; the claim by ids; the claim of due jobs (on PostgreSQL its `request` CTE, which
  its next due times read too); the oldest blocked job of a key, which a newer job waits behind (in the search, in the
  claim, in `unblock` for the room of a concurrency key, in `unblockRates` for the settings of a rate key), and the
  blocked jobs that the unblocks make pending; `makeDue` of `drain({ includeDelayed })`.
- Not the sweep's scan of the keys with blocked jobs: it reads keys, not lanes, and the unblocks that it calls skip
  the paused lanes.

So a paused lane's jobs stay where they are: pending, blocked, or running to their end. Its blocked jobs take no room
of a shared key, and never hold the jobs of other lanes behind them as the head of a key.

**A subquery, never a join.** The filter reads the primary key of a table of a few rows, at most one row per check.
Where the lane is a parameter, the subquery is uncorrelated: the database runs it once per statement on PostgreSQL (the
claim of one lane), once per `UNION ALL` branch on MySQL and MariaDB (one branch per lane). Where several lanes' rows
are read (the heads of the keys, the claim by ids), it is correlated on the row's lane. A join would change the plans
of the hot statements, and could lock the rows of the pauses in a locking read.

**MySQL and MariaDB: the paused lanes of the probe.** Each subquery in a statement costs its planning, at each call
(MySQL plans each statement, also when the subquery never runs). So the reads of the blocked jobs (the heads of the
keys in the search and the claim, the reads of `unblock` and `unblockRates`) and the search of candidates take the
paused lanes that the last probe of the process read: none (the usual case) adds nothing to the statement; some add
`lane NOT IN (…)`, and the search leaves their lanes out. A pause after the probe holds from the next one: a blocked
job of its lane can head a key for one turn, or take the room of one unblock on a shared key, until the next release or
sweep of the key. The list stands for one poll interval; after it (a closed runner, an idle one between two drains), and
after a resume in this process, until the next probe, the reads keep the subquery, as a process that has not probed
(without a runner) does. Above 50 paused lanes, the subquery too: no list of 50 parameters in each branch of a
`UNION ALL`. The claims keep the subquery in any case: a lane whose claims stay full is claimed again without a
probe.

**MySQL and MariaDB keep the loose index scan of the probe.** A filter on the lane in its `GROUP BY` scan would end the
loose index scan (`Using index for group-by`). The probe instead returns the paused lanes in the same statement
(`… UNION ALL SELECT lane, NULL FROM <prefix>paused_lanes`), and drops them in JS. The claim of due jobs reads its next
due times with the same probe. A `HAVING NOT EXISTS (…)` on the groups keeps the loose index scan too, and costs
less in an idle probe, but it does not tell the paused lanes to the reads below.

**No new index.** Without paused lanes, each filter is one probe of an empty primary key. A paused lane with many due
jobs costs nothing: the probe and the claims skip it before they read its jobs. The cost is in the heads of the keys:
an index scan on `(blocked_on, run_at, id)` (`jobs_blocked`) walks past the blocked jobs of the paused lanes that come
before the first one of another lane, one check of `paused_lanes` each. An index with the lane would not help: the
head is by key and time across lanes. A paused lane with many blocked jobs on a key that other lanes share is the case
of `paused_lane_blocked` in `bench:statements`.

**The resume.** Of a lane that was paused only. It reads the keys of the blocked jobs of the lane (a scan of the
blocked jobs: a resume is rare). The concurrency keys are unblocked as far as they have room; the rate keys
get the timer of the runner of this process when it is started or draining (an unblock now, then the next ones while
blocked jobs are left), else one unblock, the rest left to the sweep. Then the runner of this process wakes, and the
hint goes to the others, whether this process can start the lane or not. With a connection, all this runs after its
commit, when the adapter can tell. Else (a raw client in a transaction) it runs at once, as an enqueue does: the runner
of this process re-probes until it sees the lane, the hint makes the others re-probe, and the unblocks run again 1 s
and 5 s later, after the commit can have happened.

**Schedules.** `sqlane.schedules.pauseGlobally()` sets `paused_at` of the row; with no row, it inserts one, paused, with
its cursor at now and the spec of the definition (a placeholder, `unknown`, from an id: no timing reads it, so
`schedules.list()` shows no next slot, and the first fire writes the spec). The fire decides the slots of a paused row
without firing them; the scheduler of each process moves on to the next slot, as for a lost one. The resume clears
`paused_at` and moves the cursor to now (`GREATEST`, so a cursor ahead stays): the slots of the pause are lost, never
caught up. A resume of a row that is not paused changes nothing, so it cannot drop a due slot. `runSlot()` ignores the
pause.

### Bulk operations

`jobs.retry`, `jobs.cancel` and `jobs.remove` (`src/jobs_bulk.js`, SQL in `src/store/job_writes.js`) run in one
transaction: sqlane's own on the queue's pool (READ COMMITTED), sqlane's own on a pool given as `connection` (the
adapter's `poolTransaction`), or the caller's.

1. **Read** the candidates, without a lock: the ids with their status and whether their payload exists, or the jobs of
   the filter. The ignored ids are decided here, and `strict` rejects before any lock.
2. **Lock** the rest by primary key, in id order (byte order: `ascii_bin`, `COLLATE "C"`), with the status checked
   again in the condition: in READ COMMITTED, a row changed meanwhile is evaluated again, and a row in another status is
   not locked. MySQL and MariaDB force the primary key, so the locks follow the id order. An id read but not locked
   changed meanwhile: it is ignored with its new status.
3. **Write**, guarded by the status in the condition: outside a transaction, where the locks of step 2 ended with their
   statement, a job claimed in between is not changed. A remove on MySQL and MariaDB deletes only the payloads whose job
   is gone. PostgreSQL returns the changed ids; MySQL and MariaDB count the changed rows.
4. **After the commit** of a transaction that sqlane owns: the `cancelled` events, the wakes and hints of the retried
   lanes, and the unblock of the concurrency keys of the cancelled or removed pending jobs. In the caller's transaction:
   no event, and the rest at the adapter's after-commit hook, else at once.

A retry is due at `GREATEST(now, MAX(held_until))` of the job's slots, so it does not start beside a handler that may
still run. No operation touches the slots. Every statement that can run on a caller's connection returns one-word
column names, which a transform of postgres.js does not rename; id lists are an array parameter on PostgreSQL and
chunks of 500 on MySQL and MariaDB. `batches` walks the jobs of the filter in the order of `jobs.list` over the index of
`0008_job_list`, a transaction per batch of 1000, so each job is read at most once.

### Cleanup

Cleanup is built in, so you need no external cron job. Every 5 minutes, each process deletes the completed and failed
jobs whose retention has ended. It deletes them in batches of 1000 with SKIP LOCKED, so the processes share the work.
`cleanup: false` turns it off.

### Connections

- `enqueue` uses the caller's connection or transaction.
- All other queue work uses the adapter's pool, which should be small. The queue's transactions on this pool use
  `READ COMMITTED`. `schema.migrate()` also runs on a connection of this pool.
- Handlers use whatever connections they open. The `localMaxConcurrency` of the runner limits the running handlers of a process, so they
  cannot exhaust the app's pool.

### MariaDB

MariaDB speaks the MySQL protocol, so the app tells the adapter (`{ dialect: 'mariadb' }`, see
[Adapters](adapters.md#the-dialect-and-the-server-check)), and the first `start()` or `schema.migrate()` checks it
against `VERSION()`. MariaDB has SQL files of its own: `store/mariadb_*.js` and `schema/mariadb.js` are copies of the
MySQL files, changed where MariaDB differs. A change of the MySQL SQL must be made in the copies too.

- **Upserts.** MariaDB has no row alias (`INSERT … AS new`), so the upserts read the new values with `VALUES(column)`.
- **Locks of a claim.** MariaDB has no `FOR UPDATE OF`. A claim and the final writes read the payload with a subquery,
  not a join, so `FOR UPDATE` locks the job row only, as on MySQL. The payload that the claim statement did not see is
  read again, as on MySQL.
- **Snapshot isolation of the claim.** `innodb_snapshot_isolation` (10.11.8, 11.0.6, 11.1.5, 11.2.4, 11.4.2 and later,
  [InnoDB system variables](https://mariadb.com/docs/server/server-usage/storage-engines/innodb/innodb-system-variables#innodb_snapshot_isolation);
  ON by default from 11.6.2) fails a locking read of a row that the statement's read view does not see with
  `ER_CHECKREAD` (errno 1020). The payload subquery of the claim opens that view, so a job whose enqueue commits
  during the claim statement failed the whole claim: 37–50 % of the claims under heavy enqueues on 11.8. The claim
  statement starts with `/*M!101108 SET STATEMENT innodb_snapshot_isolation = OFF FOR */`: the job is locked, its
  payload not seen and read again, as on 10.11 and MySQL. Older versions skip the versioned comment; a version from
  the gap (11.0.0–11.0.5, 11.1.0–11.1.4, 11.2.0–11.2.3, 11.3, 11.4.0–11.4.1) answers `ER_UNKNOWN_SYSTEM_VARIABLE`
  (1193), and the store claims again without the prefix, from then on (a debug log). Only the claim statement needs
  it: the other locking reads either have no consistent read in the same statement (`renewLeases`,
  `deleteExpiredJobs`, the claim of jobs with global limits, `unblock`), or lock their one row, by primary key, before the payload
  subquery opens the view (`lockJob` of `failJob`; the stall recovery reads no payload). Each statement of the READ COMMITTED queue
  transaction has a read view of its own, so no view from an earlier statement is open.
- **Writes by a list of ids.** On a small table, MariaDB scans the whole table for `WHERE id IN (…)` and waits for
  the rows that other claims hold: concurrent claims then deadlock. These writes force the primary key (or the index
  of the column) with `FORCE INDEX`. A `DELETE` takes index hints only in its multi-table form, so it uses that form.
- **Collation.** MariaDB 10.11 has no `utf8mb4_0900_bin`, so the tables use `utf8mb4_bin`.

## Guarantees

The table lists each guarantee and the mechanism that keeps it.

| Guarantee                                                                                                                                                                                                                          | Mechanism                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A job exists only if the caller's transaction commits.                                                                                                                                                                             | The INSERT runs in the caller's transaction, so a connection must be in one.                                                                                                                                             |
| A job does not start before its data is visible.                                                                                                                                                                                   | Other connections see only committed rows.                                                                                                                                                                               |
| A committed job runs at least once.                                                                                                                                                                                                | Leases, stall recovery, and the release on close.                                                                                                                                                                        |
| Only the current owner saves the result of a job.                                                                                                                                                                                  | The claim uses SKIP LOCKED, and every write checks the `lock_token`.                                                                                                                                                     |
| A job with a `dedupeKey` is added once while its row exists.                                                                                                                                                                       | The primary key is `<lane>:<dedupeKey>`.                                                                                                                                                                                 |
| At most `max` jobs with a common key of a global limit run at the same time, unless a handler ignores its `signal` past the lease or `exitsBy`, or two claims race during a change of the max.                                     | The primary key `(key, slot)` of `sqlane_concurrency_slots`, the claim, and the linger of slots.                                                                                                                         |
| A job blocked on a key is due again once the key has room.                                                                                                                                                                         | The unblock after each release and after each claim that blocks, and the sweep of the stall recovery.                                                                                                                    |
| Any window of length `per` sees at most `max + burst − 1` starts of a key of a global rate limit, counted by cost, while its jobs carry one setting of the key.                                                                    | The row of the key in `sqlane_rate_limits`, locked by the claim, whose `tat` moves in the transaction of the claim.                                                                                                      |
| A job blocked on a rate key is due again once the key allows its start.                                                                                                                                                            | The timer of the process that blocked it, and the sweep of the stall recovery (up to about 30 s later if that process stopped).                                                                                          |
| A job that fails for good adds its failure job, if the database accepts it.                                                                                                                                                        | The INSERT of the failure job runs in the transaction of the fail.                                                                                                                                                       |
| In one runner with one slot and no other process on the lane's rows, between two starts of a fair group of a lane, every other group of the lane that was due gets one turn (a start, or a claim that fails or puts back its job). | The claim locks the oldest due jobs of the groups that `fair_groups.js` ranks (fewest running here, then the rotation from the last tie winner), and ranks them as `fill()` over the groups; a property test replays it. |
| A lost hint does not lose a job.                                                                                                                                                                                                   | Hints only wake processes, and the database keeps the jobs.                                                                                                                                                              |
| Each slot of a schedule adds at most one job, ever.                                                                                                                                                                                | The cursor in `sqlane_schedules`, locked and moved in the transaction of the enqueue.                                                                                                                                    |
| A slot adds a job if a started process with the schedule is up within 1 minute after it, or, with `missed: 'once'`, at the next start within the catch-up reach (the latest missed slot only).                                     | The timer of each process, the lock pass and the cursor. If a fire rolls back and a later slot of the schedule is decided first, the earlier slot is skipped.                                                            |

## Observability

- **Logs.** sqlane writes internal diagnostics, such as probe errors and reconnects, to an injected pino-compatible
  logger. Without a logger, it writes no logs.
- **Events.** `onEvent(event)` receives the events of the job lifecycle. The event is a typed union, and its `type` is
  one of `claimed`, `completed`, `retried`, `failed`, `rate_limited`, `timed_out`, `stalled`, `released`,
  `lease_lost`, `failure_job_not_added`, `schedule_fired` and `error`. The app maps the events to its metrics.
  `schedule_fired` comes once per decided slot in the cluster, from the process that decided it. `rate_limited` comes
  each time a handler's `RateLimitedError` makes its job wait. New event types may come in minor versions.
- **Schedules.** `schedules.list()` gives the next slot, the last slot and the last job of each schedule, from the
  table and from this process.
- **Gauges.** For each lane, `lanes.stats()` returns the number of pending, blocked, due, running, stuck, failed
  and completed jobs, and the age of the oldest due job. A stuck job is a `running` job with a `timed_out_at` time: it
  timed out, and its handler has not settled yet. A blocked job, on a full key or on a rate key, counts in `blocked`,
  not in `pending`; a job held back by a local rate limit stays pending. The failed and completed jobs count until
  cleanup deletes them. The count reads every row kept. These numbers support alerts such as "the queue is stuck".
  OpenTelemetry support may come later, as a separate package.
- **The start delay.** `JobInfo` and the `claimed` event carry the due time (`runAt`, the job's place in line) and the
  start time (`startedAt`) of a run, both from the database clock: the start delay is `startedAt − runAt`.
- **Keys.** `sqlane.jobs.keyStats()` lists the keys of the global limits with blocked jobs, or held or lingering slots,
  worst first, in one statement on the queue's pool. The blocked keys come from a loose scan of the index of the
  blocked jobs: one index entry per key (a recursive CTE on PostgreSQL; `GROUP BY status, blocked_on` with `MIN(run_at)`
  on MySQL and MariaDB). The slots are aggregated per key. The details of the keys of the page are scalar subqueries:
  the count of blocked jobs (stopped at 1000 by a probe with `OFFSET 1000`), the keys, maxes and rate settings of the
  head job, the job of the newest slot, and the debt of a rate key. The max of a key and the next start of a rate key are
  computed in JS from the head's stored settings, as the unblock computes them. No index of its own.

## Supported versions

| Component        | Minimum                     | Why                                                                                                                              |
| ---------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Node.js          | 22.12                       | Node 22, 24 and 26 in CI.                                                                                                        |
| MySQL            | 8.4 LTS                     | 8.0 reached end of life (April 2026). SKIP LOCKED, window functions, CTEs.                                                       |
| MariaDB          | 10.11 LTS                   | 10.6 reached end of life (July 2026). SKIP LOCKED, `JSON_TABLE`. 10.11 and 11.8 in CI.                                           |
| PostgreSQL       | 15                          | 14 reached end of life (November 2026).                                                                                          |
| Drivers and ORMs | See [Adapters](adapters.md) | `mysql2`, `mariadb` and `pg` are optional peer dependencies. They are drivers, not ORMs, and their major versions change rarely. |

The first `start()` or `schema.migrate()` checks the server's version, and on MySQL and MariaDB its `sql_mode`. An older
server is a `ConfigError`, unless the adapter gets `allowUnsupportedDbVersion: true`
([the server check](adapters.md#the-dialect-and-the-server-check)).

## Package layout

```text
@sqlane/core                      core: definitions, runner, dispatcher, SQL of each dialect, migrations
@sqlane/core/adapter-mysql2       mysql2Adapter
@sqlane/core/adapter-pg           pgAdapter (with the NOTIFY hint)
@sqlane/core/adapter-postgres-js  postgresJsAdapter (with the NOTIFY hint)
@sqlane/core/adapter-knex         knexAdapter
@sqlane/core/adapter-kysely       kyselyAdapter
@sqlane/core/adapter-drizzle      drizzleAdapter (with the NOTIFY hint on PostgreSQL)
@sqlane/core/adapter-prisma       prismaAdapter
@sqlane/core/adapter-sequelize    sequelizeAdapter
@sqlane/core/adapter-typeorm      typeOrmAdapter
@sqlane/core/adapter-mikro-orm    mikroOrmAdapter
```

One repository, one package at its root: `@sqlane/core`, with the adapters as subpaths. Helper packages, if any, get a
repository of their own. `test/` holds the integration tests and the test databases (see
[CONTRIBUTING.md](../CONTRIBUTING.md)).

The source files in `src/` have snake_case names. These are the main ones:

- `create_sqlane.js` is the facade of `@sqlane/core`: the database side (enqueue, jobs, schedules, schemas, the hint,
  the events) and a slot for the runner. `sqlane_internals.js` keeps its internals, for its runner only.
- `create_runner.js` is the facade of the runner of a process, over a sqlane. `mounts.js` checks and adds the mounts.
  `create_sqlane.js` imports none of the runner side: only `create_runner.js` does.
- `define_lane.js`, `define_handler.js` and `define_schedule.js` define the lanes, the handlers and the schedules.
- `registry.js` keeps the handled lanes: their handlers, weights and local limits, and the running counts by lane.
- `fair_share.js` shares the free slots between the lanes: `fill()`, `rankNames()`, `chooseRows()`, and `replayTie()` for the choices made in SQL.
- `define_concurrency_limit.js` defines the concurrency limits; `concurrency_keys.js` checks the global limits of a
  job at enqueue.
- `define_rate_limit.js` defines the rate limits; `rate_keys.js` checks the global rate limits of a job at enqueue;
  `gcra.js` holds the arithmetic of GCRA, `local_rates.js` the local rate limits, and `rate_wakes.js` the timer of the
  rate keys.
- `runner.js` implements the `start()`, `close()` and `drain()` of a runner, and connects these parts. `dispatcher.js` runs the
  dispatcher loop: the wakes, the probes and the claims. `job_runs.js` runs a claimed job and writes its result, and
  `failure_lanes.js` adds its failure job. `leases.js` renews the leases. `key_unblocks.js` unblocks the jobs blocked on
  keys, with the timer of the rate keys. `local_limits.js` holds the rooms of the local limits, and the wake timer of
  the local rate limits. `reprobes.js` re-probes after an enqueue. `maintenance.js` recovers stalled jobs, sweeps the
  slots and runs the cleanup.
- `enqueue.js` implements `enqueue` and `enqueueMany`.
- `hint_channel.js` sends and receives the hints.
- `migrations.js` implements `schema.migrate()`, `schema.rollback()` and `schema.drop()`; `schema_status.js` implements
  `schema.getMigrationStatus()` and `schema.findSchemaProblems()`; `version.js` reads the installed version and
  compares versions.
- `server_check.js` checks the server at the first `start()` or `schema.migrate()`: the database of `dialect`, its
  version, and the `sql_mode` of MySQL and MariaDB. `create_runner.js` checks the migrations at `start()` and
  `drain()`.
- `cron.js` parses cron expressions and finds their slots, `time_zone.js` reads wall-clock times from `Intl`,
  `schedule.js` checks the options of a schedule and computes its slots, and `scheduler.js` runs the timer and the
  fires of the schedules. `schedule_list.js` implements `schedules.list()`, `run_slot.js` `schedules.runSlot()`.
- `global_pauses.js` implements the global pauses of `sqlane.lanes` and `sqlane.schedules`, `schedules.remove()` and
  `lanes.stats()`; `store/pauses.js` holds their SQL, and the filter of the claims.
- `errors.js` defines the error classes.
- `store/` holds the SQL of each dialect behind one store interface.
- `schema/` holds the schema of each dialect, as tagged migrations, and `expected.js`, what they create.
- `adapters/` holds one adapter per driver or ORM.

Small helper modules, such as `backoff.js`, `duration.js` and `payload.js`, complete the list.

## Testing

- **Unit tests** sit next to the code, in `src/**/*.test.js`. They cover the modules that need no database, such as
  backoff, durations, payloads, global limits, GCRA, defaults, option checks and the error classes. They also check the
  adapters and the runner with small stub objects instead of a database.
- **Type tests** in `test/types/` and the examples in `examples/` are type-checked in CI, so the public API cannot
  change by accident. The smoke test in `test/package_smoke` runs in CI against the packed package.
- **Integration tests** in `test/integration/` give most of the value. The same suite runs against MySQL 8.4,
  MariaDB 10.11 and 11.8, and PostgreSQL 15 and 18 in Docker. It covers enqueue, claims, final writes, the runner, migrations, hints, stats,
  schedules and each adapter.
- **DST oracle tests** check the cron search against a brute-force oracle, minute by minute, around every DST
  transition of 2026 in 10 zones, from random starts and along chains of slots. They also bound the work of each
  search.
- **Benchmarks** ([benchmarks](contributing/benchmarks.md)): CI checks the statements of the hot paths on each
  supported version (`pnpm bench:statements`). `pnpm bench:regression` compares the CPU cost of a change with `main`.
