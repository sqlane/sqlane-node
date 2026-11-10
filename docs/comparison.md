# Compare job queues

Choose a queue for your transaction model, database and concurrency needs. sqlane combines transactional enqueue on
MySQL, MariaDB and PostgreSQL with mutex keys shared across job names, under the MIT license.

This comparison checks the published packages on **10 November 2026**: pg-boss 12.38.1, Graphile Worker 0.18.0,
BullMQ 6.7.2, Sidequest 1.17.0 and River JS 0.3.2. River's Go library is a separate implementation, currently 0.51.2.
Feature and license sources are linked below.

## Features at a glance

✅ = available as open source, including separate dashboard packages. **Pro** = commercial extension.
— = not found in the inspected documented APIs. A checkmark establishes availability; the notes explain different guarantees.

| Feature                                       | sqlane | pg-boss | Graphile Worker | BullMQ | Sidequest | River JS |
| --------------------------------------------- | ------ | ------- | --------------- | ------ | --------- | -------- |
| PostgreSQL storage                            | ✅     | ✅      | ✅              | ✅     | ✅        | ✅       |
| MySQL storage                                 | ✅     | —       | —               | —      | ✅        | —        |
| MariaDB storage, explicitly supported         | ✅     | —       | —               | —      | —         | —        |
| Enqueue in your application's SQL transaction | ✅     | ✅      | ✅              | —¹     | —         | ✅       |
| Multiple resource mutex keys on one job       | ✅     | —       | —               | —      | —         | —        |
| Cron or recurring jobs                        | —      | ✅      | ✅              | ✅     | ✅²       | ✅²      |
| Dashboard available                           | —      | ✅      | —               | ✅³    | ✅        | ✅       |
| MIT license                                   | ✅     | ✅      | ✅              | ✅     | —⁴        | —⁴       |

1. BullMQ's PostgreSQL backend uses its own pool; a caller-owned transaction API was not found in the published
   package. Its Redis backend cannot share an application's SQL transaction.
