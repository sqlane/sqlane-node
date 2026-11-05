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
6. **Mutex keys.** Two jobs with a common key never run at the same time in the cluster.
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
    retention: { completed: '1h', failed: '30d' },
    timeout: '5m', // optional, no default
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
    defaults: { maxAttempts: 3, backoff, retention, timeout }, // a definition overrides them
    unknownJobs: 'allow', // or 'reject': enqueue of a name not in `jobs` throws UnknownJobError
    hint: null, // or { publish, subscribe }: any pub/sub
    logger, // pino-compatible: { debug, info, warn, error }
    onEvent, // (event) => void, a typed union
    tablePrefix: 'sqlane_',
    pollInterval: '5s',
    maxPayloadBytes: 256 * 1024,
    cleanup: true, // built-in deletion of expired jobs
});

await sqlane.migrate(); // or getMigrations({ dialect, tablePrefix }) for the app's own tool

// Producer: in the business transaction, with the raw driver connection
const { id, created } = await sqlane.enqueue(conn, buildReport, { reportId }, {
    jobId: reportId, // dedupe: created is false if the job exists
    delay: '10s', // or runAt: Date
    maxAttempts: 5,
    mutexKeys: [`report:${reportId}`], // replaces the definition's keys; [] clears them
});
await sqlane.enqueueMany(conn, buildReport, [{ payload, options }]); // one INSERT per table
await sqlane.enqueue(conn, 'build_report', { reportId }); // by name

// Worker
sqlane.handle(buildReport, async ({ payload, job, signal }) => {
    // job: { id, name, attempt, maxAttempts, enqueuedAt, mutexKeys }
    // signal: AbortSignal, aborted on timeout and on close
}, { concurrency: 2 }); // a private lane; or { lane: 'heavy' }; not both
sqlane.handle(exportCsv, runExportCsv, { lane: 'heavy' });
sqlane.handle(pingWebhook, runPing); // the process concurrency only

await sqlane.start();

// Tests: run the ready jobs until none is left, without start()
await sqlane.drain({ timeout: '10s' });

