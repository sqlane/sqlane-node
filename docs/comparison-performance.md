# Compare job queues: performance

The CPU cost, latency and idle cost of the Node.js job queues that enqueue in your SQL transaction: sqlane, pg-boss,
Graphile Worker and River. They give the same guarantee, so they run the same workload. BullMQ and Sidequest enqueue on
their own connection ([features](comparison.md)) and are not measured. pg-boss and River run twice: with their
defaults, and **tuned** with the throughput settings of their documentation ([method](#method-and-limits)).

## Summary

On PostgreSQL 17, one worker process, 1000 job names, empty handlers:

- **CPU per job, steady load:** sqlane uses **4.6 M** instructions per job in all processes. Graphile Worker uses 2.4×
  as many, River 2.6× (3.2× tuned) and pg-boss 6.0×, tuned or not.
- **Commit to handler start, p50:** sqlane **3 ms**, Graphile Worker 4 ms, pg-boss 5 ms. River takes 57 ms with its
  defaults and 5 ms tuned.
- **Idle names are free:** sqlane, Graphile Worker and River poll once for all job names, so 1000 names cost what 1
  costs. pg-boss polls each queue: 1000 idle queues take about a quarter of a database core, tuned or not.
- **Drain of 10,000 jobs:** tuned pg-boss is the fastest at **0.4 s**, with up to 8 jobs at once in each of its 1000
  queues. sqlane takes 1.7 s, Graphile Worker 1.8 s and tuned River 2.3 s, each with 8 slots. sqlane uses the fewest
  instructions per job. With their defaults, pg-boss takes 45 s and River 126 s.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf-cpu-per-job-dark.svg">
  <img alt="CPU instructions per job at steady load on PostgreSQL: sqlane 4.6 M, Graphile Worker 10.9 M, River 11.8 M, River tuned 14.6 M, pg-boss 27.4 M, pg-boss tuned 27.0 M" src="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf-cpu-per-job-light.svg">
</picture>

One run on a laptop: differences of about 10% are noise. Repeat it on your hardware before you plan capacity
([reproduce](#reproduce)).

## Steady load

A producer process enqueues 20 jobs per second, each in a transaction with an `INSERT` into a business table. 9 of 10
jobs go to 10 hot names, the rest to the other 990. A 15 s window after a 5 s warm-up. Per job, on PostgreSQL:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf-latency-dark.svg">
  <img alt="Median time from enqueue to handler start on PostgreSQL: sqlane 3 ms, Graphile Worker 4 ms, River 57 ms, River tuned 5 ms, pg-boss 5 ms, pg-boss tuned 5 ms" src="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf-latency-light.svg">
</picture>

| Library         | Instructions (M) | vs sqlane | Worker / producer / database | CPU ms | Latency p50 / p99 ms |
| --------------- | ---------------- | --------- | ---------------------------- | ------ | -------------------- |
| sqlane          | **4.6**          | 1×        | 1.3 / 1.1 / 2.3              | 4.9    | **3** / 7            |
| Graphile Worker | 10.9             | 2.4×      | 5.5 / 0.9 / 4.4              | 7.2    | 4 / 8                |
| River           | 11.8             | 2.6×      | 1.9 / 1.6 / 8.3              | 8.6    | 57 / 110             |
| River, tuned    | 14.6             | 3.2×      | 2.3 / 1.9 / 10.4             | 8.4    | 5 / 10               |
| pg-boss         | 27.4             | 6.0×      | 5.5 / 1.1 / 20.7             | 10.8   | 5 / 35               |
| pg-boss, tuned  | 27.0             | 5.9×      | 5.4 / 1.2 / 20.5             | 11.2   | 5 / 36               |

sqlane on the other databases, same workload:

| Database | Instructions (M) | Worker / producer / database | CPU ms | Latency p50 / p99 ms |
| -------- | ---------------- | ---------------------------- | ------ | -------------------- |
| MySQL    | 14.5             | 3.2 / 1.6 / 9.7              | 13.4   | 9 / 37               |
| MariaDB  | 10.6             | 3.3 / 1.6 / 5.6              | 12.7   | 36 / 45              |

Latency is from the enqueue, before the `COMMIT`, to the start of the handler. River's 57 ms come from its fetch
cooldown, the minimum time between two claims, which also spaces a producer's insert notifications (100 ms by
default). With 1 ms, its jobs start in 5 ms, for about a quarter more instructions per job. pg-boss's tuning changes
its fetches of a backlog, not this load. On MariaDB a commit syncs the binary log, which took about 5 ms on macOS (see
[limits](#method-and-limits)).

## Idle

No jobs, nothing due. Per second:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf-idle-dark.svg">
  <img alt="Database instructions per second while idle with 1000 job names: sqlane 0.1 M, Graphile Worker 2.0 M, River 1.7 M, River tuned 1.6 M, pg-boss 267 M, pg-boss tuned 267 M" src="https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images/perf-idle-light.svg">
</picture>

| Library         | Job names | Database instructions (M) | Worker instructions (M) | SQL statements | Connections |
| --------------- | --------- | ------------------------- | ----------------------- | -------------- | ----------- |
| sqlane          | 1         | 0.1                       | 0.4                     | 0.2            | 2           |
| sqlane          | 1000      | 0.1                       | 0.5                     | 0.2            | 2           |
| Graphile Worker | 1         | 0.9                       | 1.7                     | 1.6            | 5           |
| Graphile Worker | 1000      | 2.0                       | 4.8                     | 1.6            | 5           |
| River           | 1         | 1.7                       | 3.8                     | 2.1            | 5           |
| River           | 1000      | 1.7                       | 3.9                     | 2.1            | 5           |
| pg-boss         | 1         | 4.3                       | 3.0                     | 2.5            | 6           |
| pg-boss         | 1000      | **267.1**                 | **78.7**                | **202.9**      | 6           |

pg-boss polls each queue, so 1000 queues are 200 fetches per second at a 5 s interval. pg-boss can run several job
names through one queue, with the name in the data; then it polls once, but the queue's options (retries, expiry) are
shared. The tuned settings do not change the idle cost: with 1000 job names, tuned River's database used 1.6 M
instructions per second and tuned pg-boss's 266.8 M.

## Drain

10,000 due jobs over the 1000 job names, enqueued before the worker starts. The time until the worker has run them all:

| Library         | Time      | Jobs at once | Instructions per job (M), worker / database = total |
| --------------- | --------- | ------------ | --------------------------------------------------- |
| pg-boss, tuned  | **0.4 s** | up to 8,000  | 0.4 / 1.1 = 1.5                                     |
| sqlane          | 1.7 s     | 8            | 0.5 / 0.7 = **1.2**                                 |
| Graphile Worker | 1.8 s     | 8            | 2.6 / 3.3 = 6.0                                     |
| River, tuned    | 2.3 s     | 8            | 0.8 / 0.8 = 1.6                                     |
| pg-boss         | 45.1 s    | up to 1,000  | 1.2 / 3.6 = 4.7                                     |
| River           | 126.4 s   | 8            | 1.0 / 5.0 = 6.0                                     |

- pg-boss: by default, each of the 1000 queues fetches one job, then waits for the next poll (5 s here): about 220 jobs
  per second. Tuned, a fetch takes up to 8 jobs and a full one fetches again at once, so each queue runs its 10 jobs in
  two fetches. Its slots are per queue, so with real handlers up to 8,000 can run at once.
- River: by default, 8 workers per fetch cooldown of 100 ms, about 80 jobs per second. Tuned, the cooldown is 1 ms.

## Method and limits

Measured on 11 November 2026 with `pnpm bench:compare`: Apple M1 Pro (8 cores), 16 GiB, macOS 27.2, Node.js 26.13.0,
PostgreSQL 17.11, MySQL 8.4.13 and MariaDB 11.8.9 from Homebrew, on the host. Versions: sqlane 2.0.1, pg-boss 12.38.2,
Graphile Worker 0.18.0, River for JavaScript 0.3.2. Tuned River comes from a second run in the same hour.

Each library models 1000 job names in its own way, as its documentation describes:

| Library         | 1000 job names                  | Worker                                    | Tuned                                      |
| --------------- | ------------------------------- | ----------------------------------------- | ------------------------------------------ |
| sqlane          | 1000 handlers                   | 8 slots                                   | —                                          |
| pg-boss         | 1000 queues, a `work()` on each | 1 slot per queue: its slots are per queue | `batchSize: 8`, `burstWhenBatchFull: true` |
| Graphile Worker | 1000 tasks                      | `concurrency: 8`                          | —                                          |
| River           | 1000 kinds in one queue         | `maxWorkers: 8`                           | `fetchCooldown: 1 ms` (its minimum)        |

- One worker process, empty handlers: the numbers are the cost of the queue. With real work, the handlers dominate, and
  the differences shrink.
- A poll every 5 s, plus each library's wakes: LISTEN/NOTIFY on PostgreSQL (pg-boss: `useListenNotify` and `notify` on
  each queue, which are off by default). On MySQL and MariaDB, sqlane's hint goes over UDP on localhost, standing in
  for Redis.
- The pools keep their connections: a closed connection takes its CPU counters with it.
- **Instructions** retired are the measure to compare: they do not depend on the core or the clock. CPU time does, on
  Apple Silicon (see [CPU cost per job](cpu-cost.md#the-three-numbers)). The database counts the processes of its
  connections only, not autovacuum or the checkpointer.
- One machine, one run, 15 s windows: differences of about 10% are noise. Instructions repeat within about 3%;
  latencies vary more between runs.
- The setups do not have the same capacity: pg-boss has its slots per queue, the others 8 slots in all.
- macOS: a commit took about 0.2 ms on MySQL and 5 ms on MariaDB with its binary log synced (`sync_binlog=1`, as MySQL
  8.4). On Linux both wait for the disk.

## Reproduce

```sh
pnpm bench:compare --only perf     # about 12 minutes
pnpm bench:compare --only perf --libs river,river:tuned
```

The adapters in `bench/compare/libs/` show each library's configuration, `bench/compare/perf.mjs` the workloads, and
`bench/compare/results.json` the raw numbers of this page. `node bench/compare/charts.mjs` draws the charts from them.
See [bench/compare](../bench/compare/README.md).