2. Scheduling guarantees differ: Sidequest registers cron in each process; River core keeps periodic configuration in
   leader memory. Neither checkmark promises durable missed-tick replay. See [scheduling](#scheduling-and-operations).
3. BullMQ has the community MIT-licensed [bull-board](https://github.com/felixmosh/bull-board) as well as commercial
   Taskforce.sh. The table includes separate dashboard packages, not only bundled ones.
4. Sidequest is **LGPL-3.0-or-later**; River is **MPL-2.0**. Both are open source. MIT is a distinction from those two,
   not from pg-boss, Graphile Worker or BullMQ. Follow each project's license terms.

Storage details: BullMQ also supports Redis-compatible stores; Sidequest also supports SQLite and MongoDB; River JS
also supports SQLite. MySQL protocol compatibility alone is not an explicit MariaDB support contract.

Sources: [pg-boss](https://github.com/timgit/pg-boss), [Graphile Worker](https://worker.graphile.org/docs),
[BullMQ PostgreSQL](https://docs.bullmq.io/guide/postgresql), [Sidequest](https://docs.sidequestjs.com/introduction/why),
[River JS](https://github.com/riverqueue/river/tree/js/v0.3.2/js),
[Sidequest package license](https://registry.npmjs.org/sidequest/1.17.0),
[River package license](https://registry.npmjs.org/riverqueue/0.3.2).

## Where sqlane fits

**Transactional jobs on MySQL or MariaDB.** Use the same transaction object for the business write and the enqueue.
The job rolls back with the data, and becomes visible to workers after commit. On PostgreSQL, pg-boss, Graphile Worker
and River also provide this guarantee. sqlane's adapters accept transactions from 10 drivers and ORMs; see
[adapters](adapters.md).

**Work touching overlapping resources.** A transfer can lock both `account:alice` and `account:bob`. Another job
that touches either account waits, even if it has a different job name. Mutex contention does not merge or drop jobs; sqlane acquires
all of a job's keys together. Jobs must honor their abort signal for the [mutex guarantee](design.md#guarantees).

The alternatives already cover some serialization needs:

| Queue           | How it serializes related work                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| pg-boss         | Singleton keys, strict FIFO policies and group concurrency within a queue. One group/key identity per job.  |
| Graphile Worker | A `queue_name` serializes jobs across task identifiers. One named queue per job.                            |
| BullMQ          | Pro group concurrency; core deduplication with `keepLastIfActive` merges later adds into one follow-up job. |
| Sidequest       | Concurrency per queue; no per-job resource mutex API found.                                                 |
| River           | Pro concurrency limits partition by job arguments; River Pro currently does not support JS.                 |

One composite key such as `alice:bob` does not exclude a job with `alice:charlie`: sqlane locks the individual
resources. That is the useful distinction from a single group identity. You can also dispatch several application
job types through one competitor queue; cross-task serialization alone is not unique to sqlane.

Sources: [pg-boss queues](https://pgboss.io/api/queues), [workers](https://pgboss.io/api/workers),
[Graphile named queues](https://worker.graphile.org/docs/library/add-job),
[BullMQ deduplication](https://docs.bullmq.io/guide/jobs/deduplication),
[Pro groups](https://docs.bullmq.io/bullmq-pro/groups/concurrency),
[Sidequest concurrency](https://docs.sidequestjs.com/guide/queues/concurrency),
[River Pro](https://riverqueue.com/docs/pro).

## What 1,000 idle names cost

A job type and an independently controlled queue are different things. BullMQ can dispatch many `job.name` values
through one Worker; River can handle many kinds in one queue; Graphile Worker claims across task identifiers.
Forcing a worker pool per task type would misrepresent those libraries.

sqlane uses one readiness query per poll and a shared pool, even with many handlers and per-handler concurrency caps.
Its probe reads names with pending jobs; retained completed history does not make a name active. Graphile Worker also
shares polling across task names, so this advantage is not exclusive to sqlane.

BullMQ requires one **blocking connection per Worker**, even when Workers share their ordinary Redis connection.
`concurrency: 10` on one Worker means ten handler slots, not ten blocking connections. Independently consuming 1,000
queues requires 1,000 Workers; processing 1,000 job names in one queue does not. Its PostgreSQL backend also keeps a
LISTEN connection per Worker. See [BullMQ connections](https://docs.bullmq.io/guide/connections).

Sidequest discovers queues with job rows before claiming them. Its discovery includes retained completed, failed and
future jobs, so configured empty queues and idle queues with history can have different costs. The shared dispatcher
alone does not establish constant query cost.

The [Docker benchmark](competitor-idle-benchmarks.md) reports measured calls, connections, CPU and memory for 1 and
1,000 names at a 5-second polling interval, including these differences. An idle benchmark measures overhead, not job throughput or reliability.

## Scheduling and operations

sqlane currently has no built-in cron, dashboard or priorities. Use another queue when those features are central to
your application. Scheduling is on sqlane's [roadmap](../README.md#roadmap).

- **pg-boss:** PostgreSQL with persisted cron/RRULE scheduling, queue policies, priorities and an MIT dashboard.
- **Graphile Worker:** PostgreSQL with SQL/trigger enqueue and crontab backfill. Named queues already serialize
  different tasks, though its docs warn against high-cardinality queue names.
- **BullMQ:** Redis-compatible or PostgreSQL storage, job schedulers, flows, priorities and a broad ecosystem.
- **Sidequest:** built-in dashboard, process-local cron and several storage backends. It does not yet document enqueue
  in the caller's transaction.
- **River:** PostgreSQL or SQLite, transactional enqueue and periodic jobs. Check the JS implementation's feature
  coverage separately from Go and River Pro.

Cron is not a single guarantee. Graphile Worker supports backfill of missed ticks; Sidequest's registrations are
process-local; River core periodic jobs can miss ticks on leader changes; BullMQ produces the next scheduled job when
the previous one starts. Match these behaviors to your requirements.

Sources: [pg-boss scheduling](https://pgboss.io/api/scheduling), [Graphile cron](https://worker.graphile.org/docs/cron),
[BullMQ schedulers](https://docs.bullmq.io/guide/job-schedulers),
[Sidequest recurring jobs](https://docs.sidequestjs.com/guide/jobs/recurring),
[River periodic jobs](https://riverqueue.com/docs/periodic-jobs).

sqlane's API and schema follow semantic versioning since 1.0. It was first released in 2026 and has no known production
users yet. The established alternatives have longer operating histories. The [API](api.md), [design](design.md) and
[benchmarks](benchmarks.md) describe sqlane's current guarantees and tradeoffs.