// Shutdown
await sqlane.close({ deadline: '30s', mode: 'release' }); // 'release' | 'abandon'
```

Choices:

- **Definition apart from the handler.** Producers import a small definition, not the handler and its dependencies.
  `enqueue` and `handle` take a definition or a name.
- **No payload types, no validation.** A payload is a `JsonValue`: a `Date`, a `Map` or a class instance is a type
  error. At runtime: `JSON.stringify` and the size limit, no revivers. The app validates its own payloads.
- **Enqueue by name too.** `enqueue(conn, 'job_name', …)` is for producers without the definition (another service,
  a script). It uses the definition in `jobs` (or registered by `handle()`), else the defaults; then `mutexKeys` and
  `failureJob` come only from the enqueue options. `unknownJobs: 'reject'` makes an unknown name an error.
- **One adapter, raw connections.** The adapter gives the dialect and the queue's pool. `enqueue` takes the driver's
  own connection, transaction client or pool (a pool means autocommit, outside any transaction). Adapters:
  `@sqlane/core/mysql2` (`Connection`, `PoolConnection`, `Pool`) and `@sqlane/core/pg` (`Client`, `PoolClient`,
  `Pool`) in v0.1; Knex, Kysely, Drizzle, Sequelize, Prisma, TypeORM, MikroORM later, as separate packages
  (`@sqlane/knex`, …).
- **Worker settings in worker code.** `concurrency` and `lane` are `handle()` options, not definition fields: they are
  per process. A handler takes `concurrency` (a private lane) or `lane` (a lane of `lanes`), not both (a type error).
  An unknown lane is a type error and a runtime error. A lane is capped by the process `concurrency`.
- **Handlers own their transactions.** sqlane does not wrap the handler in a transaction or any other app wrapper. A
  handler that needs one opens it with its own connection. Its return value is ignored: no result storage.
- **AbortSignal** for timeouts and close, instead of a hidden race. The lease is renewed while the handler runs, so a
  long job needs no timeout.
- **Durations** as strings (`'5s'`) or milliseconds.
- **No implicit work.** `createSqlane` connects, migrates and starts nothing.
- **Lifecycle.** `enqueue` and `enqueueMany` keep working after `close()` (they use only the caller's connection);
  `start`, `handle` and `drain` throw `ClosedError`.

### Defaults

| Option        | Default                                                             |
| ------------- | ------------------------------------------------------------------- |
| `maxAttempts` | 3                                                                   |
| `backoff`     | `{ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 }` |
| `retention`   | `{ completed: '1h', failed: '30d' }`                                |
| `timeout`     | none                                                                |

Backoff: `exponential` (`delay × 2^(attempt − 1)`, at most `maxDelay`) or `fixed` (`delay`). Then jitter (0–1):
`delay × (1 − jitter × random())`, never above the computed delay. `jitter: 0` turns it off.

### Errors

All extend `SqlaneError` and have a `code`:

| Class                  | When                                                     |
| ---------------------- | -------------------------------------------------------- |
| `PayloadTooLargeError` | The payload is above `maxPayloadBytes`.                  |
| `InvalidMutexKeyError` | More than 10 keys, or a key that breaks the rules.       |
| `UnknownJobError`      | Enqueue of an unknown name with `unknownJobs: 'reject'`. |
| `ClosedError`          | `start`, `handle` or `drain` after `close()`.            |

Thrown by handlers:

- `new FatalJobError(message, { cause })`: fail at once, without retries; the failure job runs.
- `new RetryJobError(message, { delay: '1m' })`: retry after this delay instead of the backoff (e.g. a rate limit).
  It still uses an attempt.

## Data

Three tables per prefix (default `sqlane_`), snake_case. Times use the DB clock only (`NOW(3)` /
`clock_timestamp()`): no clock skew between processes.

### `sqlane_jobs`

| Column                                                                | Type              | Notes                                                     |
| --------------------------------------------------------------------- | ----------------- | --------------------------------------------------------- |
| `id`                                                                  | varchar(255), PK  | `<job_name>:<job_id>`, or a new ULID without `jobId`.     |
| `job_name`                                                            | varchar(128)      |                                                           |
| `status`                                                              | varchar(16)       | `pending`, `running`, `completed`, `failed`.              |
| `run_at`                                                              | timestamp(3)      | Due time.                                                 |
| `attempts`, `max_attempts`                                            | int               |                                                           |
| `stalls`, `max_stalls`                                                | int               |                                                           |
| `has_mutex_keys`                                                      | boolean           | Avoids a join for the jobs without keys.                  |
| `lock_token`                                                          | char(26) null     | Set by the claim. Every final write checks it.            |
| `locked_by`                                                           | varchar(255) null | `<host>:<pid>:<ULID>`.                                    |
| `locked_until`                                                        | timestamp(3) null | The lease.                                                |
| `last_error`                                                          | json null         |                                                           |
| `failed_retention_ms`                                                 | bigint            | Copied at enqueue: the fail does not need the definition. |
| `created_at`, `started_at`, `finished_at`, `expires_at`, `updated_at` | timestamp(3)      |                                                           |

Indexes:

- MySQL: `(status, job_name, run_at)`, `(expires_at)`.
- PostgreSQL: partial `(job_name, run_at) WHERE status = 'pending'`, partial `(locked_until) WHERE status = 'running'`,
  `(expires_at)`.

### `sqlane_payloads`

`id` (PK), `payload` (json). Apart from the hot table: the claim and the probe do not read it.

### `sqlane_job_keys`

`job_id`, `mutex_key`, PK `(mutex_key, job_id)`, index `(job_id)`. The keys of each job, written at enqueue. A table,
not a JSON column: the FIFO query is a plain join on both databases, without `JSON_TABLE`.

### `sqlane_mutexes`

`mutex_key` (PK), `job_id`, `lock_token`, `held_until` (null: held by a running job), `created_at`. One row per key
that a job holds, or that lingers after a release on close.

### Migrations

sqlane ships its schema as versioned SQL per dialect. Two ways to apply it:

- `sqlane.migrate()`: applies the missing versions, records them in `sqlane_migrations`, under a DB lock (`GET_LOCK` /
  `pg_advisory_lock`).
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

In the caller's transaction, with its connection:

1. Check the payload (JSON, at most `maxPayloadBytes`, default 256 KiB) and the options (`jobId`, `maxAttempts`,
   `delay` or `runAt`, `mutexKeys`).
2. The mutex keys: the enqueue option if given, else the definition's function of the payload.
3. `INSERT` the job, the payload and the keys. With a `jobId`, an existing row means a duplicate: the enqueue returns
   `{ id, created: false }` and adds nothing. Deduplication lasts while the row exists, in any state: the retention
   is the dedupe window. After cleanup, the same `jobId` adds a new job.
4. PostgreSQL with the NOTIFY hint: `pg_notify` in the same transaction, delivered on commit.

`enqueueMany` inserts many jobs in one statement per table.

### Dispatcher: one loop per process

```text
loop while started
  names = registered job names whose lane has a free slot (none if `concurrency` handlers run)
  if no names: wait for a wake
  probe: the next run_at of each job name that has pending jobs (one statement)
  if nothing due: wait until the next run_at (at most the poll interval) or a wake
  claim the oldest due jobs, at most the free slots of each lane and of the process
  claimed: start the handlers, loop at once
  none (other processes took them): back off 10–200 ms
