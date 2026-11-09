# Comparison with other job queues

This page compares sqlane with other job queues for Node.js, and with River, a Go queue that now also has a JS/TS version. It helps you decide
whether sqlane fits your app, or whether another queue fits better.

The facts come from the official documentation of each project, as of November 2026. Projects change quickly, so
check the linked sources before you decide. If something here is wrong or out of date, please
[open an issue](https://github.com/sqlane/sqlane-node/issues).

## Summary

sqlane is not the only queue that adds jobs inside your transaction. pg-boss, Graphile Worker and River do this too.
sqlane differs from them in three ways.

- It supports MySQL as well as PostgreSQL, with transactional enqueue on both. On MySQL, none of the other queues on
  this page adds jobs inside your transaction.
- It works with the transaction objects of 10 drivers and ORMs, so you keep the library that you already use.
- Its mutex keys stop jobs for the same entity from running at the same time. A job can have up to 10 keys, and the
  keys work across job names. The pg-boss options `singletonKey`, `key_strict_fifo` and `groupConcurrency` come close,
  but they work within one queue, and a job has one key. Graphile Worker's `queue_name` also runs jobs of different
  tasks in series, but a job has one queue name, and the docs advise against many distinct names. BullMQ's free
  deduplication with `keepLastIfActive` keeps one active job per deduplication id, but it merges later adds into one
  follow-up job. Groups with a concurrency limit per group are in BullMQ Pro, the commercial version. River limits
  concurrency per key only in River Pro. Sidequest documents no limit per key.

sqlane also has clear gaps. It has no cron, no dashboard and no priorities. It is new (version 1.0 since 2026) and has
no known production use yet, while pg-boss, Graphile Worker, BullMQ and River have been released for several years.

## Feature table

| Feature                         | sqlane                                                          | pg-boss                                                                                                                  | Graphile Worker                                                                                                                  | BullMQ                                                                                                                                                                                                                                 | Sidequest                                                                          | River                                                                |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Language                        | Node.js                                                         | Node.js                                                                                                                  | Node.js                                                                                                                          | Node.js                                                                                                                                                                                                                                | Node.js                                                                            | Go, and a JS/TS version for Node.js 24+ [21]                         |
| Storage                         | MySQL 8.4+, PostgreSQL 15+                                      | PostgreSQL 13+, also CockroachDB, Citus and PGlite [1]                                                                   | PostgreSQL 12+ [5]                                                                                                               | Redis-compatible stores (Redis, Valkey, Dragonfly), and an optional PostgreSQL 13+ backend [9][10]                                                                                                                                     | PostgreSQL, MySQL, SQLite, MongoDB [14]                                            | PostgreSQL, SQLite [19][21]                                          |
| Enqueue in your own transaction | Yes, with mysql2, pg, postgres.js and 7 query builders and ORMs | Yes, with the `db` option, and adapters for Knex, Kysely, Drizzle and Prisma [2]                                         | Yes. Call the SQL function `graphile_worker.add_job()` on your own connection inside your transaction, also from triggers [6][a] | No with Redis, because it is a separate store. Not documented for the PostgreSQL backend [10]                                                                                                                                          | Not yet. `withTransaction(trx)` is on the roadmap [15]                             | Yes, with `InsertTx` [19]                                            |
| One job at a time per entity    | Mutex keys, up to 10 per job, cluster-wide and across job names | Within one queue: `singletonKey`, the `key_strict_fifo` policy, and `groupConcurrency` per group across all nodes [3][4] | `queue_name` runs jobs in series, but the docs warn against many distinct names, such as UUIDs [7]                               | With deduplication and `keepLastIfActive`, at most one active job per deduplication id, and later adds merge into one follow-up job with the latest data [12]. Groups with a concurrency per group are in BullMQ Pro (commercial) [11] | Concurrency per queue and unique jobs [16]. No exclusion per key found in the docs | Concurrency limits per job arguments, in River Pro (commercial) [20] |
| Dashboard                       | No                                                              | Yes, `@pg-boss/dashboard` [1]                                                                                            | None in the official docs                                                                                                        | Taskforce.sh, official and commercial [22]                                                                                                                                                                                             | Built in [17]                                                                      | River UI [19]                                                        |
| Cron and recurring jobs         | No                                                              | Cron and RRULE [1]                                                                                                       | Crontab, with backfill [8]                                                                                                       | Job schedulers [13]                                                                                                                                                                                                                    | Cron, registered in the process [18]                                               | Periodic jobs [19]                                                   |
| Priorities                      | No                                                              | Yes, the `priority` option of `send()` [23]                                                                              | Yes, the `priority` argument of `add_job()` [6]                                                                                  | Yes, prioritized jobs [24]                                                                                                                                                                                                             | Per queue, not per job [25]                                                        | Yes, from 1 to 4 per job [26]                                        |
| Maturity                        | Version 1.0, first released in 2026, no known production use    | Version 12, first released in 2016 [27]                                                                                  | Version 0.18, first released in 2019 [27]                                                                                        | Version 6, version 1 released in 2019 [27]                                                                                                                                                                                             | Version 1, 1.0.0 released in 2025 [27]                                             | Version 0.51 of the Go library, first released in 2023 [28]          |

## When to choose which queue

**Choose sqlane** if your app runs on MySQL or PostgreSQL, and you want each job to commit or roll back with your
business transaction, through the driver or ORM that you already use. sqlane also fits when jobs for the same entity
must not run at the same time. Remember that it is new and has no known production use yet, so test it under your
own load first.

**Choose pg-boss** if you use PostgreSQL and want an established queue with cron, a dashboard, queue policies and
workflows. pg-boss also adds jobs inside your transaction. Its `singletonKey`, `key_strict_fifo` and `groupConcurrency`
options are close to mutex keys, but they work within one queue, and a job has one key.

**Choose Graphile Worker** if you use PostgreSQL and want to create jobs from SQL itself, for example from triggers or
functions, with very low latency.

**Choose BullMQ** if you already run Redis, and you need very high throughput, flows, or workers in several languages.

**Choose Sidequest** if you want a built-in dashboard and cron on PostgreSQL, MySQL, SQLite or MongoDB, and you do not
need transactional enqueue.

**Choose River** if you write Go and use PostgreSQL. It has transactional enqueue, periodic jobs and a UI. River now
also has a JS/TS version for Node.js 24+ [21], so check whether it covers what you need.

## Sources

1. [pg-boss README](https://github.com/timgit/pg-boss)
2. [pg-boss: adapters](https://pgboss.io/api/adapters)
3. [pg-boss: queues](https://pgboss.io/api/queues)
4. [pg-boss: workers](https://pgboss.io/api/workers)
5. [Graphile Worker: requirements](https://worker.graphile.org/docs/requirements)
6. [Graphile Worker: add_job in SQL](https://worker.graphile.org/docs/sql-add-job)
7. [Graphile Worker: addJob](https://worker.graphile.org/docs/library/add-job) and
   [job keys](https://worker.graphile.org/docs/job-key)
8. [Graphile Worker: cron](https://worker.graphile.org/docs/cron)
9. [BullMQ README](https://github.com/taskforcesh/bullmq) and
   [architecture](https://docs.bullmq.io/guide/architecture)
10. [BullMQ: PostgreSQL](https://docs.bullmq.io/guide/postgresql)
11. [BullMQ Pro: group concurrency](https://docs.bullmq.io/bullmq-pro/groups/concurrency)
12. [BullMQ: deduplication](https://docs.bullmq.io/guide/jobs/deduplication)
13. [BullMQ: job schedulers](https://docs.bullmq.io/guide/job-schedulers)
14. [Sidequest README](https://github.com/sidequestjs/sidequest)
15. [Sidequest: why Sidequest](https://docs.sidequestjs.com/introduction/why)
16. [Sidequest: enqueueing](https://docs.sidequestjs.com/guide/jobs/enqueueing) and
    [queue concurrency](https://docs.sidequestjs.com/guide/queues/concurrency)
17. [Sidequest: dashboard](https://docs.sidequestjs.com/resources/dashboard)
18. [Sidequest: recurring jobs](https://docs.sidequestjs.com/guide/jobs/recurring)
19. [River README](https://github.com/riverqueue/river)
20. [River Pro: concurrency limits](https://riverqueue.com/docs/pro/concurrency-limits)
21. [River: JS/TS implementation](https://github.com/riverqueue/river/tree/master/js)
22. [Taskforce.sh](https://taskforce.sh/): a 15-day free trial, then paid plans
23. [pg-boss: jobs](https://pgboss.io/api/jobs)
24. [BullMQ: prioritized jobs](https://docs.bullmq.io/guide/jobs/prioritized)
25. [Sidequest: queue priority](https://docs.sidequestjs.com/guide/queues/priority)
26. [River: `JobRow.Priority`](https://pkg.go.dev/github.com/riverqueue/river/rivertype)
27. The version history on npm: [pg-boss](https://www.npmjs.com/package/pg-boss?activeTab=versions),
    [graphile-worker](https://www.npmjs.com/package/graphile-worker?activeTab=versions),
    [bullmq](https://www.npmjs.com/package/bullmq?activeTab=versions) and
    [sidequest](https://www.npmjs.com/package/sidequest?activeTab=versions)
28. [River releases](https://github.com/riverqueue/river/releases)

[a] The Graphile Worker page on `add_job()` does not mention transactions. `add_job()` is an ordinary SQL function, so
PostgreSQL commits or rolls back its insert with the transaction that calls it.

The facts about sqlane come from the [API reference](api.md), the [adapters](adapters.md) and the
[design](design.md) of this repository.
