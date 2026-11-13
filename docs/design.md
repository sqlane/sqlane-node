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
6. **Mutex keys.** Two jobs with a common key do not run at the same time in the cluster. [Guarantees](#guarantees)
   gives the exact condition.
7. **Failure jobs.** When a job fails for good, sqlane adds a job of another name, in the same transaction that marks the job as failed.
8. **Library hygiene.** sqlane has no global state, does not read `process.env`, writes nothing to the console and never
   exits the process. The app injects the connections, the logger and the metrics.

## Non-goals

- Exactly-once execution. Handlers must be idempotent.
- A dashboard. `getStats()` gives the counts per job name, and the tables are plain SQL (see [Data](#data)).
- Priorities, or a strict order across processes.
- A cluster-wide concurrency limit per job name (mutex keys cover the per-entity case).
- Workflows, batches, job dependencies.
- SQLite, other databases.
- An ORM. Adapters wrap the transaction objects of the drivers and ORMs.

## Terms

| Term                  | Meaning                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| **Job**               | One row: a payload, a state, attempts, a lease.                                             |
| **Job name**          | The kind of a job, e.g. `build_report`. It is also the "queue": there is no separate queue. |
| **Job definition**    | The name and the options of a job name. Producers and workers import it.                    |
| **Handler**           | The function that runs a job. Only workers register it.                                     |
| **Concurrency group** | A per-process cap shared by the handlers of several names. Costs no connection.             |
| **Fair share weight** | A name's share of the free slots against the other due names.                               |
| **Mutex key**         | A string (`order:42`). Jobs with a common key run one at a time, in the cluster.            |
| **Failure job**       | A job that sqlane adds when another job fails for good.                                     |
| **Adapter**           | Wraps a driver: the dialect, the queue's pool, and the raw connections given to `enqueue`.  |
| **Hint**              | A message "jobs of this name are ready" between processes. Only an optimization.            |
| **Schedule**          | A cron in a time zone, or a fixed interval, that adds a job at each of its times.           |
| **Slot**              | One time of a schedule. It adds at most one job.                                            |

## API

The [API reference](api.md) describes every function, option, default, error and event. This section keeps only the
reasons behind the shape of the API.

- **Definition apart from the handler.** Producers import a small job definition, not the handler and its
  dependencies. So `enqueue` and `handle` take a definition or a name.
- **Payload types, no validation.** A definition can declare its payload type, so the compiler checks `enqueue`, the
  handler and `mutexKeys`. sqlane does not validate payloads at runtime, because the app knows its own rules. A
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
- **Worker settings in worker code.** `maxConcurrency`, `concurrencyGroup` and `fairShareWeight` are `handle()`
  options, not definition fields, because they are per process.
- **Groups are objects.** `defineConcurrencyGroup()` returns a frozen object, which `handle()` takes. A typo in a
  string cannot create a new group, and producers never import them.
- **Handlers own their transactions.** sqlane does not wrap a handler in a transaction or any other app wrapper. It
  stores no result.
- **AbortSignal** for timeouts and close, instead of a hidden race. The lease is renewed while the handler runs, so a
  long job needs no timeout. A job with mutex keys needs one (see [Mutex keys](#mutex-keys)).
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

| Column                                                                | Type               | Notes                                                                                                               |
| --------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                  | varchar(255), PK   | `<job_name>:<job_id>`, or a new ULID without `jobId`. `<job_name>:schedule:[<key>:]<ISO>` for a slot of a schedule. |
| `job_name`                                                            | varchar(128)       |                                                                                                                     |
| `status`                                                              | varchar(16)        | `pending`, `running`, `completed`, `failed`.                                                                        |
| `run_at`                                                              | ts(3)              | Due time.                                                                                                           |
| `attempts`, `max_attempts`                                            | int                |                                                                                                                     |
| `stalls`, `max_stalls`                                                | int                |                                                                                                                     |
| `mutex_keys`                                                          | json / text[] null | Frozen at enqueue, sorted. Written with the job row.                                                                |
| `enqueue_token`                                                       | char(26)           | Per enqueue call: tells created rows from duplicates.                                                               |
| `lock_token`                                                          | char(26) null      | Set by the claim. Every final write checks it.                                                                      |
| `locked_by`                                                           | varchar(255) null  | `<host>:<pid>:<ULID>`.                                                                                              |
| `locked_until`                                                        | ts(3) null         | The lease.                                                                                                          |
| `timed_out_at`                                                        | ts(3) null         | Set on a timeout, cleared by the claim and by every transition out of `running`. For `stuck`.                       |
| `last_error`                                                          | json null          |                                                                                                                     |
| `completed_retention_ms`, `failed_retention_ms`                       | bigint             | Frozen at enqueue.                                                                                                  |
| `failure_job`                                                         | varchar(128) null  | Frozen at enqueue.                                                                                                  |
| `created_at`, `started_at`, `finished_at`, `expires_at`, `updated_at` | ts(3)              |                                                                                                                     |

`id`, `job_name`, the mutex keys and `mutex_key` (below) are case-sensitive: `ascii_bin` on MySQL, `COLLATE "C"` on PostgreSQL.

Indexes:

- MySQL: `(status, job_name, run_at)`, `(expires_at)`.
- PostgreSQL: partial `(job_name, run_at) WHERE status = 'pending'`, partial `(locked_until) WHERE status = 'running'`,
  `(expires_at)`.

### `sqlane_payloads`

`id` (PK), `payload` (json). Apart from the hot table: the claim and the probe do not read it. Deleted when the job
completes; kept for a failed job.

The keys are a column of the job row: they commit with the job even in autocommit, and a duplicate cannot add keys to
an existing job. `sqlane_job_keys` indexes them for the FIFO.

### `sqlane_job_keys`

`mutex_key`, `run_at`, `job_id` (PK in this order), `job_name`; an index on `job_id`. One row per key of each pending
job: the enqueue adds them, a claim deletes them, and a return to `pending` (retry, release, stall) adds them again, in
the same statement or transaction. So the oldest due job of a key is the first row of one index range.

### `sqlane_mutexes`

`mutex_key` (PK), `job_id`, `lock_token`, `held_until` (null: held by a running job), `created_at`. One row per key
that a job holds, or that lingers after a release on close or a stall.

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

The migration ids are matched, never counted. MySQL and MariaDB have `0001_initial`, `0002_job_keys` and
`0004_schedules`. PostgreSQL has `0001_initial`, `0002_pending_order`, `0003_job_keys` and `0004_schedules`. The
schedules migration has the same id on every dialect. It is needed only with schedules: `start()` throws a
`ConfigError` that asks for `migrate()` when a process has schedules and the table is missing.

## Job states

```text
pending ──claim──▶ running ──OK──▶ completed ──retention──▶ (deleted)
   ▲                  │
   └── retry, stall, ─┤
       release        └──no attempts / stalls left──▶ failed (+ failure job) ──retention──▶ (deleted)
```

## How it works

### Enqueue

In the caller's transaction, with its connection (with a pool: in a transaction of sqlane):

1. Check the payload (JSON, at most `maxPayloadBytes`, default 256 KiB) and the options (`jobId`, `delay` or `runAt`,
   `maxAttempts`, `maxStalls`, `retention`, `failureJob`, `mutexKeys`).
2. The mutex keys: the enqueue option if given, else the definition's function of the payload.
3. `INSERT` the jobs, with their keys, in the order of their ids. This order prevents deadlocks between concurrent
   enqueues. Then `INSERT` the payloads of the rows that have this call's `enqueue_token`. With a `jobId`, an existing
   row means a duplicate. In this case, the enqueue returns `{ id, created: false }` and changes nothing, so it also
   skips the payload. Deduplication lasts while the row exists, in any state, so the retention is the deduplication
   window. After cleanup has deleted the row, the same `jobId` adds a new job. On PostgreSQL, all of this is one
   statement (a CTE), which is atomic even outside a transaction.
4. PostgreSQL with the NOTIFY hint: `pg_notify` in the same transaction, delivered on commit.

Frozen in the row at enqueue: `maxAttempts`, `maxStalls`, both retentions, `failureJob`, the mutex keys. Any process
can then retry, stall or fail the job without its definition. Read from the worker's definition at run time: `backoff`
and `timeout`.

`enqueueMany` inserts many jobs in one statement per table and returns `{ id, created }[]` in input order. `created`
comes from the call's `enqueue_token` (MySQL has no `RETURNING`): the payloads are inserted only for the rows with
this token, never for a duplicate committed by another transaction. A `jobId`
repeated in one batch: the first is created, the rest are `created: false`.

### Dispatcher: one loop per process

Each process runs one dispatcher loop. The loop finds the due jobs of the names that the process handles, claims as
many as the free slots allow, and starts their handlers. The pseudo-code below shows its steps.

```text
loop while started
  names = registered job names with a free slot (under the caps of the name, its group and the instance)
  if no names: wait for a wake
  probe: the next run_at of each job name that has pending jobs (one statement)
  if nothing due: wait until the next run_at (at most the poll interval) or a wake
  turn = the due names, the lowest running / weight first, at most 4 per free slot and 4 per free slot of their
    group; the others at the next turn
  names with mutex keys in the turn: their candidates (heads of free keys, FIFO per key), once per turn;
    a plan with fill() leaves them their share of the free slots, of the instance and of their groups
  plain names: lock the oldest due jobs of each, up to min(its room, its group's room, the free slots), and take
    them by share (fill(): the lowest running / weight first, ties round-robin)
  names with mutex keys: claim their candidates whose keys are free, by share
  claimed: start the handlers, loop at once
  none (other processes took them): back off 10–200 ms, with ±50 % jitter
  none (all due jobs wait for keys): wait for a key-release wake or the poll interval
```

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
names furthest under their share first (`rankNames()`), and at most 4 per free slot of their group: a full group
takes no more names, so the names after it get their turn. The names that the rule serves are always a prefix of that
order, and the other names are a margin for names whose jobs other processes hold. A claim that fills the free slots does not read the
next due times of its names: they stay in the backlog, and the next turn claims them again.

**The names with mutex keys** find their candidates once per turn, before the plain claim. A plan over all the names of
the turn gives them their share of the free slots, on their candidate counts, and the plain claim leaves those slots
free: in the instance, and in their groups (the plain claim gets the group rooms minus the reserved slots, and a
`maxJobs` within them). If other processes take the candidates first, the reserved slots stay free for one turn, which comes at once.

The process ignores the names that it does not handle. An idle name has no pending row, so it costs nothing. With 1000
names and pending jobs in 10 of them, the probe reads 10 index entries. A probe with one query per registered name (a
`UNION`) would grow with the number of all names.

These events wake the dispatcher:

- An enqueue in this process, or a hint from another process. See
  [Wake-up after the commit](#wake-up-after-the-commit).
- A finished job, which frees a slot, or a released mutex key. A job that finishes in a full group wakes every name
  of the group, not only its own: the slot it frees can go to any of them.
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
  itself. When a job frees mutex keys, the message is `*`, and every process probes all its names. A receiver re-probes
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

**Names without mutex keys** (in the definition of the claiming process; the keys of their rows are not taken): the
due jobs are found, claimed and read at once, without candidates.

- PostgreSQL: one statement, a transaction of its own. A `LATERAL` per due name locks its oldest due jobs
  (`FOR UPDATE SKIP LOCKED`, at most `min(room, group room, free)`). The k-th locked row of a name gets the share
  `(running + k − 1) / weight`, its share just before it takes the row. Ordering all rows by `(share, tie)` is the
  greedy of `fill()`, row by row: a `ROW_NUMBER` per group keeps the group caps, and `LIMIT` the instance's. The shares
  are `float8`: equal rationals give the same double, and different ones (weights ≤ 1000) differ far above its
  precision. An integration test checks the choice against `fill()` on random claims. The statement also
  returns `unpicked`, the names with a locked row that the claim did not take. The runner replays the choice with
  `replayTie()` (`fill()` over the claimed rows, plus one row of each unpicked name, under the counts and group rooms
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

**Names with mutex keys:** the candidates (the FIFO per key, from `sqlane_job_keys`), then one short transaction on the
queue's pool:

1. `SELECT … WHERE id IN (candidates) AND status = 'pending' AND run_at <= now ORDER BY run_at, id FOR UPDATE SKIP
   LOCKED`.
2. Take the mutex keys (below). Drop the jobs whose keys are busy.
3. `UPDATE` to `running` with a new `lock_token`, `locked_by`, `locked_until = now + lease` (4 minutes).
4. Read the payloads.

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
  the old handler may still run. So a job with mutex keys runs again only after this time.
- So after a crash, the leases of the process end within 4 minutes. Another process finds the jobs within about 30 s,
  and it runs them again 30 s later. A job with mutex keys waits one more lease (4 minutes).
- When a database write of a result fails, the process retries it for up to 10 minutes and renews the lease meanwhile.

### Mutex keys

A mutex key is a string, such as `order:42`. Two jobs that share a key do not run at the same time.

- **Format.** A job has at most 10 keys. Each key has 1 to 255 printable ASCII characters. sqlane removes duplicate keys
  at enqueue, before it counts them. The keys are global strings, so jobs of different names can share them.
- **Hold.** The claim inserts one `sqlane_mutexes` row per key, in the claim transaction. So a job holds all its keys
  or none of them. Every transition out of `running` deletes the rows in the same transaction, except when the keys
  linger (see below). sqlane locks the keys in ascending order, so the transactions of the queue cannot deadlock on
  them.
- **FIFO per key.** A job starts only if none of its keys is held by a job of any name, and no older due job has one of
  its keys. So a job with the keys A and B does not starve behind newer jobs of A or B.
- **Which jobs count.** For each key of a candidate, the FIFO reads the due jobs of the key in order, from
  `sqlane_job_keys`, and takes the oldest one of a name with mutex keys that the claiming process handles: a handled
  name whose definition has `mutexKeys`. A job of another name can get keys from its enqueue options. These keys still
  exclude other jobs at the claim, but without the FIFO. A name that no process handles never blocks a key,
  for example a retired name or a misspelled name that someone enqueued by name. On PostgreSQL the FIFO reads the
  first 100 due jobs of a key: more than 100 due jobs of other names at the front of a key make the process wait for
  them. The candidates of a name are its oldest 500 due jobs. Processes that handle different names see different
  jobs, so the FIFO across names is approximate.
- **Wake-ups.** A completion with keys sends `#<key>` per key (NOTIFY, or the hint). Each process then looks up the
  oldest due job of each released key and claims for its name, instead of probing all names. The woken name competes
  for the free slots by its share, like any other name: it is not preferred. If it loses the slot, its job keeps its
  place in the FIFO of the key, and the key stays free until the job runs.
- **Fair share.** A name whose due jobs all wait for keys has no candidates: it takes no slot and banks nothing.
- **Timeout.** JavaScript cannot stop a handler. On a timeout, sqlane aborts the `signal` with a `JobTimeoutError` and
  emits a `timed_out` event. The job stays `running`, and its lease is renewed. It keeps its keys and its slot until the
  handler settles, but for at most one more lease. During this time, `getStats()` counts it as
  `stuck`. Then the attempt fails with the `JobTimeoutError`. The job is retried after its backoff, or it fails for
  good, and its keys are freed. This applies to all jobs, with or without keys.
- **Linger.** The keys outlive their job row only in two cases, as rows with a `held_until` time. The first case is a
  release on close while the handler still runs. The keys then stay until `exitsBy` plus 2 s (see [Close](#close)). The
  second case is a stall. The keys then stay for one lease, because the old handler may still run. So the old run and
  the new run do not overlap, unless a handler ignores its `signal` past the lease or past `exitsBy`.
- **A job with mutex keys needs a timeout.** The lease is renewed while a handler runs. Without a timeout, a hung
  handler would hold its keys in the whole cluster forever. So `handle()` throws a `ConfigError` if the definition has
  `mutexKeys` and no timeout. A job can also get keys only from its enqueue options. If its handler has no timeout, the
  job fails for good at the claim with a `FatalJobError` ("a job with mutex keys needs a timeout"), and its failure job
  runs.

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
- Handlers use whatever connections they open. `maxConcurrency` limits the running handlers of a process, so they
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
  `deleteExpiredJobs`, the claim of jobs with mutex keys), or lock their one row, by primary key, before the payload
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
| Two jobs with a common mutex key do not run at the same time, unless a handler ignores its `signal` past the lease or `exitsBy`.                                                               | The primary key of `sqlane_mutexes`, the claim, and the linger of keys.                                                                                       |
| A job that fails for good adds its failure job, if the database accepts it.                                                                                                                    | The INSERT of the failure job runs in the transaction of the fail.                                                                                            |
| A lost hint does not lose a job.                                                                                                                                                               | Hints only wake processes, and the database keeps the jobs.                                                                                                   |
| Each slot of a schedule adds at most one job, ever.                                                                                                                                            | The cursor in `sqlane_schedules`, locked and moved in the transaction of the enqueue.                                                                         |
| A slot adds a job if a started process with the schedule is up within 1 minute after it, or, with `missed: 'once'`, at the next start within the catch-up reach (the latest missed slot only). | The timer of each process, the lock pass and the cursor. If a fire rolls back and a later slot of the schedule is decided first, the earlier slot is skipped. |

## Observability

- **Logs.** sqlane writes internal diagnostics, such as probe errors and reconnects, to an injected pino-compatible
  logger. Without a logger, it writes no logs.
- **Events.** `onEvent(event)` receives the events of the job lifecycle. The event is a typed union, and its `type` is
  one of `claimed`, `completed`, `retried`, `failed`, `timed_out`, `stalled`, `released`, `lease_lost`,
  `failure_job_not_added`, `schedule_fired` and `error`. The app maps the events to its metrics. `schedule_fired` comes
  once per decided slot in the cluster, from the process that decided it. New event types may come in minor versions.
- **Schedules.** `getSchedules()` gives the next slot, the last slot and the last job of each schedule, from the
  table and from this process.
- **Gauges.** For each job name, `getStats()` returns the number of pending, due, running, stuck and failed jobs, and
  the age of the oldest due job. A stuck job is a `running` job with a `timed_out_at` time: it timed out, and its
  handler has not settled yet. These numbers support alerts such as "the queue is stuck". OpenTelemetry support may
  come later, as a separate package.

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
- `registry.js` keeps the handlers, their caps, weights and concurrency groups.
- `fair_share.js` shares the free slots between the names: `fill()`, `rankNames()`, `chooseRows()`, and `replayTie()` for the choices made in SQL.
- `define_concurrency_group.js` defines the concurrency groups.
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

Small helper modules, such as `backoff.js`, `duration.js`, `mutex_keys.js` and `payload.js`, complete the list.

## Testing

- **Unit tests** sit next to the code, in `src/**/*.test.js`. They cover the modules that need no database, such as
  backoff, durations, payloads, mutex keys, defaults, option checks and the error classes. They also check the
  adapters and the runner with small stub objects instead of a database.
- **Type tests** in `test/types/` and the examples in `examples/` are type-checked in CI, so the public API cannot
  change by accident. The quickstart in `examples/quickstart` runs in CI against the packed package.
- **Integration tests** in `test/integration/` give most of the value. The same suite runs against MySQL 8.4,
  MariaDB 10.11 and 11.8, and PostgreSQL 15 and 18 in Docker. It covers enqueue, claims, final writes, the runner, migrations, hints, stats,
  schedules and each adapter.
- **DST oracle tests** check the cron search against a brute-force oracle, minute by minute, around every DST
  transition of 2026 in 10 zones, from random starts and along chains of slots. They also bound the work of each
  search.
- **Benchmarks** (`pnpm bench`) do not run in CI. They measure the cost of the probe with 1000 idle names, the latency
  from enqueue to start, and the throughput. The [benchmarks](benchmarks.md) page has the results.
