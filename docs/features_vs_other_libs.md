# Compare job queues

sqlane next to seven job queues for Node.js. The rows marked 🔬 come from scenarios that run against each library
([how](../bench/compare/README.md#checks)); the others from each library's documentation and types. For CPU cost,
latency and idle cost, see [performance](performance_vs_other_libs.md).

## Pick by requirement

| You need                                                                        | Consider                                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Jobs that commit or roll back with your data, on MySQL or MariaDB               | sqlane; by their documentation, Boring Node Queue (Knex), Izi Queue (MySQL) |
| The same on PostgreSQL                                                          | sqlane, pg-boss, Graphile Worker, River, Boring Node Queue, Izi Queue       |
| Jobs that must not overlap when they touch the same resources, across job names | sqlane                                                                      |
| Cron with a catch-up of missed runs                                             | sqlane (the latest run), Graphile Worker (each run), pg-boss                |
| Priorities                                                                      | pg-boss, Graphile Worker, BullMQ, River, Boring Node Queue, Izi Queue       |
| A dashboard                                                                     | pg-boss, BullMQ, Sidequest, River                                           |
| Redis, workflows of parent and child jobs, a large ecosystem                    | BullMQ                                                                      |
| SQLite or MongoDB                                                               | Sidequest (SQLite, MongoDB), River, Boring Node Queue, Izi Queue (SQLite)   |

## Capabilities

✅ works as described · 🟠 works with a workaround or a fixed setting · ❌ no such option, or the scenario failed

| Capability                               | sqlane | pg-boss      | Graphile Worker  | BullMQ           | Sidequest       | River   | Boring Node Queue | Izi Queue      |
| ---------------------------------------- | ------ | ------------ | ---------------- | ---------------- | --------------- | ------- | ----------------- | -------------- |
| 🔬 Enqueue in the caller's transaction   | ✅     | ✅           | ✅               | ❌               | ❌              | ✅      | ✅                | ✅             |
| 🔬 Delayed job                           | ✅     | ✅           | ✅               | ✅               | ✅              | ✅      | ✅                | ✅             |
| 🔬 Retry after a configured backoff      | ✅     | ✅           | 🟠 fixed backoff | ✅               | ✅              | ✅      | ✅                | 🟠 1 s for 2 s |
| 🔬 Timeout that aborts the handler       | ✅     | ✅           | ❌               | ❌               | ✅              | ✅      | ✅                | ✅             |
| 🔬 Job of a killed worker runs again     | ✅     | ✅           | ❌ after 4 h     | ✅               | ✅              | ✅      | ✅                | ✅ after 60 s  |
| 🔬 Exclusion by a resource, across names | ✅     | 🟠 one queue | ✅ `queue_name`  | ❌ Pro only      | ❌              | ❌      | ❌                | ❌             |
| 🔬 Exclusion by several resources        | ✅     | ❌           | ❌               | ❌               | ❌              | ❌      | ❌                | ❌             |
| 🔬 Priority                              | ❌     | ✅           | ✅               | ✅               | 🟠 per queue    | ✅      | ✅                | ✅             |
| Cron                                     | ✅     | ✅           | ✅               | ✅               | ✅              | ✅      | ✅                | ✅             |
| Dashboard                                | ❌     | ✅           | ❌               | ✅               | ✅              | ✅      | ❌                | ❌             |
| PostgreSQL                               | ✅     | ✅           | ✅               | ✅               | ✅              | ✅      | ✅                | ✅             |
| MySQL and MariaDB                        | ✅     | ❌           | ❌               | ❌               | 🟠 MySQL only   | ❌      | ✅ Knex           | 🟠 MySQL only  |
| Other storage                            | —      | —            | —                | Redis-compatible | SQLite, MongoDB | SQLite  | Redis, SQLite     | SQLite         |
| License                                  | MIT    | MIT          | MIT              | MIT              | LGPL-3.0        | MPL-2.0 | MIT               | MIT            |

Notes:

- **Graphile Worker:** the backoff is about e^attempt seconds; a 2 s backoff gave 3 s. A job locked by a worker that died
  is unlocked after 4 hours, a setting that the library does not expose: it did not run again within 70 s.
- **pg-boss** excludes by one group per job, and the job names must share one queue (`groupConcurrency: 1`): the
  handler dispatches by name.
- **Graphile Worker's** `queue_name` runs its jobs one at a time across task identifiers: one queue per resource, and
  one queue per job.
- **Sidequest** has priorities of queues, not of jobs: the check used a queue per priority.
- **Boring Node Queue** 0.9.1, with its Knex adapter: its enqueue takes a Knex transaction (`.with(knex(trx))`), and
  it runs on MySQL and MariaDB through Knex too. 0.10.0 adds LISTEN/NOTIFY on PostgreSQL, but was younger than the 7
  days that the harness requires of a release.
- **Izi Queue:** its README gives the result of a custom backoff in seconds, but 0.10.0 uses it as milliseconds: a 2 s
  backoff became 2 ms, and the retry came when its leader staged the retries, after 1 s. A dead node is presumed after 4
  missed heartbeats and 60 s at least, so its jobs ran again after 60 s. Its README says MariaDB is not supported.
- **Dashboards:** pg-boss [`@pg-boss/dashboard`](https://www.npmjs.com/package/@pg-boss/dashboard) (MIT); BullMQ
  [bull-board](https://github.com/felixmosh/bull-board) (community, MIT) or [Taskforce.sh](https://taskforce.sh)
  (commercial); River [River UI](https://github.com/riverqueue/riverui), a separate binary, since River's JavaScript
  and Go libraries share the database protocol.

## When not to use sqlane

- You need **priorities or a dashboard** today.
- You need a **configurable recovery time** after a crash: the lease of a running job is 4 minutes, and the job of a
  crashed worker waits for it.
- You need **strict FIFO per mutex key** across every job name: it looks at the jobs of the names that a process
  handles, and on PostgreSQL at the first 100 due jobs of a key ([design](design.md#mutex-keys)).
- You need a **long production history**: sqlane was first released in 2026 and has no known production users yet.
  The others have run in production for years.

## What differs

### Enqueue in your transaction

The job and your business rows commit together, or neither does; workers see the job only after the commit. The check
inserts an order and enqueues a job in two transactions, and rolls back the first: with sqlane, pg-boss, Graphile
Worker, River, Boring Node Queue and Izi Queue only the job of the committed order ran. BullMQ and Sidequest have no
API that takes your connection:
their enqueue commits on its own, so the job of the rolled-back order ran too.

| Library           | In your transaction                                  | Drivers and ORMs                                                                                               |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| sqlane            | `sqlane.enqueue(tx, job, payload)`                   | mysql2, pg, postgres.js, Knex, Kysely, Drizzle, Prisma, Sequelize, TypeORM, MikroORM ([adapters](adapters.md)) |
| pg-boss           | `boss.send(name, data, { db: fromKnex(tx) })`        | Knex, Kysely, Drizzle, Prisma, PGlite, Bun SQL; any other through `executeSql`                                 |
| Graphile Worker   | `SELECT graphile_worker.add_job(...)` on your client | any that runs SQL                                                                                              |
| River             | `client.insert(job, args, { tx })`                   | node-postgres, Knex, Prisma (driver packages)                                                                  |
| Boring Node Queue | `Job.dispatch(payload).with(knex(trx))`              | Knex, Kysely                                                                                                   |
| Izi Queue         | `queue.insert(name, { args, tx: client })`           | node-postgres, mysql2, better-sqlite3                                                                          |

PostgreSQL only, except sqlane (also MySQL and MariaDB), Boring Node Queue (MySQL and MariaDB, SQLite) and Izi Queue
(MySQL, SQLite).

### Jobs that must not overlap

sqlane's mutex keys are strings on the job, such as `account:alice`. Two jobs that share a key never run at the same
time, across job names and processes, and a job can hold up to 10 keys: a transfer locks both accounts. The others have
one identity per job:

- pg-boss groups jobs within a queue (`group: { id }` with `groupConcurrency`), and `singletonKey` policies limit one
  job per key in a queue. Jobs of different names exclude each other only if they share a queue.
- Graphile Worker runs the jobs of a `queue_name` one at a time, across task identifiers. One queue per job.
- BullMQ (groups) and River (concurrency limits by argument) have this in their commercial editions only; River Pro is
  Go only.

With one identity per job, a key such as `alice:bob` does not exclude `alice:carol`: the check with two resources per
job failed for all but sqlane.

### When a worker dies

Every library holds a running job for a while, then gives it to another worker. The default wait, and the shortest that
the check could set:

| Library           | Default                                                                    | In the check                                                |
| ----------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| sqlane            | Lease of 4 minutes, then a stall backoff of 30 s                           | 34 s, with a test-only lease of 3 s                         |
| pg-boss           | `expireInSeconds`: 15 minutes                                              | 2.5 s, `expireInSeconds: 2`                                 |
| Graphile Worker   | 4 hours                                                                    | Not within 70 s                                             |
| BullMQ            | `lockDuration`, `stalledInterval`: 30 s                                    | 2 s                                                         |
| Sidequest         | Stale after 10 minutes, checked every 60 minutes                           | within a minute: its check runs once a minute (its minimum) |
| River             | `rescueAfter`: 1 hour, for jobs with a timeout                             | 18 s, `rescueAfter: 3 s`                                    |
| Boring Node Queue | `stalledThreshold`, `stalledInterval`: 30 s                                | 2 s                                                         |
| Izi Queue         | A node is dead after 4 missed heartbeats (60 s at least); Lifeline rescues | 60 s, `rescueAfter: 10 s` (its minimum)                     |

sqlane's lease is renewed while the handler runs, so it bounds the delay after a crash, not the length of a job. Its
handlers get a `timeout` and an abort signal for that.

### Cron

Cron is not one guarantee:

- sqlane: schedules in code. Every worker tries each slot, and a cursor row per schedule, locked in the enqueue
  transaction, lets one of them add the job, with no leader. A missed run is skipped or runs once (`missed`, default
  `once`; pg-boss, River and Graphile Worker skip by default). Time zones with fixed DST rules, with optional jitter.
- pg-boss stores the schedules in the database. Each instance's cron pass takes the cron time with a compare-and-set,
  then adds each run with a singleton key. A missed run is skipped by default, or run once (`scheduleMissedPolicies`).
- Graphile Worker's crontab can backfill the runs missed while no worker ran (`backfillPeriod`).
- BullMQ's job schedulers create the next job when the previous one starts; its id, the scheduler and the slot, makes
  a slot one job.
- Sidequest schedules with node-cron in each process that registers the job, not in the database: each process
  enqueues each run. Registering the schedule in one process avoids both the duplicates and the lost runs, without
  failover. With `unique({ period: 'minute' })`, which Sidequest's recurring-jobs page recommends when several
  instances schedule, `schedule()` computes the job and its unique key once, at registration (`Object.freeze`). The
  key holds the registration minute, so every later run collides with the first job's row and is rejected, even
  after that job completed ([performance](performance_vs_other_libs.md#schedules)).
- Boring Node Queue stores the schedules. A worker claims a due one with a row lock and sets its next run from the
  claim time: a missed run is skipped.
- Izi Queue's CronPlugin: the leader evaluates each minute, and each insert is unique on the entry and the minute. A
  late tick catches up to 5 minutes (`maxCatchUpMinutes`).
- River's leader inserts the periodic jobs of its configuration; `runOnStart` runs one at start.

Sources: [sqlane](api.md#schedule), [pg-boss](https://pgboss.io/api/scheduling),
[Graphile Worker](https://worker.graphile.org/docs/cron), [BullMQ](https://docs.bullmq.io/guide/job-schedulers),
[Sidequest](https://docs.sidequestjs.com/guide/jobs/recurring), [River](https://riverqueue.com/docs/periodic-jobs),
[Boring Node Queue](https://github.com/boringnode/queue), [Izi Queue](https://github.com/IagoCavalcante/izi-queue#cron--periodic-jobs).

## Versions and reproduce

Checked on 12 November 2026 on PostgreSQL 17: sqlane 4.0.1, [pg-boss](https://github.com/timgit/pg-boss) 12.38.2,
[Graphile Worker](https://github.com/graphile/worker) 0.18.0, [BullMQ](https://github.com/taskforcesh/bullmq) 6.7.4,
[Sidequest](https://github.com/sidequestjs/sidequest) 1.17.0, [River for JavaScript](https://github.com/riverqueue/river)
0.3.2, [Boring Node Queue](https://github.com/boringnode/queue) 0.9.1 and
[Izi Queue](https://github.com/IagoCavalcante/izi-queue) 0.10.0. River's Go library and the commercial editions
(BullMQ Pro, River Pro) are not compared.

```sh
pnpm bench:compare --only checks
```

About 1.5 minutes on PostgreSQL from Homebrew. The adapters in `bench/compare/libs/` show how each library was
configured, and each check's note in `bench/compare/results.json` says what it saw. See
[bench/compare](../bench/compare/README.md).
