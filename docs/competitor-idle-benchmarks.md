# Idle queues: Docker comparison

This benchmark measures the overhead of keeping consumers ready for **1 versus 1,000 names**, with a **5-second idle
poll/wait interval** and no runnable jobs. It measures background database work, connections and worker resources.
It does not measure throughput, execution latency, crash safety or cloud bills.

Tested on 10 November 2026: Apple M1 Pro, 16 GiB RAM; Docker Desktop 4.81.0 / Engine 29.6.1, Linux ARM64, 8 virtual
CPUs and about 7.65 GiB assigned to Docker. Applications run in Node.js 26.13.0 Alpine containers. PostgreSQL is
15.19; BullMQ's Redis-compatible case uses Valkey 8.1. Package versions and worker configurations are listed below.

## PostgreSQL results

These are top-level SQL statements per second, including maintenance observed during the recorded samples. Fetches are
reported separately because one empty claim can also require queue lookups and transaction statements.

| Library / scenario                    |       Names | All SQL statements/s | Fetch / probe SQL/s | Worker DB connections |
| ------------------------------------- | ----------: | -------------------: | ------------------: | --------------------: |
| pg-boss                               |           1 |                 1.92 |                0.40 |                   1–4 |
| pg-boss                               |       1,000 |               427.81 |              200.19 |                    10 |
| Graphile Worker                       |           1 |                 0.21 |                0.20 |                     2 |
| Graphile Worker                       |       1,000 |                 0.21 |                0.20 |                     2 |
| Sidequest, empty                      |           1 |                 0.20 |                   0 |                   1–4 |
| Sidequest, empty                      |       1,000 |                 0.20 |                   0 |                   1–4 |
| Sidequest, retained completed history |           1 |                 0.99 |                0.20 |                   1–4 |
| Sidequest, retained completed history |       1,000 |               738.09 |              187.11 |                   1–4 |
| Sidequest, future jobs                |       1,000 |               725.24 |              186.55 |                   1–4 |
| River, one shared queue               |      1 kind |                 2.42 |                0.20 |                   3–4 |
| River, one shared queue               | 1,000 kinds |                 2.81 |                0.19 |                   2–3 |
| River, physical queues                |       1,000 |               656.26 |              191.25 |                  9–10 |
| sqlane                                |           1 |                 0.47 |                0.20 |                     1 |
| sqlane                                |       1,000 |                 0.37 |                0.20 |                     1 |
| sqlane, retained completed history    |       1,000 |                 0.37 |                0.20 |                     1 |
| BullMQ PostgreSQL                     |           1 |                 0.83 |                0.20 |                     3 |
| BullMQ PostgreSQL                     |       1,000 |               833.28 |              199.99 |                 1,005 |

pg-boss's default scheduler also polls an internal cron queue, contributing roughly 0.2 fetches/s. For 1,000 queues,
its total SQL ranged from **202.88 to 877.70 statements/s** across 30-second windows: the middle window included the
60-second maintenance sweep. Multiple maintenance statements can share one network request. The application queues
alone still account for about **200 empty fetches/s** at 5-second polling.

Graphile Worker retained 1,000 task identifiers and 1,000 named serialization queue records after completing setup
jobs; zero jobs remained during sampling. Its normal shared worker pool polls across those task identifiers without
creating a polling loop per name. Increasing the pool's worker concurrency would change its baseline polling cost.

River's 1,000-kind configuration still uses one queue: it does not create a producer loop per kind. Its 1,000
physical-queue configuration does, and includes queue-control polling as well as claims. Maintenance phase makes
total SQL vary between the shared-queue controls; claim polling remains about 0.2/s.

sqlane's fetch/probe column counts its shared **readiness probe**; it did not issue job claims while nothing was due.
Other statements are background recovery/maintenance. The difference between its 1-name and 1,000-name totals comes
from timer phase in short windows, not a benefit from adding names. Completed history did not activate per-name
claims.

BullMQ PostgreSQL uses one LISTEN client per Worker plus pooled query clients. The test shares a pool and raises the
server connection limit to 1,200 so 1,000 Workers can start. It measured 1,000 LISTEN clients and five regular query
clients. A default PostgreSQL server connection limit of 100 would not accommodate this configuration.

## BullMQ Redis-compatible results

BullMQ uses Valkey here. Its five-second blocking reads differ from SQL polling. These counters report script
invocations and completed blocking waits; commands executed inside Lua are excluded.

| Physical queues / Workers | EVAL / EVALSHA per second | BZPOPMIN per second | Connections |
| ------------------------- | ------------------------: | ------------------: | ----------: |
| 1                         |                      0.23 |                0.20 |           2 |
| 1,000                     |                    232.39 |              199.06 |       1,001 |

Every Worker has concurrency 1. Sharing the ordinary ioredis client still leaves one dedicated blocking connection
per Worker. Increasing **one Worker's concurrency** adds handler slots, not blocking connections. Multiple job names
can instead share one queue and one Worker; that is a different configuration from independently consumed queues.

## Worker resource snapshots

