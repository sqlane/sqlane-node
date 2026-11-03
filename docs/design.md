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
| **Job definition** | The name, the payload type and the enqueue options of a job name. Producers import it.      |
| **Handler**        | The function that runs a job. Only workers register it.                                     |
| **Lane**           | A concurrency limit inside one process. Costs no connection.                                |
| **Mutex key**      | A string (`order:42`). Jobs with a common key run one at a time, in the cluster.            |
| **Failure job**    | The job that a job adds when it fails for good.                                             |
| **Executor**       | A minimal adapter over a connection or a transaction: `query(sql, params)`.                 |
| **Hint**           | A message "jobs of these names are ready" between processes. Only an optimization.          |

## API sketch

```js
// jobs/build_report.js: the definition, imported by producers and workers
import { defineJob } from '@sqlane/core';

/** @type {import('@sqlane/core').JobDefinition<{ reportId: string }>} */
export const buildReport = defineJob({
    name: 'build_report',
    attempts: 3,
    backoff: { type: 'exponential', delay: '5s', maxDelay: '1h' },
    mutexKeys: ({ reportId }) => [`report:${reportId}`], // optional, sync, from the payload only
    failureJob: 'fail_report', // optional
    retention: { completed: '1h', failed: '180d' },
});
```

```js
// app.js
import { createSqlane } from '@sqlane/core';
import { mysql2Executor } from '@sqlane/core/mysql2';

const sqlane = createSqlane({
    dialect: 'mysql', // or 'postgres'
    executor: mysql2Executor(queuePool), // the queue's own connections: claims, leases, results
    tablePrefix: 'sqlane_',
    hint: null, // or redisHint(redis), postgresNotifyHint(client)
    logger, // pino-compatible: { debug, info, warn, error }
    metrics, // optional event callbacks
    pollInterval: '5s',
    maxPayloadBytes: 256 * 1024,
    cleanup: true, // built-in deletion of expired jobs
});

// Producer: in the business transaction
const tx = mysql2Executor(transactionConnection);

await sqlane.enqueue(tx, buildReport, { reportId }, { jobId: reportId, delay: '10s' });
// Or by name: the definition registered in this instance, or the defaults (no payload type check)
await sqlane.enqueue(tx, 'build_report', { reportId });

// Worker
sqlane.handle(buildReport, async ({ payload, job, signal }) => {
    // signal: AbortSignal, aborted on timeout and on close
}, { lane: 'reports', timeout: '5m' });

sqlane.defineLane('reports', { concurrency: 2 });

await sqlane.start({ maxRunningJobs: 10 });

// Shutdown
await sqlane.close({ deadline: '30s', mode: 'release' }); // 'release' | 'abandon'
```

Choices:

- **Definition apart from the handler.** Producers import a small definition, not the handler and its dependencies.
  The definition carries the payload type (JSDoc generic), so `enqueue` checks the payload.
- **Enqueue by name too.** `enqueue(tx, 'job_name', …)` is for producers without the definition (another service,
  a script). It uses the definition registered in the instance (`sqlane.register([definitions])` or `handle()`),
  else the defaults; then `mutexKeys` and `failureJob` come only from the enqueue options.
- **Explicit executor, no implicit context.** `enqueue` takes the transaction. Adapters: `@sqlane/core/mysql2` and `@sqlane/core/pg` in v0.1;
  Knex, Kysely, Drizzle, Sequelize, Prisma, TypeORM, MikroORM later, as separate packages (`@sqlane/knex`, …).
- **Handlers own their transactions.** sqlane does not wrap the handler in a transaction or any other app wrapper. A
  handler that needs one opens it with its own connection.
- **AbortSignal** for timeouts and close, instead of a hidden race.
- **Durations** as strings (`'5s'`) or milliseconds.

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

In the caller's transaction, through its executor:

1. Validate the payload (JSON, at most `maxPayloadBytes`, default 256 KiB) and the options (`jobId`, `attempts`,
   `delay`).
