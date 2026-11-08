# sqlane design (v0.1)

> Status: agreed design. Nothing here is implemented yet.

sqlane runs background jobs that are rows in the application's own SQL database (MySQL or PostgreSQL). The application
adds a job in its business transaction: no commit, no job.

## Goals

1. **Transactional enqueue.** A job is inserted with the connection of the caller's transaction. It exists only if
   that transaction commits, and it never starts before its data is visible.
2. **Cheap idle job names.** 1000 job names, most of them idle, cost about the same as 10. The database load of a
   process does not grow with the number of registered job names, only with the names that have pending jobs.
3. **Low latency.** A job starts in milliseconds after the commit in the same process, or in another process with a
   hint transport, and within the poll interval (default 5 s) without one. See [Wake after commit](#wake-after-commit).
4. **At-least-once execution.** A committed job runs at least once, also after a crash, a stall or a deploy.
5. **MySQL and PostgreSQL** with the same features and the same API.
6. **Mutex keys.** Two jobs with a common key do not run at the same time in the cluster (see [Guarantees](#guarantees)).
7. **Failure jobs.** A job that fails for good adds a job of another name, in the same transaction as the fail.
8. **Library hygiene.** No global state, no `process.env`, no console output, no exit. The app injects the
   connections, the logger and the metrics.

## Non-goals (v0.1)

- Exactly-once execution. Handlers must be idempotent.
- Cron and recurring jobs. Use a scheduler that enqueues jobs.
- A dashboard. The tables are plain SQL; the docs give the queries.
- Priorities, or a strict order across processes.
- A cluster-wide concurrency limit per job name (mutex keys cover the per-entity case).
- Workflows, batches, job dependencies.
- MariaDB, SQLite, other databases.
- An ORM. Adapters wrap the transaction objects of the drivers and ORMs.

## Terms

| Term               | Meaning                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| **Job**            | One row: a payload, a state, attempts, a lease.                                             |
| **Job name**       | The kind of a job, e.g. `build_report`. It is also the "queue": there is no separate queue. |
| **Job definition** | The name and the options of a job name. Producers and workers import it.                    |
| **Handler**        | The function that runs a job. Only workers register it.                                     |
| **Lane**           | A per-process concurrency limit shared by handlers. Costs no connection.                    |
| **Mutex key**      | A string (`order:42`). Jobs with a common key run one at a time, in the cluster.            |
| **Failure job**    | The job that a job adds when it fails for good.                                             |
| **Adapter**        | Wraps a driver: the dialect, the queue's pool, and the raw connections given to `enqueue`.  |
| **Hint**           | A message "jobs of this name are ready" between processes. Only an optimization.            |

## API

```js
// jobs/build_report.js: the definition, imported by producers and workers
import { defineJob } from '@sqlane/core';

export const buildReport = defineJob({
    name: 'build_report',
    maxAttempts: 3,
    backoff: { type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 },
    mutexKeys: (payload) => [`report:${payload.reportId}`], // optional, sync, from the payload only
    failureJob: 'fail_report', // optional: a definition or a name
    maxStalls: 2,
    retention: { completed: '1h', failed: '30d' },
    timeout: '5m', // no default; a keyed job needs one (here, in handle() options or in defaults)
});
```

```js
// app.js
import { createSqlane } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/mysql2'; // or pgAdapter(pool, { notify: true }) from '@sqlane/core/pg'

const sqlane = createSqlane({
    adapter: mysql2Adapter(queuePool), // the queue's own connections: claims, leases, results
    jobs: [buildReport, failReport], // definitions known by name
    concurrency: 10, // running handlers in this process
    lanes: { heavy: { concurrency: 2 } }, // limits shared by several job names
    defaults: { maxAttempts, maxStalls, backoff, retention, timeout }, // a definition overrides them
    unknownJobs: 'allow', // or 'reject': enqueue of an unknown name (not in `jobs`, not handled) throws
    hint: null, // or { publish, subscribe }: any pub/sub
    logger, // pino-compatible: { debug, info, warn, error }
    onEvent, // (event) => void, a typed union
    tablePrefix: 'sqlane_', // ^[a-z][a-z0-9_]{0,31}$
    pollInterval: '5s',
    maxPayloadBytes: 256 * 1024,
    cleanup: true, // built-in deletion of expired jobs
});

const { applied } = await sqlane.migrate(); // ids; or getMigrations({ dialect, tablePrefix }) for the app's own tool

// Producer: in the business transaction, with the raw driver connection
const { id, created } = await sqlane.enqueue(conn, buildReport, { reportId }, {
    jobId: reportId, // dedupe: created is false if the job exists
    delay: '10s', // or runAt: Date
    maxAttempts: 5,
    mutexKeys: [`report:${reportId}`], // replaces the definition's keys; [] clears them
    // also: maxStalls, retention, failureJob
});
const results = await sqlane.enqueueMany(conn, buildReport, [{ payload, options }]); // [{ id, created }], in order
await sqlane.enqueue(conn, 'build_report', { reportId }); // by name

// Worker
sqlane.handle(buildReport, async ({ payload, job, signal }) => {
    // job: { id, name, attempt, maxAttempts, enqueuedAt, mutexKeys }
    // signal: AbortSignal; reason JobTimeoutError, LeaseLostError or ShutdownError
}, { concurrency: 2, timeout: '5m' }); // a private lane; or { lane: 'heavy' }; not both
sqlane.handle(exportCsv, runExportCsv, { lane: 'heavy' });
sqlane.handle(pingWebhook, runPing); // the process concurrency only

await sqlane.start();

// Tests: run the due jobs of the handled names until none is left, without start()
const { completed, retried, failed } = await sqlane.drain({ timeout: '10s', includeDelayed: true });

// Ops
const stats = await sqlane.getStats(); // [{ name, pending, due, running, stuck, failed, oldestDueAgeMs }]
sqlane.wake('build_report'); // low-level: probe this name now

// Shutdown
await sqlane.close({ deadline: '30s', mode: 'release', exitsBy: '1m' }); // durations from this call
```

Choices:

- **Definition apart from the handler.** Producers import a small definition, not the handler and its dependencies.
  `enqueue` and `handle` take a definition or a name.
- **No payload types, no validation.** An enqueued payload must be JSON: `enqueue` checks it with a `Jsonable<T>`
  type inferred from the argument (TS interfaces and optional fields pass; a `Date`, a `Map` or a class instance is
  a type error; no generics to write). The read side (the handler's `payload`, the argument of `mutexKeys`) is `any`. At runtime:
  `JSON.stringify`, well-formed strings without NUL (PostgreSQL `jsonb` refuses it), and the size limit, no revivers. The app validates its own payloads.
- **Names and ids.** A job name matches `^[a-z][a-z0-9_.-]{0,127}$` (no `:`). A `jobId` is a string of 1–120
  printable ASCII characters. Both are case-sensitive on both databases.
- **Enqueue by name too.** `enqueue(conn, 'job_name', …)` is for producers without the definition (another service,
  a script). It uses the definition in `jobs` (or registered by `handle()`), else the defaults; then `mutexKeys` and
  `failureJob` come only from the enqueue options. A name is known if it is in `jobs` or handled; `unknownJobs: 'reject'` makes an unknown name an error. List every
  definition in `jobs`: a by-name enqueue before `handle()` registers it would get the defaults. Two different
  definitions with one name throw `ConfigError`.
- **One adapter, raw connections.** The adapter gives the dialect and the queue's pool. `enqueue` takes the driver's
  own connection, transaction client or pool. A connection or client must be in a transaction (MySQL cannot detect
  one safely). With a pool, sqlane runs the enqueue in its own transaction, outside the caller's. Adapters:
  `@sqlane/core/mysql2` (`Connection`, `PoolConnection`, `Pool`) and `@sqlane/core/pg` (`Client`, `PoolClient`,
  `Pool`) in v0.1; Knex, Kysely, Drizzle, Sequelize, Prisma, TypeORM, MikroORM later, as separate packages
  (`@sqlane/knex`, …).
- **Worker settings in worker code.** `concurrency` and `lane` are `handle()` options, not definition fields: they are
  per process. A handler takes `concurrency` (a private lane) or `lane` (a lane of `lanes`), not both (a type error).
  An unknown lane is a type error and a `ConfigError`. A lane is capped by the process `concurrency`.
- **Handlers own their transactions.** sqlane does not wrap the handler in a transaction or any other app wrapper. A
  handler that needs one opens it with its own connection. Its return value is ignored: no result storage.
- **AbortSignal** for timeouts and close, instead of a hidden race. The lease is renewed while the handler runs, so a
  long job needs no timeout (a keyed job does: see [Mutex keys](#mutex-keys)). `timeout` comes from the `handle()`
  options, else the definition, else `defaults`.
- **Durations** as strings (`'5s'`) or milliseconds.
- **No implicit work.** `createSqlane` connects, migrates and starts nothing.
- **Lifecycle.** `enqueue` and `enqueueMany` keep working after `close()` (they use only the caller's connection);
  `start`, `handle` and `drain` throw `ClosedError`.

### Defaults

| Option        | Default                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| `maxAttempts` | 3                                                                               |
| `maxStalls`   | 2                                                                               |
| `backoff`     | `{ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 }`             |
| `retention`   | `{ completed: '1h', failed: '30d' }`                                            |
| `timeout`     | none                                                                            |
| `close()`     | `{ deadline: '30s', mode: 'release', exitsBy: '4m30s' }` (deadline + one lease) |
| `concurrency` | 10                                                                              |
| `unknownJobs` | `'allow'`                                                                       |

Backoff: `exponential` (`delay × 2^(attempt − 1)`, at most `maxDelay`) or `fixed` (`delay`). Then jitter (0–1):
`delay × (1 − jitter × random())`, never above the computed delay. `jitter: 0` turns it off.

### Errors

All extend `SqlaneError` and have a `code`:

| Class                       | `code`                   | When                                                                    |
| --------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `ConfigError`               | `CONFIG`                 | Bad `createSqlane`, `defineJob` or `handle()` options (see below).      |
| `InvalidOptionsError`       | `INVALID_OPTIONS`        | Bad enqueue options: a bad name or `jobId`, `delay` with `runAt`.       |
| `PayloadTooLargeError`      | `PAYLOAD_TOO_LARGE`      | The payload is above `maxPayloadBytes`.                                 |
| `InvalidMutexKeyError`      | `INVALID_MUTEX_KEY`      | More than 10 keys, or a key that breaks the rules.                      |
| `UnknownJobError`           | `UNKNOWN_JOB`            | Enqueue of an unknown name with `unknownJobs: 'reject'`.                |
| `ClosedError`               | `CLOSED`                 | `start`, `handle` or `drain` after `close()`.                           |
| `DrainTimeoutError`         | `DRAIN_TIMEOUT`          | `drain()` did not finish in its `timeout`.                              |
| `JobTimeoutError`           | `JOB_TIMEOUT`            | The `signal.reason` on a timeout; recorded as the error of the attempt. |
| `ShutdownError`             | `SHUTDOWN`               | The `signal.reason` at the close deadline.                              |
| `LeaseLostError`            | `LEASE_LOST`             | The `signal.reason` when the lease could not be renewed in time.        |
| `MissingPayloadError`       | `MISSING_PAYLOAD`        | Recorded as the error of a job without its payload.                     |
| `MigrationLockTimeoutError` | `MIGRATION_LOCK_TIMEOUT` | `migrate()` did not get the migration lock in its `lockTimeout`.        |

`ConfigError` cases: an unknown lane, `lane` with `concurrency`, a duplicate `handle()`, two definitions with one name,
`handle()` after `start()`. `start()` and `drain()` throw it for a handled definition whose `failureJob` is a name
that is neither in `jobs` nor handled, or a failure job whose definition has a `failureJob` of its own: they check the
handlers together, so the order of the `handle()` calls does not matter. `handle()` also throws it for a keyed
definition whose resolved timeout (`handle()` options, else the definition, else `defaults`) is none; `defineJob` never
checks the timeout.

Thrown by handlers:

- `new FatalJobError(message, { cause })` (`FATAL_JOB`): fail at once, without retries; the failure job runs.
- `new RetryJobError(message, { delay: '1m' })` (`RETRY_JOB`): retry after this delay instead of the backoff (e.g. a
  rate limit). It still uses an attempt.

## Data

Four tables per prefix (default `sqlane_`), snake_case: the three below and `sqlane_migrations`. Times use the DB clock only
(`UTC_TIMESTAMP(3)` / `clock_timestamp()`): no clock skew between processes. `ts(3)` is `DATETIME(3)` holding UTC on
MySQL (no session time zone, no 2038 limit) and `timestamptz(3)` on PostgreSQL. A `runAt: Date` is sent as a UTC
string (MySQL) or a `timestamptz` (PostgreSQL), never in the session time zone. Times are read back as epoch
milliseconds computed in SQL, and every due or wait computation (`run_at - now`) runs in SQL: sqlane does not depend
on the pool's `timezone` or `dateStrings` settings.

### `sqlane_jobs`

| Column                                                                | Type               | Notes                                                                                         |
| --------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `id`                                                                  | varchar(255), PK   | `<job_name>:<job_id>`, or a new ULID without `jobId`.                                         |
| `job_name`                                                            | varchar(128)       |                                                                                               |
| `status`                                                              | varchar(16)        | `pending`, `running`, `completed`, `failed`.                                                  |
| `run_at`                                                              | ts(3)              | Due time.                                                                                     |
| `attempts`, `max_attempts`                                            | int                |                                                                                               |
| `stalls`, `max_stalls`                                                | int                |                                                                                               |
| `mutex_keys`                                                          | json / text[] null | Frozen at enqueue, sorted. Written with the job row.                                          |
| `enqueue_token`                                                       | char(26)           | Per enqueue call: tells created rows from duplicates.                                         |
| `lock_token`                                                          | char(26) null      | Set by the claim. Every final write checks it.                                                |
| `locked_by`                                                           | varchar(255) null  | `<host>:<pid>:<ULID>`.                                                                        |
| `locked_until`                                                        | ts(3) null         | The lease.                                                                                    |
| `timed_out_at`                                                        | ts(3) null         | Set on a timeout, cleared by the claim and by every transition out of `running`. For `stuck`. |
| `last_error`                                                          | json null          |                                                                                               |
| `completed_retention_ms`, `failed_retention_ms`                       | bigint             | Frozen at enqueue.                                                                            |
| `failure_job`                                                         | varchar(128) null  | Frozen at enqueue.                                                                            |
| `created_at`, `started_at`, `finished_at`, `expires_at`, `updated_at` | ts(3)              |                                                                                               |

`id`, `job_name`, the mutex keys and `mutex_key` (below) are case-sensitive: `ascii_bin` on MySQL, `COLLATE "C"` on PostgreSQL.

Indexes:

- MySQL: `(status, job_name, run_at)`, `(expires_at)`.
- PostgreSQL: partial `(job_name, run_at) WHERE status = 'pending'`, partial `(locked_until) WHERE status = 'running'`,
  `(expires_at)`.

### `sqlane_payloads`

`id` (PK), `payload` (json). Apart from the hot table: the claim and the probe do not read it. Deleted when the job
completes; kept for a failed job.

The keys are a column of the job row, not a table: they commit with the job even in autocommit, and a duplicate
cannot add keys to an existing job. The FIFO reads them with `JSON_TABLE` (MySQL) or `unnest` (PostgreSQL).

### `sqlane_mutexes`

`mutex_key` (PK), `job_id`, `lock_token`, `held_until` (null: held by a running job), `created_at`. One row per key
that a job holds, or that lingers after a release on close or a stall.

### Migrations

sqlane ships its schema as versioned SQL per dialect. Two ways to apply it:

- `sqlane.migrate({ lockTimeout })`: resolves to `{ applied }`, the ids it applied. It applies the missing versions, records them in `sqlane_migrations`, under a DB
  lock. It waits for the lock up to `lockTimeout` (default `'10m'`), on its own connection without the statement
  timeout of the queue: a long migration of a big table is not cancelled. PostgreSQL: one transaction under
  `pg_advisory_xact_lock` (transactional DDL). MySQL: `GET_LOCK`; each statement is idempotent (`IF NOT EXISTS`), as
  MySQL commits each DDL statement and a cut migration runs again from its start.
- `getMigrations({ dialect, tablePrefix })`: returns the SQL, for the app's own migration tool.

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
3. `INSERT` the jobs (with their keys) in the order of their ids (no deadlocks between concurrent enqueues), then the
   payloads of the rows with this call's `enqueue_token`. With a `jobId`, an existing row means a duplicate: the enqueue returns
   `{ id, created: false }` and adds nothing. Deduplication lasts while the row exists, in any state: the retention
   is the dedupe window. After cleanup, the same `jobId` adds a new job. A duplicate changes nothing: its payload insert is skipped too.
   PostgreSQL: one statement (a CTE), atomic even outside a transaction.
4. PostgreSQL with the NOTIFY hint: `pg_notify` in the same transaction, delivered on commit.

Frozen in the row at enqueue: `maxAttempts`, `maxStalls`, both retentions, `failureJob`, the mutex keys. Any process
can then retry, stall or fail the job without its definition. Read from the worker's definition at run time: `backoff`
and `timeout`.

`enqueueMany` inserts many jobs in one statement per table and returns `{ id, created }[]` in input order. `created`
comes from the call's `enqueue_token` (MySQL has no `RETURNING`): the payloads are inserted only for the rows with
this token, never for a duplicate committed by another transaction. A `jobId`
repeated in one batch: the first is created, the rest are `created: false`.

### Dispatcher: one loop per process

```text
loop while started
  names = registered job names whose lane has a free slot (none if `concurrency` handlers run)
  if no names: wait for a wake
  probe: the next run_at of each job name that has pending jobs (one statement)
  if nothing due: wait until the next run_at (at most the poll interval) or a wake
  claim the oldest due jobs that pass the key check (not held, FIFO in the window), at most the free slots
  of each lane and of the process
  claimed: start the handlers, loop at once
  none (other processes took them): back off 10–200 ms
  none (all due jobs wait for keys): wait for a key-release wake or the poll interval
```

**The probe is the key to cheap idle names.** One statement reads only the names that have pending rows:

- MySQL: `SELECT job_name, MIN(run_at) FROM sqlane_jobs WHERE status = 'pending' GROUP BY status, job_name`. With the
  index `(status, job_name, run_at)`, MySQL uses a loose index scan: one index dive per pending name. The `GROUP BY`
  names the whole index prefix: `GROUP BY job_name` alone gets a full index scan.
- PostgreSQL has no loose index scan. A recursive CTE skips from one pending name to the next on the partial index:
  two index probes per pending name.

The process ignores the names it does not handle. An idle name (no pending row) costs nothing. 1000 names with
jobs pending in 10 of them: the probe reads 10 index entries. A probe with one query per registered name (a `UNION`)
would grow with all names.

Wakes:

- An enqueue in this process or a hint from another one (see [Wake after commit](#wake-after-commit)).
- A finished job (a free slot), or a released mutex key.
- The poll interval (default 5 s): the fallback, also for jobs whose delay ends.

### Wake after commit

A raw driver has no after-commit event, so `enqueue` does not know when the job becomes visible. The business logic
calls nothing:

- **Default, any driver: re-probe.** After an enqueue of a handled name, the dispatcher of this process probes again
  with a short backoff from that enqueue (20, 50, 100, 200 ms … up to the poll interval). A probe reads all the names,
  so a process has one series: each enqueue restarts it from its own time, and a re-probe due within the first step
  stays. A burst of enqueues gives at most one re-probe per first step (20 ms). The hint transport sends the name to the
  other processes at enqueue time (fire-and-forget); they do the same. The latency is the commit time plus at most one
  backoff step, and never more than the poll interval. A rolled-back transaction costs only the re-probes.
- **PostgreSQL NOTIFY.** `pg_notify` runs in the transaction and is delivered on commit: the receivers probe at once,
  with no re-probe.
- **After-commit hook.** An adapter may have `afterCommit(connection, fn)`: the `@sqlane/<orm>` adapters, from the
  after-commit hook or promise of the ORM. An `enqueue` on a pool runs in its own transaction, committed when it
  returns: the same. After the commit, the process wakes at once and sends the hint, then re-probes as above, from the
  commit.
- **`sqlane.wake(name)`** stays public as a low-level escape hatch. The docs never require it.

The commit event of an ORM is a hint, not a proof: a probe of the table decides. Checked in knex 3.3 and Sequelize
6.37 against MySQL 8.4 and PostgreSQL 18:

- **Too late is harmless, too early is not.** An event without a commit costs one probe. An event before the job is
  visible would leave it to the poll; the re-probes from the event cover it.
- **Events without a commit.** Sequelize runs its `afterCommit` hooks in a `finally`: also when `COMMIT` fails. On
  PostgreSQL, a `COMMIT` after a failed statement whose error the app caught returns `ROLLBACK`: knex resolves its
  transaction and Sequelize runs its hooks, with nothing committed.
- **Early events.** A nested transaction (a savepoint) completes before the outer `COMMIT`, which can still roll back:
  the adapters hook the top-level transaction (knex `parentTransaction`, Sequelize `parent`). They never read the state
  flags of the ORM: Sequelize sets `finished = 'commit'` when it sends `COMMIT`, before the answer.
- **The server.** MySQL and PostgreSQL make a transaction visible before they answer `COMMIT`, also with semi-sync or
  synchronous replication. The queue pool connects to the server that the app writes to: on a replica, or another
  member of a multi-primary cluster, the commit can show later.

### Hints

A generic pub/sub interface, implemented by the app (Redis, NATS, …). The README shows it for ioredis and
node-redis.

```js
/**
 * @typedef {object} Hint
 * @property {(channel: string, message: string) => Promise<void>} publish
 * @property {(channel: string, onMessage: (message: string) => void) => Promise<() => Promise<void>>} subscribe
 *     Resolves to the unsubscribe function.
 */
```

- `hint: null`: polling only.
- `hint: { publish, subscribe }`: the channel is `<tablePrefix>ready`, the message is a job name. Published after an
  enqueue, fire-and-forget: `enqueue` does not wait for `publish`, and a failed publish never rejects it (an `error`
  event). A process sends a hint only for the jobs it cannot start itself. When a job frees mutex keys, the message is
  `*`: every process probes all its names. A receiver re-probes for a short while, as after its own enqueue (the hint
  can come before the commit).
- `pgAdapter(pool, { notify: true })`: LISTEN on a dedicated connection; the enqueue sends `pg_notify` in its
  transaction, so the hint arrives only after the commit. At most one NOTIFY per transaction and job name: NOTIFY
  takes a global lock at commit and limits the commit rate under heavy write load.
- Throttled: at most one message per interval (100 ms) per process and job name.

A lost hint delays a job until the next poll. It never loses a job.

### Claim

One short transaction on the queue's pool:

1. `SELECT … WHERE id IN (candidates) AND status = 'pending' AND run_at <= now ORDER BY run_at, id FOR UPDATE SKIP
   LOCKED`.
2. For keyed jobs: take the mutex keys (below). Drop the jobs whose keys are busy.
3. `UPDATE` to `running` with a new `lock_token`, `locked_by`, `locked_until = now + lease` (default 4 min).
4. Read the payloads, start the handlers. A job without its payload (a broken enqueue outside a transaction, a
   manual change) goes back to `pending` with a 1 s delay and no attempt used, while it is younger than 60 s (its
   payload can still be on the way). After that it fails for good with a `MissingPayloadError`, without retries;
   its failure job runs.

### Leases and stalls

- The process renews the leases of its running jobs every 30 s, in one statement.
- Every final write (complete, retry, fail, release) has `WHERE lock_token = :own`. A process that lost its lease
  changes nothing.
- Completions go in batches: one write at a time per process, and the jobs that finish during a write go together in
  the next one (one transaction, one commit, at most 100 jobs). A lone job waits for no other. A commit flushes the
  log to disk, so one commit per job would cap the throughput.
- If the renewal has not succeeded 30 s before the lease ends (the DB is unreachable, the pool is exhausted), the
  process aborts the handler's `signal` with a `LeaseLostError` and emits `lease_lost`. The job is no longer its own.
- Stall recovery (each process, every 30 s, in small batches with SKIP LOCKED): a `running` job whose lease ended
  gets one more stall and goes back to `pending` with a delay of 30 s × 2^stalls (at most 1 h). After `maxStalls`
  (default 2), the next stall fails it. Its keys linger for one more lease (`held_until`) instead of being deleted:
  the old handler may still run.
- A failed DB write of a result is retried for up to 10 min, while the lease is renewed.

### Mutex keys

- At most 10 keys per job, 1–255 printable ASCII characters. Duplicates are removed at enqueue, before the count. The keys are global strings: jobs of different names
  share them.
- **Hold.** The claim inserts one `sqlane_mutexes` row per key, in the claim transaction: a job holds all its keys or
  none. Every transition out of `running` deletes them in the same transaction, except where they linger (below). Keys are locked in ascending order:
  no deadlocks between queue transactions.
- **FIFO per key.** A job starts only if none of its keys is held (by a job of any name) and no older due job has one
  of its keys. A job with keys A and B does not starve behind newer jobs of A or B.
- **Window.** The FIFO looks at the oldest 500 due jobs of each keyed name that the claiming process handles (a
  handled name whose definition has `mutexKeys`). Keys given only in the enqueue options of another name still exclude
  each other at the claim, without the FIFO. A name
  that no process handles (a retired name, a typo enqueued by name) never blocks a key. Processes that handle
  different names see different windows, so the FIFO across names is approximate. More than 500 due jobs on one key
  delay the jobs behind them: coalesce such jobs.
- **Timeout.** JS cannot stop a handler. On a timeout, `signal` aborts with a `JobTimeoutError` and a `timed_out`
  event fires. The job stays `running` (the lease is renewed), with its keys, lane slot and process slot, until the
  handler settles, at most one more lease (`stuck` in `getStats()`). Then the attempt fails (retry by backoff, or fail
  for good) with the `JobTimeoutError`, and the keys are freed. Applies to all jobs, keyed or not.
- **Linger.** Keys outlive their job row only in two cases, as `held_until` rows: a release on close of a handler
  that still runs (until `exitsBy + 2 s`, see [Close](#close)), and a stall (one lease: the old handler may still
  run). So the old and new runs do not overlap, unless a handler ignores `signal` past the lease or `exitsBy`.
- **A keyed job needs a timeout.** The lease is renewed while a handler runs, so a hung keyed handler would hold its
  keys in the whole cluster forever. `handle()` throws `ConfigError` if the definition has `mutexKeys` and no timeout.
  A job with keys only from the enqueue options, on a handler without a timeout, fails for good at claim with a
  `FatalJobError` ("a job with mutex keys needs a timeout"); its failure job runs.

### Failure jobs

When a job fails for good (no attempts left, too many stalls, or a `FatalJobError`), and its row has a `failureJob`:

- The fail and the insert of the failure job commit together. The insert runs under a savepoint: if the database
  refuses it, the job still fails, without it (`error` log, `failure_job_not_added` event).
- Payload (`FailedJobPayload`): `{ job: { id, name, payload, attempt, maxAttempts }, error: { name, message, stack } }`.
  Exempt from `maxPayloadBytes`; `error.stack` is cut to 8 KiB.
- A `FatalJobError` fails the job at once, with the same failure job.
- The failure job is an ordinary job. Its options come from its definition: `start()` and `drain()` check that it resolves (a
  definition object, or a name in `jobs` or handled) and has no `failureJob` of its own (`ConfigError`). A stall-fail
  in a process that does not know the definition uses the defaults. Its row always gets `failure_job = null` (no
  chains), and it is exempt from `unknownJobs: 'reject'`.
- A replayed fail (lost acknowledgment) or a lost lease adds no second failure job.

### Close

`close({ deadline, mode, exitsBy })` stops claiming and waits for the running handlers until the deadline. At the deadline
the handlers get an aborted `signal`, and for each unfinished job:

| `mode`    | Effect                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `release` | Back to `pending`, no attempt used. Handler settled: `run_at = now`. Handler still runs: `run_at = exitsBy + 2 s`, its keys linger until then. |
| `abandon` | Nothing written. The lease ends, recovery counts one stall. For crashes.                                                                       |

`deadline` and `exitsBy` are durations counted from the `close()` call. `exitsBy` (default: the deadline plus one
lease) is the latest time the process exits: then the old run is surely gone. Set it lower if the app exits sooner.
`close()` never rejects on its options, so a shutdown always releases: an invalid `exitsBy` (not a duration, or
before the deadline) logs a warning and uses the default. A handler
that throws after this abort counts as unfinished: no attempt is used. `close()` resolves when the
handlers have settled or the deadline has passed, and the releases are written. It ends only what sqlane opened (the
LISTEN connection, the hint subscription), never the app's pool.

### Drain

`drain({ timeout, includeDelayed })` claims and runs jobs until none is left, without `start()`:

- Only the names this instance handles, and only the due jobs. Pending jobs of other names are not waited for.
- `includeDelayed: true` also runs the delayed jobs and the retries in backoff at once (each round makes the pending
  jobs of the handled names due now): for tests like "fails 3 times, then the failure job runs".
- Returns counts: `completed`, `retried` (failed attempts that were retried), `failed` (jobs that failed for good).
  On timeout it rejects with `DrainTimeoutError`.

### Cleanup

Built in, no cron: each process deletes the completed and failed jobs after their retention, every 5 min, in batches
of 1000, with SKIP LOCKED, so processes share the work. Off with `cleanup: false`.

### Connections

- `enqueue`: the caller's connection or transaction.
- Everything else: the adapter's pool (small, `READ COMMITTED`, statement timeout 10 s; not for `migrate()`).
- Handlers: whatever they open. `concurrency` limits the running handlers of a process, so they cannot exhaust the
  app's pool.

## Guarantees

| Guarantee                                                                                                                    | Mechanism                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A job exists only if the caller's transaction commits.                                                                       | INSERT in the caller's transaction (a connection must be in one). |
| A job does not start before its data is visible.                                                                             | Other connections see only committed rows.                        |
| A committed job runs at least once.                                                                                          | Leases, stall recovery, release on close.                         |
| Only the current owner saves the result of a job.                                                                            | SKIP LOCKED claim, `lock_token` on writes.                        |
| A job with a `jobId` is added once while its row exists.                                                                     | Primary key `<job_name>:<job_id>`.                                |
| Two jobs with a common mutex key do not run at the same time, unless a handler ignores `signal` past the lease or `exitsBy`. | `sqlane_mutexes` primary key, claim, linger.                      |
| A job that fails for good adds its failure job (if the DB accepts it).                                                       | INSERT in the fail transaction.                                   |
| A lost hint does not lose a job.                                                                                             | Hints only wake; the database keeps the jobs.                     |

## Observability

- **Logs:** an injected pino-compatible logger, for internal diagnostics (probe errors, reconnects). No logger: no
  logs.
- **Events:** `onEvent(event)`, a typed union by `type`, for the job lifecycle: `claimed`, `completed`, `retried`, `failed`, `timed_out`, `stalled`,
  `released`, `lease_lost`, `failure_job_not_added`, `error`. The app maps them to its metrics.
- **Gauges:** `getStats()` returns the pending, due, running, stuck (`running` with `timed_out_at`: timed out, not settled) and failed counts and
  the oldest due age per job name,
  for "queue stuck" alerts. OpenTelemetry later, as a separate package.

## Supported versions

| Component  | Minimum                                     | Why                                                                        |
| ---------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| Node.js    | 22.12                                       | Node 22, 24 and 26 in CI.                                                  |
| MySQL      | 8.4 LTS                                     | 8.0 reached end of life (April 2026). SKIP LOCKED, window functions, CTEs. |
| PostgreSQL | 15                                          | 14 reaches end of life in November 2026.                                   |
| Drivers    | `mysql2`, `pg`; optional peer dependencies. |

## Package layout

```text
@sqlane/core              core: definitions, runner, dispatcher, SQL of both dialects, migrations
@sqlane/core/mysql2       mysql2Adapter
@sqlane/core/pg           pgAdapter (with the NOTIFY hint)
@sqlane/<orm>             later: knex, kysely, drizzle, sequelize, prisma, typeorm, mikro-orm
```

One repository, a pnpm workspace: `packages/<name>` for each published package, `test/` for the test databases of all
of them (a private package, `@sqlane/testing`). The packages have one version (a fixed group of Changesets) and
release together. An adapter has `@sqlane/core` and its ORM as peer dependencies.

Source (`src/`, snake_case files): `define_job.js`, `sqlane.js` (facade), `dispatcher.js`, `lanes.js`,
`lease_keeper.js`, `stall_recovery.js`, `cleanup.js`, `errors.js`, `store/` (one SQL module per dialect behind one
store interface), `adapters/`.

## Testing

- Unit: dispatcher, lanes, backoff, option checks, with an in-memory store fake.
- Types: the examples (`examples/`) and type tests (`expectTypeOf`, `@ts-expect-error`) run in CI, so the public API
  cannot change by accident.
- Integration (most of the value): the same suite against MySQL 8.4 and PostgreSQL 15 and 18 in Docker, for the
  store and the runner: claims under contention, leases, stalls, mutex FIFO, failure jobs, close modes.
- Benchmark (`pnpm bench`, not in CI): 1000 idle names (probe cost), enqueue-to-start latency, throughput. Results:
  [benchmarks](benchmarks.md).