| Case, 1,000 names           | App CPU (% of one core) | Mean sampled app RSS (MiB) |
| --------------------------- | ----------------------: | -------------------------: |
| sqlane                      |                    0.14 |                       75.8 |
| pg-boss                     |                    3.33 |                     142.4* |
| Graphile Worker             |                    0.42 |                      93.4* |
| Sidequest, empty            |                    0.18 |                      215.9 |
| Sidequest, retained history |                    6.98 |                      281.5 |
| River, physical queues      |                   12.60 |                      153.3 |
| BullMQ Redis-compatible     |                    7.72 |                      277.9 |
| BullMQ PostgreSQL           |                   11.85 |                      186.8 |

\*The pg-boss/Graphile harness preloads both packages; those RSS figures include both and cannot establish relative
library memory footprints. Sidequest RSS sums its main and child Node processes. These are whole application RSS
snapshots, with different sampling cadences; setup and active job execution are excluded. Database CPU counters are
recorded during the run; Sidequest's sampler introduces an approximately 2-percentage-point idle floor, so they should
not be used for precise cross-library CPU rankings.

## Why Sidequest can poll every idle queue

The retained-history case reproduces the per-queue cost: Sidequest discovers queue names from **all job rows**, then
looks up each queue and attempts a claim. A completed job still makes its queue discoverable. An empty claim has
`BEGIN`, `SELECT ... FOR UPDATE SKIP LOCKED`, and `COMMIT` statements; the queue lookup adds another statement.

With one completed row per queue, the three 30-second windows recorded **662.66–794.95 SQL statements/s**. The last
window contained exactly 6,000 queue lookups, 6,000 claim queries, 6,000 `BEGIN` statements, 6,000 `COMMIT` statements
and six discovery queries.
That matches six polling passes over 1,000 queues. Polling passes take time, so the effective spacing can exceed 5s.

A shared dispatcher therefore does not imply constant SQL cost. Configured queues with **no job rows** are a different
case; the benchmark tests those separately, as well as queues holding future jobs. This distinction reconciles the
source's discovery loop with the observed per-queue database traffic.

## What a name means

| Library                | Configuration                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| sqlane                 | 1 or 1,000 job definitions, one dispatcher, concurrency 1 per handler, process limit equal to name count, pool maximum 3. |
| pg-boss 12.38.1        | One `work()` registration per queue, local concurrency 1 each, shared pool maximum 10.                                    |
| Graphile Worker 0.18.0 | One pool with concurrency 1, 1 or 1,000 task identifiers and retained named serialization queue records.                  |
| BullMQ 6.7.2           | One Worker per physical queue, concurrency 1 each; share the ordinary Redis client or PostgreSQL pool.                    |
| Sidequest 1.17.0       | 1 or 1,000 configured queues, queue concurrency 1, global concurrency 1; dashboard disabled.                              |
| River JS 0.3.2         | 1 or 1,000 kinds in one queue; separately, 1,000 physical queues with one producer loop each.                             |

These configurations have different maximum active capacities. No handlers run during sampling: this is a comparison
of idle subscriptions, not of equivalent active throughput. In particular, do not equate a BullMQ job name with a
physical queue, a River kind with a queue, or a Graphile task identifier with a worker pool.

## Method

Both application and database run in Docker. Each configuration has its own fresh database/schema, setup and warmup
before sampling. Main 1,000-name cases use three consecutive 30-second samples; secondary controls and some 1-name
baselines use one 30-second sample. The measured configurations run sequentially to avoid competing with
each other for CPU. Default maintenance remains enabled with Sidequest's dashboard disabled. pg-boss
queue notifications are disabled to measure the requested 5-second polling configuration; other wake mechanisms
remain enabled as described above. An empty benchmark produces no wake notifications.

PostgreSQL's `pg_stat_statements` tracks **top-level SQL statement calls**. Observer/setup SQL is excluded. A statement
call is not necessarily a network round trip: a driver can send several statements in one request. Fetch/claim calls
are separated from maintenance, transaction statements and queue lookups in the measurements. Redis-compatible
commands are a separate unit; the BullMQ summary excludes commands executed inside Lua to avoid double counting.

CPU percentages mean a percentage of **one core**, not the whole machine. PostgreSQL CPU uses cgroup counters;
sampling commands add overhead. Sidequest's frequent resource sampling produced an idle cgroup CPU floor of roughly
2 percentage points in the empty control; those CPU figures include monitoring and should not rank the libraries.
App RSS is sampled inside containers; Sidequest includes its Node child
process. Sampling methods differ between harnesses. The pg-boss/Graphile harness preloads both libraries, so its RSS includes
both packages; those absolute memory figures cannot rank the libraries. The other harnesses load the selected queue
library. Use resource figures for scale, not fine rankings.
Connection counts exclude the observer; BullMQ Redis reuses its ordinary worker client for observation.

The 30–90-second windows do not cover every maintenance period or a full day. Counts can jump when maintenance runs;
the repeated samples expose that variation. No query count here is a hosting-price estimate.

## Scope

This exploratory run used 19 configurations and 45 measured windows. The worker and database ran in Docker, with
setup and warmup excluded. These short samples show idle overhead on one machine; repeat the workload in your own
environment before using the figures for capacity planning.

The [feature comparison](comparison.md) covers storage, transactions, mutexes and licenses. sqlane's maintained
[database benchmarks](benchmarks.md) cover its probe, latency and throughput on MySQL, MariaDB and PostgreSQL.
