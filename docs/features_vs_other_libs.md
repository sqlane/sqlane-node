# Features vs other libraries

sqlane and seven other job queues for Node.js, as a user of their public API sees them. Rows marked 🔬 were verified
by running the same scenario against each library ([method](../bench/compare/README.md#checks)); the others come from
each library's documentation and types. Versions are [at the bottom](#versions). For CPU, latency and idle cost, see
[performance vs other libraries](performance_vs_other_libs.md).

✅ yes · 🟠 partly, see the note · ❌ no

## Storage

|            | sqlane | pg-boss | Graphile Worker | BullMQ | Sidequest | River | Boring Node Queue | Izi Queue |
| ---------- | ------ | ------- | --------------- | ------ | --------- | ----- | ----------------- | --------- |
| PostgreSQL | ✅     | ✅      | ✅              | ✅     | ✅        | ✅    | ✅                | ✅        |
| MySQL      | ✅     | ❌      | ❌              | ❌     | ✅        | ❌    | ✅ ¹              | ✅        |
| MariaDB    | ✅     | ❌      | ❌              | ❌     | ❌        | ❌    | ✅ ¹              | ❌ ²      |
| SQLite     | ❌     | ❌      | ❌              | ❌     | ✅        | ✅    | ✅                | ✅        |
| Redis      | ❌     | ❌      | ❌              | ✅ ³   | ❌        | ❌    | ✅                | ❌        |
| MongoDB    | ❌     | ❌      | ❌              | ❌     | ✅        | ❌    | ❌                | ❌        |

1. Through its Knex adapter.
2. Its README says MariaDB is not supported.
3. Redis and Redis-compatible servers.

## Capabilities

| Capability                             | sqlane | pg-boss | Graphile Worker | BullMQ  | Sidequest | River   | Boring Node Queue | Izi Queue |
| -------------------------------------- | ------ | ------- | --------------- | ------- | --------- | ------- | ----------------- | --------- |
| 🔬 Enqueue in the caller's transaction | ✅     | ✅      | ✅              | ❌      | ❌        | ✅      | ✅                | ✅        |
| 🔬 Delayed job                         | ✅     | ✅      | ✅              | ✅      | ✅        | ✅      | ✅                | ✅        |
| 🔬 Retry after a configured backoff    | ✅     | ✅      | 🟠 ⁴            | ✅      | ✅        | ✅      | ✅                | 🟠 ⁵      |
| 🔬 Timeout that aborts the handler     | ✅     | ✅      | ❌              | ❌      | ✅        | ✅      | ✅                | ✅        |
| 🔬 Job of a killed worker runs again   | ✅     | ✅      | ❌ ⁶            | ✅      | ✅        | ✅      | ✅                | ✅        |
| 🔬 Mutex key across job names          | ✅     | 🟠 ⁷    | 🟠 ⁸            | ❌ ⁹    | ❌        | ❌ ⁹    | ❌                | ❌        |
| 🔬 Multiple mutex keys per job         | ✅     | ❌      | ❌              | ❌      | ❌        | ❌      | ❌                | ❌        |
| 🔬 Priority                            | ❌     | ✅      | ✅              | ✅      | 🟠 ¹⁰     | ✅      | ✅                | ✅        |
| Configurable crash-recovery time       | ❌     | ✅      | ❌ ⁹            | ✅      | ✅        | ✅      | ✅                | ✅ ¹¹     |
| Unique / deduplicated jobs             | ✅     | ✅      | ✅              | ✅      | 🟠 ¹²     | ✅      | ✅                | ✅        |
| Parent/child workflows                 | ❌     | ✅      | ❌              | ✅      | ❌        | ❌ ⁹    | ❌                | ❌        |
| Rate limiting                          | ❌     | 🟠 ¹³   | 🟠 ¹⁴           | ✅      | ❌        | ❌      | ❌                | ❌        |
| Cron                                   | ✅     | ✅      | ✅              | ✅      | ✅        | ✅      | ✅                | ✅        |
| Dashboard                              | ❌     | ✅ ¹⁵   | ❌              | ✅ ¹⁵   | ✅        | ✅ ¹⁵   | ❌                | ❌        |
| License                                | MIT    | MIT     | MIT             | MIT     | LGPL-3.0  | MPL-2.0 | MIT               | MIT       |
| First release                          | 2026   | 2016    | 2019            | 2019 ¹⁶ | 2025 ¹⁶   | 2026 ¹⁶ | 2025              | 2025      |

4. The backoff is fixed at about e^attempt seconds: a configured 2 s backoff gave 3 s.
5. Its README documents a custom backoff in seconds, but 0.10.0 treats it as milliseconds: a 2 s backoff became 2 ms,
   and the retry ran after about 1 s.
6. Only after 4 hours: the job didn't run again within the check's 70 s.
7. Within one queue only (`group: { id }` with `groupConcurrency: 1`), so the job names must share a queue.
8. `queue_name` runs its jobs one at a time across task identifiers, but a job has only one queue name.
9. In the paid edition only: BullMQ Pro (groups), River Pro (concurrency limits by argument, workflows; Go only),
   Graphile Worker Pro (recovery settings).
10. Priorities are per queue, not per job.
11. With its `LifelinePlugin`.
12. The key is the job class, optionally with all its arguments; there is no custom key.
13. At enqueue only: `sendThrottled` / `singletonSeconds` accept one job per key per time window and reject the rest.
14. Not built in; the docs point to the community package `graphile-worker-rate-limiter`.
15. A separate package: pg-boss [`@pg-boss/dashboard`](https://www.npmjs.com/package/@pg-boss/dashboard) (MIT);
    BullMQ [bull-board](https://github.com/felixmosh/bull-board) (community, MIT) or [Taskforce.sh](https://taskforce.sh)
    (commercial); River [River UI](https://github.com/riverqueue/riverui), a separate binary.
16. The year of the first working release of the current library. Earlier npm versions exist: BullMQ's npm name was
    used by an unrelated package in 2015, Sidequest published pre-release builds from 2018, and River's 2023 versions
    are empty placeholders.

## Enqueue in your transaction

| Library           | In your transaction                                  | Drivers and ORMs                                                                                               |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| sqlane            | `sqlane.enqueue(tx, job, payload)`                   | mysql2, pg, postgres.js, Knex, Kysely, Drizzle, Prisma, Sequelize, TypeORM, MikroORM ([adapters](adapters.md)) |
| pg-boss           | `boss.send(name, data, { db: fromKnex(tx) })`        | Knex, Kysely, Drizzle, Prisma, PGlite, Bun SQL; any other through `executeSql`                                 |
| Graphile Worker   | `SELECT graphile_worker.add_job(...)` on your client | any that runs SQL                                                                                              |
| River             | `client.insert(job, args, { tx })`                   | node-postgres, Knex, Prisma (driver packages)                                                                  |
| Boring Node Queue | `Job.dispatch(payload).with(knex(trx))`              | Knex, Kysely                                                                                                   |
| Izi Queue         | `queue.insert(name, { args, tx: client })`           | node-postgres, mysql2, better-sqlite3                                                                          |
| BullMQ            | — no API takes your connection                       | —                                                                                                              |
| Sidequest         | — no API takes your connection                       | —                                                                                                              |

🔬 An order is inserted and a job enqueued in each of two transactions, and the first one is rolled back. With
sqlane, pg-boss, Graphile Worker, River, Boring Node Queue and Izi Queue, only the committed order's job ran. With
BullMQ and Sidequest, the rolled-back order's job ran too.

## When a worker dies

How long until another worker runs the job of a crashed worker.

| Library           | Option                                                                                      | Default                                                  | 🔬 Shortest the check could set         |
| ----------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| sqlane            | — not configurable                                                                          | 4 min lease, found within 30 s, run again 30 s later     | 34 s ¹⁷                                 |
| pg-boss           | `expireInSeconds`, per queue or job                                                         | 15 min                                                   | 2.5 s, `expireInSeconds: 2`             |
| Graphile Worker   | — not configurable (Graphile Worker Pro only)                                               | 4 h                                                      | not within 70 s                         |
| BullMQ            | `lockDuration`, `stalledInterval`                                                           | 30 s, checked every 30 s                                 | 2 s                                     |
| Sidequest         | `releaseStaleJobsMaxStaleMs`, `releaseStaleJobsIntervalMin`                                 | stale after 10 min, checked every 60 min                 | within a minute (1 min minimum)         |
| River             | `rescueAfter`                                                                               | 1 h, for jobs with a timeout; never for jobs without one | 18 s, `rescueAfter: 3 s`                |
| Boring Node Queue | `stalledThreshold`, `stalledInterval`                                                       | 30 s, checked every 30 s                                 | 2 s                                     |
| Izi Queue         | `LifelinePlugin` `rescueAfter`; a node is presumed dead after 4 missed `heartbeatInterval`s | 300 s; a node is dead after 60 s at least                | 60 s, `rescueAfter: 10 s` (its minimum) |

17. With an undocumented, test-only lease of 3 s.

## Cron

What a user of each library's schedules sees: where they're defined, what happens to runs missed while no worker
was up, and whether several instances add one job per slot.

| Library           | Defined in       | Missed runs, by default                      | Missed-run option                              | One job per slot, several instances | Time zones                             | Interval schedules    | Finest cron unit |
| ----------------- | ---------------- | -------------------------------------------- | ---------------------------------------------- | ----------------------------------- | -------------------------------------- | --------------------- | ---------------- |
| sqlane            | Code             | The latest one runs once ¹⁸                  | `missed`: `once`, `skip`                       | ✅                                  | `timezone`, default UTC                | `every`, 1 s to 1 day | Minute           |
| pg-boss           | Database         | Skipped                                      | `missed`: `skip`, `once`                       | ✅                                  | `tz`, default UTC                      | 🟠 ¹⁹                 | Minute ¹⁹        |
| Graphile Worker   | Code             | Skipped                                      | `backfillPeriod`: every missed run in a window | ✅ ²⁰                               | ❌ UTC only                            | ❌                    | Minute           |
| BullMQ            | Database (Redis) | The next one runs late, once; others skipped | ❌                                             | ✅                                  | `tz`, default the process's zone       | `every`               | Second           |
| Sidequest         | Code, in memory  | Skipped                                      | ❌                                             | ❌ ²¹                               | `timezone`, default the process's zone | ❌                    | Second           |
| River             | Code, in memory  | Skipped                                      | ❌                                             | 🟠 ²²                               | `timeZone`, default the process's zone | `every`, `@every`     | Minute           |
| Boring Node Queue | Database         | The next one runs late, once; others skipped | ❌                                             | ✅                                  | `.timezone()`, default UTC             | `.every()` ²³         | Second ²⁴        |
| Izi Queue         | Code             | Skipped ²⁵                                   | ❌ ²⁵                                          | ✅                                  | `timezone`, default UTC                | ❌                    | Minute           |

18. If it is within the catch-up reach: one period plus 1 day.
19. No interval option; an RRULE such as `FREQ=MINUTELY;INTERVAL=5` does it. A 6-field cron is accepted, but adds at
    most one job per minute.
20. If every worker has the same crontab.
21. Every process that registers a schedule enqueues every run. Registering it in one process gives one job per slot,
    with no failover. `unique({ period })`, which its docs recommend for several instances, rejects every run after
    the first: `schedule()` computes the unique key once, at registration.
22. Only the leader adds the jobs; its docs warn of duplicates after a leadership change and suggest `unique`.
23. Counted from when a worker claims the schedule, not aligned to the clock.
24. Accepted by its cron parser, but not documented.
25. A new leader starts from its current minute. `maxCatchUpMinutes` (default 5) only covers a late tick of a running
    leader.

## Versions

Checked on 14 November 2026 on PostgreSQL 17, on the Linux machine of the [performance
comparison](performance_vs_other_libs.md#conditions): sqlane 5.0.0, [pg-boss](https://github.com/timgit/pg-boss)
12.38.2, [Graphile Worker](https://github.com/graphile/worker) 0.18.0, [BullMQ](https://github.com/taskforcesh/bullmq)
6.7.4, [Sidequest](https://github.com/sidequestjs/sidequest) 1.17.0, [River for
JavaScript](https://github.com/riverqueue/river) 0.3.2, [Boring Node Queue](https://github.com/boringnode/queue) 0.9.1
and [Izi Queue](https://github.com/IagoCavalcante/izi-queue) 0.10.0. River's Go library and the paid editions (BullMQ
Pro, River Pro, Graphile Worker Pro) are not compared. To rerun the 🔬 checks: `pnpm bench:compare --only checks`
([bench/compare](../bench/compare/README.md)).