```

**The probe is the key to cheap idle names.** One statement reads only the names that have pending rows:

- MySQL: `SELECT job_name, MIN(run_at) FROM sqlane_jobs WHERE status = 'pending' GROUP BY job_name`. With the index
  `(status, job_name, run_at)`, MySQL uses a loose index scan: one index dive per pending name.
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

- **Default, any driver: re-probe.** After an enqueue, the dispatcher of this process probes only that job name again
  with a short backoff (about 20, 50, 100, 200 ms … up to the poll interval), until it sees the job. The hint transport
  sends the name to the other processes at enqueue time; they do the same. Throttled per job name: a burst of
  enqueues gives one series of re-probes. The latency is the commit time plus at most one backoff step, and never more
  than the poll interval. A rolled-back transaction costs only the re-probes.
- **PostgreSQL NOTIFY.** `pg_notify` runs in the transaction and is delivered on commit: no re-probe.
- **`@sqlane/<orm>` adapters.** They wake from the after-commit hook of the ORM, where it has one.
- **`sqlane.wake(name)`** stays public as a low-level escape hatch. The docs never require it.

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
  enqueue. A process sends a hint only for the jobs it cannot start itself.
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
4. Read the payloads, start the handlers.

### Leases and stalls

- The process renews the leases of its running jobs every 30 s, in one statement.
- Every final write (complete, retry, fail, release) has `WHERE lock_token = :own`. A process that lost its lease
  changes nothing.
- Stall recovery (each process, every 30 s, in small batches with SKIP LOCKED): a `running` job whose lease ended
  gets one more stall and goes back to `pending` with a delay of 30 s × 2^stalls (at most 1 h). After `maxStalls`
  (default 2), the next stall fails it.
- A failed DB write of a result is retried for up to 10 min, while the lease is renewed.

### Mutex keys

- At most 10 keys per job, 1–255 printable ASCII characters. The keys are global strings: jobs of different names
  share them.
- **Hold.** The claim inserts one `sqlane_mutexes` row per key, in the claim transaction: a job holds all its keys or
  none. Every transition out of `running` deletes them in the same transaction. Keys are locked in ascending order:
  no deadlocks between queue transactions.
- **FIFO per key.** A job starts only if none of its keys is held and no older due job has one of its keys. A job
  with keys A and B does not starve behind newer jobs of A or B.
- **Window.** The FIFO looks at the oldest 500 due jobs of each keyed name. More than 500 due jobs on one key delay
  the jobs behind them: coalesce such jobs.
- **Timeout and close.** A timeout does not end a handler: the job keeps its keys until the handler settles (at most
  the lease). On a release, the keys linger until the job may run again (`held_until`): the old and new runs never
  overlap.
- **A keyed job needs a timeout.** The lease is renewed while a handler runs, so a hung keyed handler would hold its
  keys in the whole cluster forever. `handle()` throws if the definition has `mutexKeys` and no timeout is set (in the
  definition, `defaults` or the `handle()` options). A job with keys only from the enqueue options, on a handler
  without a timeout, uses the lease (4 min) as its timeout.

### Failure jobs

When a job fails for good (no attempts left, or too many stalls), and its definition has `failureJob`:

- The fail and the insert of the failure job commit together. The insert runs under a savepoint: if the database
  refuses it, the job still fails, without it (`error` log, `failure_job_not_added` event).
- Payload (`FailedJobPayload`): `{ job: { id, name, payload, attempt, maxAttempts }, error: { name, message, stack } }`.
- A `FatalJobError` fails the job at once, with the same failure job.
- The failure job is an ordinary job with its own definition, attempts, retention and mutex keys. A failure job cannot
  have a `failureJob` (checked at `start()`).
- A replayed fail (lost acknowledgment) or a lost lease adds no second failure job.

### Close

`close({ deadline, mode })` stops claiming and waits for the running handlers until the deadline. Then, for each
unfinished job:

| `mode`    | Effect                                                                                       |
| --------- | -------------------------------------------------------------------------------------------- |
| `release` | Back to `pending`, no attempt used, `run_at` after the deadline. Its keys linger until then. |
| `abandon` | Nothing written. The lease ends, recovery counts one stall. For crashes.                     |

The handlers get an aborted `signal`.

### Cleanup

Built in, no cron: each process deletes the completed and failed jobs after their retention, every 5 min, in batches
of 1000, with SKIP LOCKED, so processes share the work. Off with `cleanup: false`.

### Connections

- `enqueue`: the caller's connection or transaction.
- Everything else: the adapter's pool (small, `READ COMMITTED`, statement timeout 10 s).
- Handlers: whatever they open. `concurrency` limits the running handlers of a process, so they cannot exhaust the
  app's pool.

## Guarantees

| Guarantee                                                              | Mechanism                                     |
| ---------------------------------------------------------------------- | --------------------------------------------- |
| A job exists only if the caller's transaction commits.                 | INSERT in the caller's transaction.           |
| A job does not start before its data is visible.                       | Other connections see only committed rows.    |
| A committed job runs at least once.                                    | Leases, stall recovery, release on close.     |
| Only the current owner saves the result of a job.                      | SKIP LOCKED claim, `lock_token` on writes.    |
| A job with a `jobId` is added once while its row exists.               | Primary key `<job_name>:<job_id>`.            |
| Two jobs with a common mutex key do not run at the same time.          | `sqlane_mutexes` primary key, claim.          |
| A job that fails for good adds its failure job (if the DB accepts it). | INSERT in the fail transaction.               |
| A lost hint does not lose a job.                                       | Hints only wake; the database keeps the jobs. |

## Observability

- **Logs:** an injected pino-compatible logger, for internal diagnostics (probe errors, reconnects). No logger: no
  logs.
- **Events:** `onEvent(event)`, a typed union by `type`, for the job lifecycle: `claimed`, `completed`, `retried`, `failed`, `stalled`, `released`,
  `lease_lost`, `failure_job_not_added`, `error`. The app maps them to its metrics.
- **Gauges:** `getStats()` returns the pending, due, running and failed counts and the oldest due age per job name,
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

Source (`src/`, snake_case files): `define_job.js`, `sqlane.js` (facade), `dispatcher.js`, `lanes.js`,
`lease_keeper.js`, `stall_recovery.js`, `cleanup.js`, `errors.js`, `store/` (one SQL module per dialect behind one
store interface), `adapters/`.

## Testing

- Unit: dispatcher, lanes, backoff, option checks, with an in-memory store fake.
- Types: the examples (`examples/`) and type tests (`expectTypeOf`, `@ts-expect-error`) run in CI, so the public API
  cannot change by accident.
- Integration (most of the value): the same suite against MySQL 8.4 and PostgreSQL 15 and 18 in Docker, for the
  store and the runner: claims under contention, leases, stalls, mutex FIFO, failure jobs, close modes.
- Benchmark: 1000 idle names (probe cost), enqueue-to-start latency, throughput.
