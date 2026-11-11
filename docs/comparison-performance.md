# Compare job queues: performance

The CPU cost, latency and idle cost of the job queues for Node.js that enqueue in your SQL transaction: sqlane,
pg-boss, Graphile Worker and River. They give the same guarantee, so they run the same workload. BullMQ and Sidequest
enqueue on their own connection ([features](comparison.md)) and are not measured.

| Library              | Version |
| -------------------- | ------- |
| sqlane               | 2.0.1   |
| pg-boss              | 12.38.2 |
| Graphile Worker      | 0.18.0  |
| River for JavaScript | 0.3.2   |

Measured on 11 November 2026 with `pnpm bench:compare`: Apple M1 Pro (8 cores), 16 GiB, macOS 27.2, Node.js 26.13.0,
PostgreSQL 17.11, MySQL 8.4.13 and MariaDB 11.8.9 from Homebrew, on the host. One run; repeat it on your hardware before
you plan capacity.

## Setup

Each library models 1000 job names in its own way, as its documentation describes:

| Library         | 1000 job names                  | Worker                                    |
| --------------- | ------------------------------- | ----------------------------------------- |
| sqlane          | 1000 handlers                   | 8 slots                                   |
| pg-boss         | 1000 queues, a `work()` on each | 1 slot per queue: its slots are per queue |
| Graphile Worker | 1000 tasks                      | `concurrency: 8`                          |
| River           | 1000 kinds in one queue         | `maxWorkers: 8`                           |

- One worker process, empty handlers: the numbers are the cost of the queue.
- A poll every 5 s, plus each library's wakes: LISTEN/NOTIFY on PostgreSQL (pg-boss: `useListenNotify` and `notify` on
  each queue, which are off by default). On MySQL and MariaDB, sqlane's hint goes over UDP on localhost, standing in
  for Redis.
- The pools keep their connections: a closed connection takes its CPU counters with it.
- **Instructions** retired are the measure to compare: they do not depend on the core or the clock. CPU time does, on
  Apple Silicon (see [CPU cost per job](cpu-cost.md#the-three-numbers)). The database counts the processes of its
  connections only, not autovacuum or the checkpointer.

## Steady load

A producer process enqueues 20 jobs per second, each in a transaction with an `INSERT` into a business table. 9 of 10
jobs go to 10 hot names, the rest to the other 990. A 15 s window after a 5 s warm-up. Per job:

| Library         | Database   | Instructions (M), worker / producer / database = total | CPU ms | Latency p50 / p99 ms |
| --------------- | ---------- | ------------------------------------------------------ | ------ | -------------------- |
| sqlane          | PostgreSQL | 1.3 / 1.1 / 2.1 = **4.5**                              | 5.1    | 3 / 17               |
| Graphile Worker | PostgreSQL | 5.6 / 1.0 / 4.6 = **11.3**                             | 10.0   | 9 / 23               |
| River           | PostgreSQL | 1.9 / 1.6 / 8.1 = **11.7**                             | 8.4    | 56 / 118             |
| pg-boss         | PostgreSQL | 5.7 / 1.2 / 20.8 = **27.7**                            | 14.0   | 11 / 31              |
| sqlane          | MySQL      | 3.3 / 1.6 / 9.7 = **14.6**                             | 13.0   | 7 / 57               |
| sqlane          | MariaDB    | 3.3 / 1.6 / 5.6 = **10.5**                             | 13.5   | 34 / 50              |

Latency is from the enqueue, before the `COMMIT`, to the start of the handler. River's p50 of 56 ms is about half its
fetch cooldown, the minimum time between two claims (100 ms by default): likely the wait for the next claim.

## Idle

No jobs, nothing due. Per second:

| Library         | Job names | Database instructions (M) | Worker instructions (M) | SQL statements | Connections |
| --------------- | --------- | ------------------------- | ----------------------- | -------------- | ----------- |
| sqlane          | 1         | 0.5                       | 0.6                     | 0.5            | 2           |
| sqlane          | 1000      | 0.1                       | 0.6                     | 0.2            | 2           |
| Graphile Worker | 1         | 1.0                       | 1.9                     | 1.7            | 5           |
| Graphile Worker | 1000      | 1.9                       | 5.1                     | 1.6            | 5           |
| River           | 1         | 1.8                       | 4.0                     | 2.1            | 5           |
| River           | 1000      | 2.0                       | 4.1                     | 2.1            | 5           |
| pg-boss         | 1         | 4.4                       | 3.2                     | 2.5            | 6           |
| pg-boss         | 1000      | **267.9**                 | **73.1**                | **202.9**      | 6           |

sqlane, Graphile Worker and River poll once for all names: 1000 names cost what one costs. pg-boss polls each queue,
so 1000 queues are 200 fetches per second at a 5 s interval, and about a quarter of a core of the database. pg-boss can
run several job names through one queue, with the name in the data; then it polls once, but the queue's options
(retries, expiry) are shared.

## Drain

10,000 due jobs over the 1000 job names, enqueued before the worker starts. The time until the worker has run them all:

| Library         | Time      | Instructions per job (M), worker / database = total |
| --------------- | --------- | --------------------------------------------------- |
| sqlane          | **1.6 s** | 0.5 / 0.7 = **1.2**                                 |
| Graphile Worker | 2.1 s     | 2.6 / 3.4 = **6.0**                                 |
| pg-boss         | 45.2 s    | 1.2 / 3.6 = **4.8**                                 |
| River           | 127.4 s   | 1.0 / 5.9 = **6.9**                                 |

- pg-boss: 1000 queues with 1 slot each, each fetching one job at a time: about 220 jobs per second here.
- River: about 80 jobs per second, 8 workers per fetch cooldown of 100 ms. A shorter `fetchCooldown` or more
  `maxWorkers` should drain faster; not measured.

## Limits

- One machine, one run, 15 s windows: differences of about 10% are noise. Instructions repeat within about 3%.
- The setups do not have the same capacity: pg-boss has a slot per queue, the others 8 slots in all.
- Empty handlers: with real work, the handlers dominate, and the differences shrink.
- macOS: a commit took about 0.2 ms on MySQL and 5 ms on MariaDB with its binary log synced (`sync_binlog=1`, as MySQL
  8.4). On Linux both wait for the disk; the MySQL and MariaDB rows are sqlane only.

## Reproduce

```sh
pnpm bench:compare --only perf     # about 9 minutes
```

The adapters in `bench/compare/libs/` show each library's configuration, `bench/compare/perf.mjs` the workloads, and
`bench/compare/results.json` the raw numbers of this page. See [bench/compare](../bench/compare/README.md).
