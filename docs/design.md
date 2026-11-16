# sqlane design

> Status: implemented, as published on npm. The API and the schema follow semantic versioning since 1.0. sqlane has no
> known production use yet. The [changelog](../CHANGELOG.md) lists what each version added.

sqlane runs background jobs that are rows in the application's own SQL database (MySQL, MariaDB or PostgreSQL). The
application adds a job in its business transaction, so the job exists only if the transaction commits. In this document,
MySQL also stands for MariaDB, except in [MariaDB](#mariadb), which lists the differences.

## Goals

1. **Transactional enqueue.** sqlane inserts a job with the connection of the caller's transaction. The job exists only
   if that transaction commits, and it never starts before its data is visible.
2. **Cheap idle job names.** 1000 job names, most of them idle, cost about the same as 10. The database load of a
   process does not grow with the number of registered job names. It grows only with the names that have pending jobs.
3. **Low latency.** In the same process, a job starts right after the commit when the adapter sees the commit, and
   about 25 ms after it otherwise. In another process, a job starts within a few milliseconds with PostgreSQL NOTIFY,
   and about 25 ms after the commit with a hint. Without either, it starts within the poll interval, which is 5 s by
   default. See [Wake-up after the commit](#wake-up-after-the-commit).
4. **At-least-once execution.** A committed job runs at least once, also after a crash, a stall or a deploy.
5. **MySQL, MariaDB and PostgreSQL.** All three databases get the same features and the same API.
6. **Concurrency limits.** At most `max` jobs of a key of a global limit run at the same time in the cluster, and a
   flood on one key does not hold back the others. [Guarantees](#guarantees) gives the exact condition.
7. **Rate limits.** A key of a global rate limit starts at most `max` jobs per `per` in the cluster, spread evenly, and
   a job over the limit waits without using an attempt.
8. **Failure jobs.** When a job fails for good, sqlane adds a job of another name, in the same transaction that marks the job as failed.
9. **Library hygiene.** sqlane has no global state, does not read `process.env`, writes nothing to the console and never
   exits the process. The app injects the connections, the logger and the metrics.

## Non-goals

- Exactly-once execution. Handlers must be idempotent.
- A dashboard. `getStats()` gives the counts per job name, and the tables are plain SQL (see [Data](#data)).
- Priorities, or a strict order across processes.
- Workflows, batches, job dependencies.
- SQLite, other databases.
- An ORM. Adapters wrap the transaction objects of the drivers and ORMs.

## Terms

| Term                  | Meaning                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Job**               | One row: a payload, a state, attempts, a lease.                                                              |
| **Job name**          | The kind of a job, e.g. `build_report`. It is also the "queue": there is no separate queue.                  |
| **Job definition**    | The name and the options of a job name. Producers and workers import it.                                     |
| **Handler**           | The function that runs a job. Only workers register it.                                                      |
| **Concurrency limit** | The most jobs that run at once: local (per process, in memory) or global (per key, in the cluster).          |
| **Rate limit**        | The most job starts per period: local (per process, in memory) or global (per key, in the cluster).          |
| **Fair share weight** | A name's share of the free slots against the other due names.                                                |
| **Key**               | A string (`order:42`): a global limit counts the running jobs of each key.                                   |
| **Rate key**          | A key of a global rate limit, `@<name>` or `@<name>:<value>`: it counts the starts of its jobs.              |
| **Slot of a key**     | One of the `max` places of a key. A running job holds one slot of each of its keys.                          |
| **Blocked job**       | A due job with a full key, or a rate key without quota: out of the due jobs until the key has room or quota. |
| **Failure job**       | A job that sqlane adds when another job fails for good.                                                      |
| **Adapter**           | Wraps a driver: the dialect, the queue's pool, and the raw connections given to `enqueue`.                   |
| **Hint**              | A message "jobs of this name are ready" between processes. Only an optimization.                             |
| **Schedule**          | A cron in a time zone, or a fixed interval, that adds a job at each of its times.                            |
| **Slot**              | One time of a schedule. It adds at most one job.                                                             |

## API

The [API reference](api.md) describes every function, option, default, error and event. This section keeps only the
reasons behind the shape of the API.

- **Definition apart from the handler.** Producers import a small job definition, not the handler and its
  dependencies. So `enqueue` and `handle` take a definition or a name.
- **Payload types, no validation.** A definition can declare its payload type, so the compiler checks `enqueue`, the
  handler, `globalConcurrencyLimits` and `globalRateLimits`. sqlane does not validate payloads at runtime, because the app knows its own rules. A
  payload is plain JSON without revivers. sqlane refuses a NUL character on both databases, because PostgreSQL `jsonb`
  refuses it.
- **Enqueue by name.** A producer without the definition, such as another service or a script, can enqueue by name.
  The job then gets the options of the known definition, or the defaults.
- **One adapter, raw connections.** The adapter gives the dialect and the queue's pool. `enqueue` takes the driver's
  own connection, so the job joins the app's transaction. A connection must be in a transaction, because MySQL cannot
  detect one safely.
- **Adapters are subpaths of the core**, not packages. None needs a dependency of its own, because each one uses the
  ORM instance that it gets. The core does not list the ORMs as peer dependencies. npm checks the range of an optional
  peer that the app has, so a new major version of any ORM would break the install of the core for all its users.
  Instead, an adapter checks the ORM it gets and throws a `ConfigError` with the supported versions. CI tests each
  supported major version. An ORM adapter runs sqlane's SQL on the driver connection under the ORM, or through its
  raw-SQL API, so there is one SQL per dialect. [Adapters](adapters.md) describes each one.
- **All the options of a name in its definition.** `handle()` takes none: the local limits, the weight and the timeout
  are definition fields too, read by the worker, so one module describes a job name. A machine that needs other caps
  computes them in that module, from its own environment.
- **Limits are objects.** `defineConcurrencyLimit()` and `defineRateLimit()` return a frozen object, which a
  definition lists or keys. A typo in a string cannot create a new limit, and the max is declared once, so two names
  cannot disagree on it.
- **Maxes frozen with the keys.** A worker cannot see the limit behind the key of a row: the definition's function
  runs at enqueue. So the row stores each key with its max, and each rate key with its settings, as it stores
  `maxAttempts`. Jobs enqueued by name work, and a deploy that changes a max applies to the new jobs.
- **A 429 is not a failure.** A handler that the other side refuses throws a `RateLimitedError`: the key pauses for
  every job, and the job waits without using an attempt. A retry would use attempts for an error that is not the
  job's, and the other jobs of the key would each get their own 429.
- **Handlers own their transactions.** sqlane does not wrap a handler in a transaction or any other app wrapper. It
  stores no result.
- **AbortSignal** for timeouts and close, instead of a hidden race. The lease is renewed while the handler runs, so a
  long job needs no timeout. A job with global limits needs one (see [Global limits](#global-limits)).
- **No implicit work.** `createSqlane` connects, migrates and starts nothing.

## Data

Each table prefix (default `sqlane_`) has six tables: the five tables below and `sqlane_migrations`. The names of
the tables and columns use snake_case. All times come from the database clock (`UTC_TIMESTAMP(3)` on MySQL,
`clock_timestamp()` on PostgreSQL), so clock skew between processes does not matter. Schedules compute their slots in
the process, but they decide each slot with the database clock ([Schedules](#schedules)).

In the tables below, `ts(3)` means `DATETIME(3)` with UTC values on MySQL, and `timestamptz(3)` on PostgreSQL. The
MySQL type does not depend on the session time zone, and it has no 2038 limit. sqlane sends a `runAt: Date` as a UTC
string on MySQL and as a `timestamptz` on PostgreSQL, never in the session time zone. It reads times back as epoch
milliseconds that SQL computes, and it computes every due time and wait time (`run_at - now`) in SQL. So sqlane does
not depend on the `timezone` or `dateStrings` settings of the pool.

### `sqlane_jobs`

| Column                                                                | Type              | Notes                                                                                                               |
| --------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                  | varchar(255), PK  | `<job_name>:<job_id>`, or a new ULID without `jobId`. `<job_name>:schedule:[<key>:]<ISO>` for a slot of a schedule. |
| `job_name`                                                            | varchar(128)      |                                                                                                                     |
| `status`                                                              | varchar(16)       | `pending`, `blocked`, `running`, `completed`, `failed`.                                                             |
| `run_at`                                                              | ts(3)             | Due time.                                                                                                           |
| `attempts`, `max_attempts`                                            | int               |                                                                                                                     |
| `stalls`, `max_stalls`                                                | int               |                                                                                                                     |
| `limit_keys`, `limit_maxes`                                           | json / array null | The keys of the global limits and their maxes, frozen at enqueue, sorted by key. Written with the job row.          |
| `rate_limits`                                                         | json null         | The rate keys with their settings, `[{ key, max, per_us, burst, cost }]`, frozen at enqueue, sorted by key.         |
| `blocked_on`                                                          | varchar(255) null | The full key, or the rate key, of a `blocked` job.                                                                  |
| `enqueue_token`                                                       | char(26)          | Per enqueue call: tells created rows from duplicates.                                                               |
| `lock_token`                                                          | char(26) null     | Set by the claim. Every final write checks it.                                                                      |
| `locked_by`                                                           | varchar(255) null | `<host>:<pid>:<ULID>`.                                                                                              |
| `locked_until`                                                        | ts(3) null        | The lease.                                                                                                          |
| `timed_out_at`                                                        | ts(3) null        | Set on a timeout, cleared by the claim and by every transition out of `running`. For `stuck`.                       |
| `last_error`                                                          | json null         |                                                                                                                     |
| `completed_retention_ms`, `failed_retention_ms`                       | bigint            | Frozen at enqueue.                                                                                                  |
| `failure_job`                                                         | varchar(128) null | Frozen at enqueue.                                                                                                  |
| `created_at`, `started_at`, `finished_at`, `expires_at`, `updated_at` | ts(3)             |                                                                                                                     |

`id`, `job_name` and the keys are case-sensitive: `ascii_bin` on MySQL, `COLLATE "C"` on PostgreSQL.

Indexes:

- MySQL: `(status, job_name, run_at)`, `(status, blocked_on, run_at, id)`, `(expires_at)`.
- PostgreSQL: partial `(job_name, run_at, id) WHERE status = 'pending'`, partial `(locked_until) WHERE status =
  'running'`, partial `(blocked_on, run_at, id) WHERE status = 'blocked'`, `(expires_at)`.

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

### `sqlane_schedules`

| Column                     | Type              | Notes                                                                                         |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `id`                       | varchar(255), PK  | `<job_name>` or `<job_name>:<key>`. ASCII and case-sensitive.                                 |
| `job_name`                 | varchar(128)      |                                                                                               |
| `spec`                     | varchar(512)      | The normalized spec: `cron <fields> <timezone>` or `every <ms>`. A late catch-up compares it. |
| `last_slot_at`             | ts(3)             | The cursor: the last decided slot. It only moves forward. Slots at or before it never run.    |
| `last_job_id`              | varchar(255) null | The job of the last enqueued slot. `overlap: 'skip'` reads it.                                |
| `created_at`, `updated_at` | ts(3)             |                                                                                               |

One small row per schedule, and no secondary index: each access is by primary key, or reads the whole table
(`getSchedules`). An app without schedules never touches it. sqlane never deletes a row: services that share the table
each know only their own schedules.

### Migrations

sqlane ships its schema as versioned SQL for each dialect. You can apply it in two ways.

- `sqlane.migrate({ lockTimeout })` applies the missing versions and records them in `sqlane_migrations`. It resolves
  to `{ applied }`, the ids of the versions that it applied. It works under a database lock, so several processes can
  call it at once. It waits for the lock for up to `lockTimeout` (default `'10m'`). It runs on one connection of the
  queue's pool. On PostgreSQL, it sets `statement_timeout = 0` for its transaction, so a long migration of a big table
  is not cancelled.
    - On PostgreSQL, the whole migration is one transaction under `pg_advisory_xact_lock`, because PostgreSQL can run
      DDL in a transaction.
    - On MySQL, the lock is `GET_LOCK`. MySQL commits each DDL statement on its own, so an interrupted migration runs
      again from its start. For this reason, each statement is idempotent (`IF NOT EXISTS`).
    - Some ORMs, such as Prisma, have no connection outside a transaction. With them, `migrate()` runs in a transaction
      of the ORM (the adapter sets `transactionalConnection`), and the PostgreSQL migration does not begin or commit a
      transaction of its own. sqlane calls `pg_advisory_xact_lock` in a `FROM` clause, because the function returns
      `void`, and Prisma cannot read this type.
- `getMigrations({ dialect, tablePrefix })` returns the SQL, for the app's own migration tool.

The migration ids are matched, never counted. MySQL and MariaDB have `0001_initial`, `0002_job_keys`,
`0004_schedules`, `0005_concurrency_limits`, `0006_concurrency_slots` and `0007_rate_limits`. PostgreSQL has
`0001_initial`, `0002_pending_order`, `0003_job_keys`, `0004_schedules`, `0005_concurrency_limits`,
`0006_concurrency_slots` and `0007_rate_limits`. The migrations of 6.0 drop the tables of 5.x, `sqlane_job_keys` and
`sqlane_mutexes`. On MySQL and MariaDB, `0005_concurrency_limits` is one `ALTER TABLE`, which is atomic. The schedules
migration has the same id on every dialect. It is needed only with schedules: `start()` throws a `ConfigError` that
asks for `migrate()` when a process has schedules and the table is missing.

## Job states

```text
┌─ RateLimitedError on a rate key ────────────────────────────┐
▼                                                             │
blocked ◀─claim: a full key, no quota── pending ──claim──▶ running ──OK──▶ completed ──retention──▶ (deleted)
   └─ a slot frees, or its next start ────▶▲                  │
                                           └── retry, stall, ─┤
                                               release        └──no attempts / stalls left──▶ failed (+ failure job) ──▶ …
```

A `RateLimitedError` on local rate limits only sends the job back to `pending`, like a release.

## How it works

### Enqueue

In the caller's transaction, with its connection (with a pool: in a transaction of sqlane):

1. Check the payload (JSON, at most `maxPayloadBytes`, default 256 KiB) and the options (`jobId`, `delay` or `runAt`,
   `maxAttempts`, `maxStalls`, `retention`, `failureJob`, `globalConcurrencyLimits`, `globalRateLimits`).
2. The global limits: the enqueue option if given, else the definition's function of the payload; as keys, sorted,
   with their maxes. The same for the rate limits, as rate keys with their settings and costs.
3. `INSERT` the jobs, with their keys, in the order of their ids. This order prevents deadlocks between concurrent
   enqueues. Then `INSERT` the payloads of the rows that have this call's `enqueue_token`. With a `jobId`, an existing
   row means a duplicate. In this case, the enqueue returns `{ id, created: false }` and changes nothing, so it also
   skips the payload. Deduplication lasts while the row exists, in any state, so the retention is the deduplication
   window. After cleanup has deleted the row, the same `jobId` adds a new job. On PostgreSQL, all of this is one
   statement (a CTE), which is atomic even outside a transaction.
4. PostgreSQL with the NOTIFY hint: `pg_notify` in the same transaction, delivered on commit.

Frozen in the row at enqueue: `maxAttempts`, `maxStalls`, both retentions, `failureJob`, the keys and their maxes, the
rate keys and their settings. Any process can then retry, stall or fail the job without its definition. Read from the
worker's definition at run time: `backoff`, `timeout`, `fairShareWeight` and the local limits, of concurrency and of
rate.

`enqueueMany` inserts many jobs in one statement per table and returns `{ id, created }[]` in input order. `created`
comes from the call's `enqueue_token` (MySQL has no `RETURNING`): the payloads are inserted only for the rows with
this token, never for a duplicate committed by another transaction. A `jobId`
repeated in one batch: the first is created, the rest are `created: false`.

### Dispatcher: one loop per process

Each process runs one dispatcher loop. The loop finds the due jobs of the names that the process handles, claims as
many as the free slots allow, and starts their handlers. The pseudo-code below shows its steps.

```text
loop while started
  names = registered job names with a free slot (under each of its local limits and the instance's cap), and quota
    in each of their local rate limits
  if no names: wait for a wake
  probe: the next run_at of each job name that has pending jobs (one statement)
  if nothing due: wait until the next run_at (at most the poll interval) or a wake
  turn = the due names, the lowest running / weight first, at most 4 per free slot and 4 per free slot of each of
    their local limits; the others at the next turn
  names with global limits in the turn: their candidates (due jobs whose keys have room), and their due jobs with a
    full key, once per turn; a plan with fill() leaves them their share of the free slots, of the instance and of
    their local limits
  plain names: lock the oldest due jobs of each, up to min(the rooms of its local limits, the free slots), and take
    them by share (fill(): the lowest running / weight first, ties round-robin)
  names with global limits: claim their candidates whose keys have room, by share; block those with a full key
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

**The probe is the key to cheap idle names.** The probe is one statement, and it reads only the names that have
pending rows.

- On MySQL, the probe is
  `SELECT job_name, MIN(run_at) FROM sqlane_jobs WHERE status = 'pending' GROUP BY status, job_name`. With the index
  `(status, job_name, run_at)`, MySQL uses a loose index scan, which makes one index lookup per pending name. The
  `GROUP BY` names the whole index prefix, because `GROUP BY job_name` alone gets a full index scan.
- PostgreSQL has no loose index scan. Instead, a recursive CTE skips from one pending name to the next on the partial
  index. It makes two index lookups per pending name.

**Free slots are shared by weight.** A free slot goes to the eligible due name with the lowest
`running / fairShareWeight`, under its caps; ties go round-robin from a pointer that starts at a random name in each
process, so a fleet does not send every process to the same names. The chooser, `fill()` in `fair_share.js`, is a heap
with exact integer comparisons (`a.running × b.weight` against `b.running × a.weight`). Each event changes one count by
one: a free slot raises the lowest share by `1 / weight`, and a finished job lowers its own name's count. So after each
dispatch, for two names with due jobs and room, `running_a / w_a − running_b / w_b ≤ 1 / w_a`: the running counts stay
within one slot of the water-filling target at every moment, with no state but the counts and the pointer. The odd
remainder slot goes by ties, not by time, so it favors long jobs (see the API reference).

**Which names a claim requests.** A claim locks up to the free slots of each name that it requests, so a claim of all
1000 due names would lock thousands of rows to start a few jobs. A claim requests at most 4 names per free slot: the
names furthest under their share first (`rankNames()`), and at most 4 per free slot of each of their local limits: a
full limit takes no more names, so the names after it get their turn. The names that the rule serves are always a prefix of that
order, and the other names are a margin for names whose jobs other processes hold. A claim that fills the free slots does not read the
next due times of its names: they stay in the backlog, and the next turn claims them again.

**The names with global limits** find their candidates once per turn, before the plain claim. A plan over all the
names of the turn gives them their share of the free slots, on their candidate counts, and the plain claim leaves
those slots free: in the instance, and in their local limits (the plain claim gets the rooms of the limits minus the
reserved slots, and a `maxJobs` within them). If other processes take the candidates first, the reserved slots stay
free for one turn, which comes at once.

The process ignores the names that it does not handle. An idle name has no pending row, so it costs nothing. With 1000
names and pending jobs in 10 of them, the probe reads 10 index entries. A probe with one query per registered name (a
`UNION`) would grow with the number of all names.

These events wake the dispatcher:

- An enqueue in this process, or a hint from another process. See
  [Wake-up after the commit](#wake-up-after-the-commit).
- A finished job, which frees a slot. A job that finishes in a full local limit wakes every name of the limit, not only
  its own: the slot it frees can go to any of them. A job with global limits first unblocks the jobs of its keys, and
  wakes their names, here and in the other processes.
- The timer of a rate key on which this process blocked jobs, and the time at which a local rate limit allows a start
  again (see [Rate limits](#rate-limits)).
- The poll interval (5 s by default). It is the fallback, and it also finds jobs whose delay has ended.

### Wake-up after the commit

A raw driver has no after-commit event, so `enqueue` does not know when the job becomes visible. The business logic
does not need to call anything, because sqlane uses the following signals.

- **Re-probes, the default for any driver.** After an enqueue of a handled name, the dispatcher of this process probes
  again a few times. The steps are 20, 50, 100, 200 and 500 ms, 1 s and 2 s after the enqueue, and only the steps that
  are shorter than the poll interval count. A probe reads all the names, so a process has one series of re-probes. Each
  enqueue restarts the series from its own time, but a re-probe that is already due within the next 20 ms is kept. The
  series then goes on from the time of the new enqueue. So a burst of enqueues gives at most one re-probe per 20 ms. The hint transport sends the name to the other processes
  at enqueue time, and it does not wait for an answer. The other processes then re-probe in the same way. The latency
  is the commit time plus at most one step, and it is never more than the poll interval. A rolled-back transaction
  costs only the re-probes.
- **PostgreSQL NOTIFY.** `pg_notify` runs in the transaction, and PostgreSQL delivers it at the commit. The receivers
  probe at once, without re-probes.
- **After-commit hooks.** An adapter can have an `afterCommit(connection, fn)` function. The ORM adapters build it from
  the after-commit hook or promise of the ORM. An `enqueue` on a pool runs in a transaction of its own, which has
  committed when `enqueue` returns, so it works the same way. After the commit, the process wakes at once and sends the
  hint. Then it re-probes as above, counted from the commit.
- **`sqlane.wake()`.** This method stays public as a low-level escape hatch. The docs never require it.

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

A hint is a message between processes. It says that jobs of a name are ready. The app implements the generic
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
- With `hint: { publish, subscribe }`, the channel is `<tablePrefix>ready`, and the message is a job name. sqlane
  publishes the hint after an enqueue, and `enqueue` does not wait for `publish`. A failed publish never rejects
  `enqueue`. Instead, sqlane emits an `error` event. A process sends a hint only for the jobs that it cannot start
  itself. When a job frees slots of global limits, the message is the name of each job that it unblocked. A
  receiver re-probes
  for a short while, as after its own enqueue, because the hint can arrive before the commit.
- With `{ notify: true }` on the pg, postgres.js or Drizzle adapter (PostgreSQL), sqlane listens on a dedicated
  connection. With pg, and with Drizzle over node-postgres, this connection comes from the queue's pool. postgres.js
  opens its own connection with `sql.listen`. The enqueue sends `pg_notify` in its transaction, so the hint arrives
  only after the commit. Each enqueue that adds a job calls `pg_notify`. PostgreSQL drops the duplicate notifications
  of a transaction, so it delivers one notification per transaction and job name. NOTIFY takes a global lock at the
  commit, so under a heavy write load it can limit the commit rate of the whole database.
- Hints are throttled. A process sends at most one message per job name in each interval of 100 ms.

A lost hint delays a job until the next poll. It never loses a job.

### Claim

**Names without global limits** (in the definition of the claiming process): the due jobs are found, claimed and read
at once, without candidates. A locked row with global limits or rate limits (from its enqueue options) is not taken:
the claim returns its name, and the process claims that name with its limits from then on.

- PostgreSQL: one statement, a transaction of its own. A `LATERAL` per due name locks its oldest due jobs
  (`FOR UPDATE SKIP LOCKED`, at most `min(the rooms of its local limits, free)`). The k-th locked row of a name gets
  the share `(running + k − 1) / weight`, its share just before it takes the row. Ordering all rows by `(share, tie)`
  is the greedy of `fill()`, row by row. Without local limits, `LIMIT` keeps the instance's cap. With them, a
  recursive CTE walks the rows in that order and takes a row while the instance and each of its limits have room: a
  name can have several limits, so one `ROW_NUMBER` per limit would not do. The shares
  are `float8`: equal rationals give the same double, and different ones (weights ≤ 1000) differ far above its
  precision. An integration test checks the choice against `fill()` on random claims. The statement also
  returns `unpicked`, the names with a locked row that the claim did not take. The runner replays the choice with
  `replayTie()` (`fill()` over the claimed rows, plus one row of each unpicked name, under the counts and limit rooms
  that the claim was given) and moves the tie pointer as `fill()` would. The replay leaves out the names with no
  claimed row and a share above every claimed share: they never took a slot, nor tied. A property test checks the
  replay against `fill()` over all the locked rows.
  An `UPDATE … RETURNING` in a CTE claims the rows, joined with their payloads.
- MySQL: one short transaction. One `UNION ALL` locks the oldest due jobs of each name with their payloads
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

**Names with global limits** (concurrency or rate): the candidates, then one short transaction on the queue's pool. The
candidates are the oldest 500 due jobs of each name, split by the held slots and the quota of their keys: those whose
keys have room, at most twice the free slots of the name, and those with a full key or a rate key without quota.

1. `SELECT … WHERE id IN (candidates) AND status = 'pending' AND run_at <= now ORDER BY run_at, id FOR UPDATE SKIP
   LOCKED`.
2. Read the held slots of their keys. Block the jobs with a key whose held slots reach the max of the job:
   `status = 'blocked'`, `blocked_on` = that key.
3. Lock the rows of the rate keys of the others, in the order of the keys (a missing row is inserted first), and read
   their debts and their oldest blocked jobs. Block the jobs over the quota of a key, or behind an older job of the key
   ([Rate limits](#rate-limits)).
4. Choose among the others by share, FIFO within a name, counting the slots and the quota that the choice takes
   (`pick()`).
5. Take a slot of each key of the chosen jobs (below). Drop the jobs that did not get all their slots.
6. Move the `tat` of each rate key by the costs of the jobs that start.
7. `UPDATE` to `running` with a new `lock_token`, `locked_by`, `locked_until = now + lease` (4 minutes).
8. Read the payloads.

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
  job. A `running` job whose lease has ended gets one more stall. It goes back to `pending` with a delay of
  30 s × 2^stalls, which is at most 1 h. So the first stall delays the job by 30 s, and the second stall by 60 s. After
  `maxStalls` stalls (2 by default), the next stall fails the job.
- The keys of a stalled job linger for one more lease (4 minutes, in `held_until`) instead of being deleted, because
  the old handler may still run. So a job with global limits runs again only after this time.
- So after a crash, the leases of the process end within 4 minutes. Another process finds the jobs within about 30 s,
  and it runs them again 30 s later. A job with global limits waits one more lease (4 minutes).
- When a database write of a result fails, the process retries it for up to 10 minutes and renews the lease meanwhile.

### Global limits

A global limit counts the running jobs of each of its keys in the whole cluster: `order:42`, or the limit's name for a
limit without keys. A key of a limit of 1 is a mutex.

- **Format.** A job has at most 10 keys. A key has at most 255 printable ASCII characters. sqlane removes duplicate keys
  at enqueue, before it counts them. The keys are global strings, so jobs of different names can share them. Each key
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
  the due jobs, so the 500 candidates of a name are never all jobs of one full key, and a flood of one client does not
  hold back the others. Jobs of a key start in FIFO order among those that can start; a job with several keys waits
  only for its full keys, so under contention it can wait longer than a newer job with fewer keys.
- **Unblock.** After the end of a job with keys, and after a claim that blocked jobs, the process unblocks the keys: the
  oldest jobs blocked on each key, as many as its free slots by the max of its oldest blocked job, go back to
  `pending`, and their names are woken here and by a hint. The release and the claim each unblock after their own
  commit, so the later of the two sees both: a job is not left blocked on a key with room. An unblocked job that is
  still blocked by another key is blocked again on that key. The stall recovery sweeps the keys with blocked jobs about
  every 30 s, for a process that stopped before its unblock and for the slots whose linger ended.
- **Which jobs count.** A claim reads the keys of the rows, not the definition: a job of any name with keys from its
  enqueue options counts. A worker claims a name through the global limits when its definition has
  `globalConcurrencyLimits` or `globalRateLimits`, or once a plain claim met a row of the name with limits.
- **Fair share.** A name whose due jobs all have full keys has no candidates: it takes no slot and banks nothing.
- **Timeout.** JavaScript cannot stop a handler. On a timeout, sqlane aborts the `signal` with a `JobTimeoutError` and
  emits a `timed_out` event. The job stays `running`, and its lease is renewed. It keeps its slots and its slot of the
  process until the handler settles, but for at most one more lease. During this time, `getStats()` counts it as
  `stuck`. Then the attempt fails with the `JobTimeoutError`. The job is retried after its backoff, or it fails for
  good, and its slots are freed. This applies to all jobs, with or without keys.
- **Linger.** The slots outlive their job row only in two cases, as rows with a `held_until` time. The first case is a
  release on close while the handler still runs. The slots then stay until `exitsBy` plus 2 s (see [Close](#close)).
  The second case is a stall. The slots then stay for one lease, because the old handler may still run. So the old run
  and the new run do not overlap, unless a handler ignores its `signal` past the lease or past `exitsBy`.
- **A job with global limits needs a timeout.** The lease is renewed while a handler runs. Without a timeout, a hung
  handler would hold its slots in the whole cluster forever. So `handle()` throws a `ConfigError` if the definition has
  `globalConcurrencyLimits` and no timeout. A job can also get limits only from its enqueue options. If its handler has
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
  jobs does it, when their names are known to have rate keys; else a statement of its own. Then a read of the rows,
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
  oldest jobs of the key, as many as the quota allows now (at most 500), wakes their names here and by a hint, and arms
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
  start costs 1. A name over one of its local rate limits gets no slot, and its jobs stay pending; the process wakes it
  when the limit allows a start. A `RateLimitedError` on a local limit pauses it in this process, and the job is
  pending again at once: another process may take it.
- **Settings frozen with the keys.** The `rate_limits` of a job hold `max`, `per`, `burst` and the cost of each key.
  After a deploy that changes a limit, each job checks its own settings against the one `tat` of the key.
- **Retries count.** A retry, or a run after a stall, starts the job again, so it takes its quota again: the other side
  sees every call.

### Failure jobs

When a job fails for good (no attempts left, too many stalls, or a `FatalJobError`), and its row has a `failureJob`:

- The fail and the insert of the failure job commit together. If the database refuses the insert, the job still fails,
  but without its failure job. sqlane then logs an error and emits a `failure_job_not_added` event.
    - On PostgreSQL, the insert runs under a savepoint, because an error aborts the whole transaction.
    - On MySQL, an error rolls back only the failed statement. So sqlane deletes the job row of the insert, if it exists,
      by its enqueue token. sqlane uses no savepoint on MySQL, because some drivers, such as Prisma, prepare every
      statement, and MySQL cannot prepare `SAVEPOINT`.
    - A deadlock rolls back the whole transaction on both databases, so the write runs again.
- Payload (`FailedJobPayload`): `{ job: { id, name, payload, attempt, maxAttempts }, error: { name, message, stack } }`.
  Exempt from `maxPayloadBytes`; `error.stack` is cut to 8 KiB.
- A `FatalJobError` fails the job at once, with the same failure job.
- The failure job is an ordinary job. Its options come from its definition: `start()` and `drain()` check that it resolves (a
  definition object, or a name in `jobs` or handled) and has no `failureJob` of its own (`ConfigError`). A stall-fail
  in a process that does not know the definition uses the defaults. Its row always gets `failure_job = null` (no
  chains), and it is exempt from `unknownJobs: 'reject'`.
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

- Only the names this instance handles, and only the due jobs. Pending jobs of other names are not waited for.
- `includeDelayed: true` also runs the delayed jobs and the retries in backoff at once (each round makes the pending
  jobs of the handled names due now): for tests like "fails 3 times, then the failure job runs".
- Returns counts: `completed`, `retried` (failed attempts that were retried), `failed` (jobs that failed for good).
  On timeout it rejects with `DrainTimeoutError`.
- It waits for the timers of the rate keys on which it blocked jobs, when they are due before the timeout, but not for
  the check after a key's last unblock.

### Schedules

`schedule(job, options)` adds a schedule in code, before `start()`, like `handle()`. A schedule produces **slots**:
the instants of a 5-field cron in an IANA time zone, or of a fixed `every` interval counted from the Unix epoch.

**The timer.** Each started process keeps one timer for the earliest slot of all its schedules. It sleeps at most 1
minute, which covers wall-clock jumps and the `setTimeout` limit. While no slot is due, a schedule costs no query,
whatever the number of schedules. With no schedules, `start()` runs no new statement and arms no timer.

**The fire.** At a slot, every process that has the schedule opens one short queue transaction for up to 100 due
slots:

1. It locks the schedule rows in id order with `SELECT … FOR UPDATE SKIP LOCKED` (`FORCE INDEX (PRIMARY)` on MySQL and
   MariaDB). The same statement reads the database clock.
2. It decides each slot in JS, with that database time: a slot wins if it is after the row's cursor (`last_slot_at`)
   and it is on time (the database time minus the slot is at most 1 minute), or it is a late catch-up. A slot more
   than 1 s ahead of the database time is deferred.
3. With `overlap: 'skip'`, it reads the status of the last job of each winner.
4. It inserts the jobs of all winners, of all names, in one statement on PostgreSQL, with one NOTIFY per name. On
   MySQL and MariaDB, it uses the enqueue insert. On-time jobs get `runAt` = their due time (the slot, plus the
   jitter), late ones are due now (plus the jitter's offset).
5. It moves the cursors of the winners in one `UPDATE`.

A row that another process holds is skipped, never waited for: it is **busy**. About 1 s later, the process reads the
cursor with one plain `SELECT`. If the cursor moved, the slot is taken. If not, the holder rolled back or still holds
the row, and the process fires again, with a backoff of up to 60 s. A row that stays locked longer than 1 minute logs
a warning. A missing row (after a manual `DELETE`) is inserted again by an on-time slot only.

**Why at most one job per slot.** A slot is decided only while the transaction holds the row lock, and the lock pass
reads the latest committed row. The cursor and the jobs commit together, so a crash leaves neither. The cursor
outlives the job's retention, so the dedupe is permanent. The deterministic job id `<name>:schedule:[<key>:]<ISO>` is
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
scheduled name, and it breaks when that job is deleted or a deploy changes the spec.

### Cleanup

Cleanup is built in, so you need no external cron job. Every 5 minutes, each process deletes the completed and failed
jobs whose retention has ended. It deletes them in batches of 1000 with SKIP LOCKED, so the processes share the work.
`cleanup: false` turns it off.

### Connections

- `enqueue` uses the caller's connection or transaction.
- All other queue work uses the adapter's pool, which should be small. The queue's transactions on this pool use
  `READ COMMITTED`. `migrate()` also runs on a connection of this pool.
- Handlers use whatever connections they open. `localMaxConcurrency` limits the running handlers of a process, so they
  cannot exhaust the app's pool.

### MariaDB

MariaDB speaks the MySQL protocol, so the app tells the adapter (`{ dialect: 'mariadb' }`, see
[Adapters](adapters.md#mariadb)). MariaDB has SQL files of its own: `store/mariadb_*.js` and `schema/mariadb.js` are
copies of the MySQL files, changed where MariaDB differs. A change of the MySQL SQL must be made in the copies too.

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
  subquery opens the view (`lockJob` of `failJob` and of stall recovery). Each statement of the READ COMMITTED queue
  transaction has a read view of its own, so no view from an earlier statement is open.
- **Writes by a list of ids.** On a small table, MariaDB scans the whole table for `WHERE id IN (…)` and waits for
  the rows that other claims hold: concurrent claims then deadlock. These writes force the primary key (or the index
  of the column) with `FORCE INDEX`. A `DELETE` takes index hints only in its multi-table form, so it uses that form.
- **Collation.** MariaDB 10.11 has no `utf8mb4_0900_bin`, so the tables use `utf8mb4_bin`.

## Guarantees

The table lists each guarantee and the mechanism that keeps it.

| Guarantee                                                                                                                                                                                      | Mechanism                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A job exists only if the caller's transaction commits.                                                                                                                                         | The INSERT runs in the caller's transaction, so a connection must be in one.                                                                                  |
| A job does not start before its data is visible.                                                                                                                                               | Other connections see only committed rows.                                                                                                                    |
| A committed job runs at least once.                                                                                                                                                            | Leases, stall recovery, and the release on close.                                                                                                             |
| Only the current owner saves the result of a job.                                                                                                                                              | The claim uses SKIP LOCKED, and every write checks the `lock_token`.                                                                                          |
| A job with a `jobId` is added once while its row exists.                                                                                                                                       | The primary key is `<job_name>:<job_id>`.                                                                                                                     |
| At most `max` jobs with a common key of a global limit run at the same time, unless a handler ignores its `signal` past the lease or `exitsBy`, or two claims race during a change of the max. | The primary key `(key, slot)` of `sqlane_concurrency_slots`, the claim, and the linger of slots.                                                              |
| A job blocked on a key is due again once the key has room.                                                                                                                                     | The unblock after each release and after each claim that blocks, and the sweep of the stall recovery.                                                         |
| Any window of length `per` sees at most `max + burst − 1` starts of a key of a global rate limit, counted by cost, while its jobs carry one setting of the key.                                | The row of the key in `sqlane_rate_limits`, locked by the claim, whose `tat` moves in the transaction of the claim.                                           |
| A job blocked on a rate key is due again once the key allows its start.                                                                                                                        | The timer of the process that blocked it, and the sweep of the stall recovery (up to about 30 s later if that process stopped).                               |
| A job that fails for good adds its failure job, if the database accepts it.                                                                                                                    | The INSERT of the failure job runs in the transaction of the fail.                                                                                            |
| A lost hint does not lose a job.                                                                                                                                                               | Hints only wake processes, and the database keeps the jobs.                                                                                                   |
| Each slot of a schedule adds at most one job, ever.                                                                                                                                            | The cursor in `sqlane_schedules`, locked and moved in the transaction of the enqueue.                                                                         |
| A slot adds a job if a started process with the schedule is up within 1 minute after it, or, with `missed: 'once'`, at the next start within the catch-up reach (the latest missed slot only). | The timer of each process, the lock pass and the cursor. If a fire rolls back and a later slot of the schedule is decided first, the earlier slot is skipped. |

## Observability

- **Logs.** sqlane writes internal diagnostics, such as probe errors and reconnects, to an injected pino-compatible
  logger. Without a logger, it writes no logs.
- **Events.** `onEvent(event)` receives the events of the job lifecycle. The event is a typed union, and its `type` is
  one of `claimed`, `completed`, `retried`, `failed`, `rate_limited`, `timed_out`, `stalled`, `released`,
  `lease_lost`, `failure_job_not_added`, `schedule_fired` and `error`. The app maps the events to its metrics.
  `schedule_fired` comes once per decided slot in the cluster, from the process that decided it. `rate_limited` comes
  each time a handler's `RateLimitedError` makes its job wait. New event types may come in minor versions.
- **Schedules.** `getSchedules()` gives the next slot, the last slot and the last job of each schedule, from the
  table and from this process.
- **Gauges.** For each job name, `getStats()` returns the number of pending, due, running, stuck and failed jobs, and
  the age of the oldest due job. A stuck job is a `running` job with a `timed_out_at` time: it timed out, and its
  handler has not settled yet. A blocked job, on a full key or on a rate key, counts as pending. These numbers support
  alerts such as "the queue is stuck". OpenTelemetry support may come later, as a separate package.

## Supported versions

| Component        | Minimum                     | Why                                                                                                                   |
| ---------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Node.js          | 22.12                       | Node 22, 24 and 26 in CI.                                                                                             |
| MySQL            | 8.4 LTS                     | 8.0 reached end of life (April 2026). SKIP LOCKED, window functions, CTEs.                                            |
| MariaDB          | 10.11 LTS                   | 10.6 reached end of life (July 2026). SKIP LOCKED, `JSON_TABLE`. 10.11 and 11.8 in CI.                                |
| PostgreSQL       | 15                          | 14 reaches end of life in November 2026.                                                                              |
| Drivers and ORMs | See [Adapters](adapters.md) | `mysql2` and `pg` are optional peer dependencies. They are drivers, not ORMs, and their major versions change rarely. |

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

- `create_sqlane.js` is the facade. It creates the instance and connects the parts below.
- `define_job.js` defines jobs.
- `registry.js` keeps the handlers, their weights and local limits.
- `fair_share.js` shares the free slots between the names: `fill()`, `rankNames()`, `chooseRows()`, and `replayTie()` for the choices made in SQL.
- `define_concurrency_limit.js` defines the concurrency limits; `concurrency_keys.js` checks the global limits of a
  job at enqueue.
- `define_rate_limit.js` defines the rate limits; `rate_keys.js` checks the global rate limits of a job at enqueue;
  `gcra.js` holds the arithmetic of GCRA, `local_rates.js` the local rate limits, and `rate_wakes.js` the timer of the
  rate keys.
- `runner.js` runs the dispatcher loop. It also renews the leases, recovers stalled jobs, runs the cleanup, and
  implements `close()` and `drain()`.
- `enqueue.js` implements `enqueue` and `enqueueMany`.
- `hint_channel.js` sends and receives the hints.
- `migrations.js` implements `migrate()` and `getMigrations()`.
- `cron.js` parses cron expressions and finds their slots, `time_zone.js` reads wall-clock times from `Intl`,
  `schedule.js` checks the options of a schedule and computes its slots, and `scheduler.js` runs the timer and the
  fires of the schedules.
- `errors.js` defines the error classes.
- `store/` holds the SQL of each dialect behind one store interface.
- `schema/` holds the schema of each dialect, as versioned migrations.
- `adapters/` holds one adapter per driver or ORM.

Small helper modules, such as `backoff.js`, `duration.js` and `payload.js`, complete the list.

## Testing

- **Unit tests** sit next to the code, in `src/**/*.test.js`. They cover the modules that need no database, such as
  backoff, durations, payloads, global limits, GCRA, defaults, option checks and the error classes. They also check the
  adapters and the runner with small stub objects instead of a database.
- **Type tests** in `test/types/` and the examples in `examples/` are type-checked in CI, so the public API cannot
  change by accident. The quickstart in `examples/quickstart` runs in CI against the packed package.
- **Integration tests** in `test/integration/` give most of the value. The same suite runs against MySQL 8.4,
  MariaDB 10.11 and 11.8, and PostgreSQL 15 and 18 in Docker. It covers enqueue, claims, final writes, the runner, migrations, hints, stats,
  schedules and each adapter.
- **DST oracle tests** check the cron search against a brute-force oracle, minute by minute, around every DST
  transition of 2026 in 10 zones, from random starts and along chains of slots. They also bound the work of each
  search.
- **Benchmarks** ([benchmarks](contributing/benchmarks.md)): CI checks the statements of the hot paths on each
  supported version (`pnpm bench:statements`). `pnpm bench:regression` compares the CPU cost of a change with `main`.