2. Compute the mutex keys from the payload.
3. `INSERT` the job, the payload and the keys. With a `jobId`, an existing row means a duplicate: the enqueue returns
   `{ id, duplicate: true }` and adds nothing. Deduplication lasts while the row exists, retention included.
4. PostgreSQL with the NOTIFY hint: `pg_notify` in the same transaction, delivered on commit.

`enqueueMany` inserts many jobs in one statement per table.

### Dispatcher: one loop per process

```text
loop while started
  names = registered job names whose lane has a free slot (none if maxRunningJobs run)
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

```js
/** @typedef {{ publish(jobNames: string[]): Promise<void>, subscribe(onHint: (jobNames: string[]) => void): Promise<() => Promise<void>> }} HintTransport */
```

- `null`: polling only.
- `postgresNotifyHint(client)`: LISTEN on a dedicated connection; the enqueue sends `pg_notify` in its transaction, so
  the hint arrives only after the commit. At most one NOTIFY per transaction and job name: NOTIFY takes a global lock
  at commit and limits the commit rate under heavy write load.
- `redisHint(redis)`: publish after an enqueue. A process sends a hint only for the jobs it cannot start itself.
- Throttled: at most one message per interval (100 ms) per process.

A lost hint delays a job until the next poll. It never loses a job.

### Claim

One short transaction on the queue's executor:

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
- A keyed handler must have a timeout of at most the lease.

### Failure jobs

When a job fails for good (no attempts left, or too many stalls), and its definition has `failureJob`:

- The fail and the insert of the failure job commit together. The insert runs under a savepoint: if the database
  refuses it, the job still fails, without it (`error` log, `failure_job_not_added` event).
- Payload: `{ payload, failedJob: { id, jobName, attempts, stalls, error: { name, message, stack } } }`.
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

- `enqueue`: the caller's transaction.
- Everything else: the queue's executor (a small pool, `READ COMMITTED`, statement timeout 10 s).
- Handlers: whatever they open. `maxRunningJobs` limits the running handlers of a process, so they cannot exhaust the
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

- **Logs:** an injected pino-compatible logger. No logger: no logs.
- **Events:** `onEvent({ type, jobName, … })` for `claimed`, `completed`, `retried`, `failed`, `stalled`, `released`,
  `lease_lost`, `failure_job_not_added`, `error`. The app maps them to its metrics.
- **Gauges:** `getStats()` returns the pending, due, running and failed counts and the oldest due age per job name,
  for "queue stuck" alerts. OpenTelemetry later, as a separate package.

## Supported versions

| Component  | Minimum                                      | Why                                                                        |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| Node.js    | 22.12                                        | Node 22, 24 and 26 in CI.                                                  |
| MySQL      | 8.4 LTS                                      | 8.0 reached end of life (April 2026). SKIP LOCKED, window functions, CTEs. |
| PostgreSQL | 15                                           | 14 reaches end of life in November 2026.                                   |
| Drivers    | `mysql2`, `pg`; peer dependencies, optional. |

## Package layout

```text
@sqlane/core              core: definitions, runner, dispatcher, SQL of both dialects, migrations
@sqlane/core/mysql2       executor adapter for mysql2
@sqlane/core/pg           executor adapter for pg, postgresNotifyHint
@sqlane/core/redis        redisHint (ioredis or node-redis)
@sqlane/<orm>             later: knex, kysely, drizzle, sequelize, prisma, typeorm, mikro-orm
```

Source (`src/`, snake_case files): `define_job.js`, `sqlane.js` (facade), `dispatcher.js`, `lanes.js`,
`lease_keeper.js`, `stall_recovery.js`, `cleanup.js`, `store/` (one SQL module per dialect behind one store
interface), `adapters/`, `hints/`.

## Testing

- Unit: dispatcher, lanes, backoff, validation, with an in-memory store fake.
- Integration (most of the value): the same suite against MySQL 8.4 and PostgreSQL 15 and 18 in Docker, for the
  store and the runner: claims under contention, leases, stalls, mutex FIFO, failure jobs, close modes.
- Benchmark: 1000 idle names (probe cost), enqueue-to-start latency, throughput.
