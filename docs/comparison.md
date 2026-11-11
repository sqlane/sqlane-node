# Compare job queues

sqlane next to five job queues for Node.js: what each does, checked by running it. For the CPU cost and latency of the
queues that enqueue in your transaction, see [performance](comparison-performance.md).

| Library                                                          | Version | License           |
| ---------------------------------------------------------------- | ------- | ----------------- |
| sqlane                                                           | 2.0.1   | MIT               |
| [pg-boss](https://github.com/timgit/pg-boss)                     | 12.38.2 | MIT               |
| [Graphile Worker](https://github.com/graphile/worker)            | 0.18.0  | MIT               |
| [BullMQ](https://github.com/taskforcesh/bullmq)                  | 6.7.4   | MIT               |
| [Sidequest](https://github.com/sidequestjs/sidequest)            | 1.17.0  | LGPL-3.0-or-later |
| [River for JavaScript](https://github.com/riverqueue/river) (JS) | 0.3.2   | MPL-2.0           |

Checked on 11 November 2026. River's Go library and the commercial editions (BullMQ Pro, River Pro) are not compared.
The rows marked **checked** come from scenarios that `pnpm bench:compare --only checks` runs against each library on
PostgreSQL 17 ([how](../bench/compare/README.md#checks)); the others from each library's documentation and types.

## Pick by requirement

| You need                                                                        | Consider                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------- |
| Jobs that commit or roll back with your data, on MySQL or MariaDB               | sqlane                                      |
| The same on PostgreSQL                                                          | sqlane, pg-boss, Graphile Worker, River     |
| Jobs that must not overlap when they touch the same resources, across job names | sqlane                                      |
| Cron with a catch-up of missed runs                                             | Graphile Worker, pg-boss                    |
| Priorities                                                                      | pg-boss, Graphile Worker, BullMQ, River     |
| A dashboard                                                                     | pg-boss, BullMQ, Sidequest, River           |
| Redis, workflows of parent and child jobs, a large ecosystem                    | BullMQ                                      |
| SQLite or MongoDB                                                               | Sidequest (SQLite, MongoDB), River (SQLite) |

## Capabilities

**Yes**: it works as described. **Partial**: it works with a workaround or a fixed setting (see the notes). **No**: no
such option, or the scenario failed.

| Capability                                            | sqlane | pg-boss  | Graphile Worker | BullMQ           | Sidequest       | River  |
| ----------------------------------------------------- | ------ | -------- | --------------- | ---------------- | --------------- | ------ |
| Enqueue in the caller's transaction (checked)         | Yes    | Yes      | Yes             | No               | No              | Yes    |
| Delayed job (checked)                                 | Yes    | Yes      | Yes             | Yes              | Yes             | Yes    |
| Retry after a configured backoff (checked)            | Yes    | Yes      | Partial¹        | Yes              | Yes             | Yes    |
| Timeout that aborts the handler (checked)             | Yes    | Yes      | No              | No               | Yes             | Yes    |
| The job of a killed worker runs again (checked)       | Yes    | Yes      | No²             | Yes              | Yes             | Yes    |
| Exclusion by one resource, across job names (checked) | Yes    | Partial³ | Yes⁴            | No               | No              | No     |
| Exclusion by several resources per job (checked)      | Yes    | No       | No              | No               | No              | No     |
| Priority (checked)                                    | No     | Yes      | Yes             | Yes              | Partial⁵        | Yes    |
| Cron                                                  | No     | Yes      | Yes             | Yes              | Yes             | Yes    |
| Dashboard                                             | No     | Yes⁶     | No              | Yes⁷             | Yes             | Yes⁸   |
| PostgreSQL                                            | Yes    | Yes      | Yes             | Yes              | Yes             | Yes    |
| MySQL, MariaDB                                        | Both   | No       | No              | No               | MySQL           | No     |
| Other storage                                         | —      | —        | —               | Redis-compatible | SQLite, MongoDB | SQLite |

1. The backoff is fixed: about e^attempt seconds. A 2 s backoff gave 3 s.
2. A job locked by a worker that died is unlocked after 4 hours, a setting that the library does not expose. It did not
   run again within 70 s.
3. One group per job, and the job names must share one queue (`groupConcurrency: 1`): the handler dispatches by name.
4. `queue_name`: one queue per resource, its jobs run one at a time across task identifiers. One queue per job.
5. Sidequest has priorities of queues, not of jobs: the check used a queue per priority.
6. [`@pg-boss/dashboard`](https://www.npmjs.com/package/@pg-boss/dashboard), MIT.
7. [bull-board](https://github.com/felixmosh/bull-board), community, MIT; [Taskforce.sh](https://taskforce.sh),
   commercial.
8. [River UI](https://github.com/riverqueue/riverui), a separate binary: River's JavaScript and Go libraries share the
   database protocol.

## What differs

### Enqueue in your transaction

The job and your business rows commit together, or neither does; workers see the job only after the commit. The check
inserts an order and enqueues a job in two transactions, and rolls back the first: with sqlane, pg-boss, Graphile
Worker and River only the job of the committed order ran. BullMQ and Sidequest have no API that takes your connection:
their enqueue commits on its own, so the job of the rolled-back order ran too.

| Library         | In your transaction                                                                       | Drivers and ORMs                              |
| --------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| sqlane          | `sqlane.enqueue(tx, job, payload)`                                                        | 10 adapters, see [adapters](adapters.md)      |
| pg-boss         | `boss.send(name, data, { db: { executeSql: (text, values) => tx.query(text, values) } })` | any, through `executeSql`                     |
| Graphile Worker | `SELECT graphile_worker.add_job(...)` on your client                                      | any that runs SQL                             |
| River           | `client.insert(job, args, { tx })`                                                        | node-postgres, Knex, Prisma (driver packages) |

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

| Library         | Default                                          | In the check                             |
| --------------- | ------------------------------------------------ | ---------------------------------------- |
| sqlane          | Lease of 4 minutes, then a stall backoff of 30 s | 34 s, with a test-only lease of 3 s      |
| pg-boss         | `expireInSeconds`: 15 minutes                    | 2.5 s, `expireInSeconds: 2`              |
| Graphile Worker | 4 hours                                          | Not within 70 s                          |
| BullMQ          | `lockDuration`, `stalledInterval`: 30 s          | 2 s                                      |
| Sidequest       | Stale after 10 minutes, checked every 60 minutes | 27 s, checked every minute (its minimum) |
| River           | `rescueAfter`: 1 hour, for jobs with a timeout   | 18 s, `rescueAfter: 3 s`                 |

sqlane's lease is renewed while the handler runs, so it bounds the delay after a crash, not the length of a job. Its
handlers get a `timeout` and an abort signal for that.

### Cron

Cron is not one guarantee:

- pg-boss stores the schedules in the database; a missed run is skipped or run once (`scheduleMissedPolicies`).
- Graphile Worker's crontab can backfill the runs missed while no worker ran (`backfillPeriod`).
- BullMQ's job schedulers create the next job when the previous one starts.
- Sidequest schedules with node-cron in the process that registers the job.
- River's leader inserts the periodic jobs of its configuration; `runOnStart` runs one at start.

sqlane has no cron yet: see the [roadmap](../README.md#roadmap). Sources: [pg-boss](https://pgboss.io/api/scheduling),
[Graphile Worker](https://worker.graphile.org/docs/cron), [BullMQ](https://docs.bullmq.io/guide/job-schedulers),
[Sidequest](https://docs.sidequestjs.com/guide/jobs/recurring), [River](https://riverqueue.com/docs/periodic-jobs).

## Where sqlane is weaker

- No priorities, no cron and no dashboard.
- The lease of a running job is 4 minutes, not configurable: the job of a crashed worker waits for it.
- The FIFO of a mutex key looks at the jobs of the names that a process handles; on PostgreSQL at the first 100 due jobs
  of a key ([design](design.md#mutex-keys)).
- First released in 2026, no known production users yet. The others have longer operating histories.

## Reproduce

```sh
pnpm bench:compare --only checks
```

About 1.5 minutes on PostgreSQL from Homebrew. The adapters in `bench/compare/libs/` show how each library was
configured, and each check's note in `bench/compare/results.json` says what it saw. See
[bench/compare](../bench/compare/README.md).
