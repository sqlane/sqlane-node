# Benchmarks

The cost of sqlane itself on each supported database, with empty handlers. For sqlane next to pg-boss, Graphile
Worker and River, see [compare performance](performance_vs_other_libs.md); for the CPU cost of each job, see
[CPU cost per job](contributing/measuring_cpu_cost.md).

## Summary

Machine: Node.js v26.13.0, Apple M1 Pro (8 threads), 16 GiB, databases in Docker. Medians:

| Scenario                                            | MySQL 8.4 | MariaDB 10.11 | MariaDB 11.8 | PostgreSQL 15 | PostgreSQL 18 |
| --------------------------------------------------- | --------- | ------------- | ------------ | ------------- | ------------- |
| [Probe](#method), 10 of 1000 names pending (ms)     | 0.43      | 0.25          | 0.27         | 0.45          | 0.50          |
| One query per name instead (ms)                     | 43        | 13            | 20           | 148           | 131           |
| Commit to start, same process (ms)                  | 23        | 23            | 23           | 23            | 21            |
| Commit to start, other process, hint (ms)           | 23        | 23            | 25           | 20            | 20            |
| Commit to start, other process, NOTIFY (ms)         | —         | —             | —            | **2.3**       | **2.5**       |
| `enqueue`, a transaction each, 8 producers (jobs/s) | 1,667     | 1,936         | 2,131        | 4,056         | 3,926         |
| `enqueueMany` of 100, 8 producers (jobs/s)          | 50,629    | 80,185        | 89,579       | 114,298       | 102,674       |
| Run, 1 process, concurrency 50 (jobs/s)             | 4,183     | 3,979         | 4,341        | 6,810         | 9,784         |

## What the numbers show

- **Idle names cost almost nothing.** The probe reads only the names that have pending jobs. With 1000 handled names
  and pending jobs in 10 of them, the probe takes under 1 ms at the median. The `UNION ALL` of one query per name
  grows with the number of all names. It takes 13–43 ms on MySQL and MariaDB, and 131–148 ms on PostgreSQL at the median.
- **Latency.** With re-probes or a hint, a job starts 20–25 ms after the commit at the median. The first re-probe
  comes 20 ms after the enqueue, and the claim follows it. NOTIFY arrives after the commit, so with NOTIFY a job
  starts about 2.4 ms after the commit at the median, and in under 5.5 ms at p95.
- **MySQL and MariaDB.** With the same binary log, MariaDB runs jobs at about the rate of MySQL 8.4, within the noise
  of one run. It adds jobs faster: 1.2–1.3 times with a transaction each, and 1.6–1.8 times in batches of 100. Without
  the binary log, which is the default of MariaDB, a commit syncs one file instead of two, and MariaDB added jobs 1.8
  times faster than MySQL with its default binary log.
- **Throughput.** A commit flushes the log to disk, so a process completes its finished jobs in batches. One
  transaction completes the jobs that finished during the previous write, so more concurrency gives bigger batches. A
  claim of names without mutex keys finds, claims and reads the due jobs at once. This claim is one statement on
  PostgreSQL, and one locking read and one update on MySQL. The 4 processes are 4 instances in one Node.js process,
  so they share its CPU.

## Full results

<details>
<summary><b>MySQL 8.4</b> (<code>--db mysql-8.4</code>)</summary>

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | p50  | p95  |
| ----------------------- | ---- | ---- |
| 0                       | 0.85 | 7.96 |
| 1                       | 0.34 | 1.57 |
| 10                      | 0.43 | 1.83 |
| 100                     | 0.51 | 0.96 |
| 1000                    | 2.28 | 4.50 |

One query per name instead (a `UNION ALL` of 1000), 10 names with pending jobs: p50 43 ms.

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker              | p50 | p95 | max |
| ------------------- | --- | --- | --- |
| Same process        | 23  | 30  | 32  |
| Other process, hint | 23  | 54  | 62  |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s |
| ----------------------------- | ------ |
| `enqueue`, a transaction each | 1,667  |
| `enqueueMany` of 100          | 50,629 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 989    |
| 1 process, concurrency 50   | 4,183  |
| 4 processes, concurrency 10 | 2,303  |

</details>

<details>
<summary><b>MariaDB 10.11</b> (<code>--db mariadb-10.11</code>)</summary>

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | p50  | p95  |
| ----------------------- | ---- | ---- |
| 0                       | 1.01 | 2.86 |
| 1                       | 0.27 | 0.36 |
| 10                      | 0.25 | 0.30 |
| 100                     | 0.43 | 0.54 |
| 1000                    | 1.48 | 1.83 |

One query per name instead (a `UNION ALL` of 1000), 10 names with pending jobs: p50 13 ms.

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker              | p50 | p95 | max |
| ------------------- | --- | --- | --- |
| Same process        | 23  | 27  | 30  |
| Other process, hint | 23  | 51  | 61  |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s |
| ----------------------------- | ------ |
| `enqueue`, a transaction each | 1,936  |
| `enqueueMany` of 100          | 80,185 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 1,194  |
| 1 process, concurrency 50   | 3,979  |
| 4 processes, concurrency 10 | 2,403  |

</details>

<details>
<summary><b>MariaDB 11.8</b> (<code>--db mariadb-11.8</code>)</summary>

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | p50  | p95  |
| ----------------------- | ---- | ---- |
| 0                       | 0.72 | 2.80 |
| 1                       | 0.25 | 0.34 |
| 10                      | 0.27 | 0.68 |
| 100                     | 0.35 | 0.53 |
| 1000                    | 1.18 | 1.45 |

One query per name instead (a `UNION ALL` of 1000), 10 names with pending jobs: p50 20 ms.

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker              | p50 | p95 | max |
| ------------------- | --- | --- | --- |
| Same process        | 23  | 27  | 33  |
| Other process, hint | 25  | 55  | 58  |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s |
| ----------------------------- | ------ |
| `enqueue`, a transaction each | 2,131  |
| `enqueueMany` of 100          | 89,579 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 1,199  |
| 1 process, concurrency 50   | 4,341  |
| 4 processes, concurrency 10 | 2,288  |

</details>

<details>
<summary><b>PostgreSQL 15</b> (<code>--db postgres-15</code>)</summary>

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | p50  | p95  |
| ----------------------- | ---- | ---- |
| 0                       | 0.65 | 1.34 |
| 1                       | 0.54 | 1.19 |
| 10                      | 0.45 | 0.72 |
| 100                     | 0.91 | 1.46 |
| 1000                    | 4.18 | 4.92 |

One query per name instead (a `UNION ALL` of 1000), 10 names with pending jobs: p50 148 ms.

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker                | p50  | p95  | max  |
| --------------------- | ---- | ---- | ---- |
| Same process          | 23   | 27   | 34   |
| Other process, hint   | 20   | 50   | 62   |
| Other process, NOTIFY | 2.31 | 5.28 | 6.67 |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s  |
| ----------------------------- | ------- |
| `enqueue`, a transaction each | 4,056   |
| `enqueueMany` of 100          | 114,298 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 1,958  |
| 1 process, concurrency 50   | 6,810  |
| 4 processes, concurrency 10 | 5,353  |

</details>

<details>
<summary><b>PostgreSQL 18</b> (<code>--db postgres-18</code>)</summary>

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | p50  | p95  |
| ----------------------- | ---- | ---- |
| 0                       | 0.43 | 0.71 |
| 1                       | 0.42 | 0.53 |
| 10                      | 0.50 | 1.01 |
| 100                     | 0.92 | 1.46 |
| 1000                    | 4.21 | 5.89 |

One query per name instead (a `UNION ALL` of 1000), 10 names with pending jobs: p50 131 ms.

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker                | p50  | p95  | max  |
| --------------------- | ---- | ---- | ---- |
| Same process          | 21   | 27   | 29   |
| Other process, hint   | 20   | 50   | 57   |
| Other process, NOTIFY | 2.47 | 5.01 | 8.53 |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s  |
| ----------------------------- | ------- |
| `enqueue`, a transaction each | 3,926   |
| `enqueueMany` of 100          | 102,674 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 2,907  |
| 1 process, concurrency 50   | 9,784  |
| 4 processes, concurrency 10 | 5,856  |

</details>

## Schedules

`pnpm bench --schedules` measures the [schedules](api.md#schedule). Same machine, databases in Docker:

| Scenario                                                                      | MySQL 8.4 | MariaDB 10.11 | MariaDB 11.8 | PostgreSQL 15 | PostgreSQL 18 |
| ----------------------------------------------------------------------------- | --------- | ------------- | ------------ | ------------- | ------------- |
| Idle, 1000 schedules that do not fire: statements on the schedules per minute | 0         | 0             | 0            | 0             | 0             |
| Idle: all statements per minute, 1000 schedules / none                        | 34 / 34   | 34 / 34       | 38 / 34      | 38 / 34       | 34 / 31       |
| 1000 slots due at once, 1 process: from the slot to the last job (ms)         | 165       | 172           | 163          | 116           | 109           |
| Statements per slot, 1000 slots due at once                                   | 0.05      | 0.05          | 0.05         | 0.03          | 0.03          |
| Burst of 1000 slots, 4 processes: winner transaction p50 / p99 (ms)           | 20 / 35   | 13 / 50       | 16 / 28      | 11 / 30       | 10 / 23       |
| Burst: loser transaction p50 / p99 (ms)                                       | 2.3 / 9.2 | 2.0 / 15      | 2.3 / 15     | 3.9 / 29      | 3.0 / 15      |
| Burst, `jitter: '1m'`: loser transaction p50 / p99 (ms)                       | 2.7 / 19  | 2.4 / 7.0     | 2.3 / 6.2    | 3.1 / 10      | 2.6 / 6.7     |

- **Idle schedules cost no statement.** Each process keeps one timer for the earliest slot of its schedules. While no
  slot is due, 1000 schedules run no statement, and the probes per minute are those of the handled names.
- **A burst is shared, never waited for.** 1000 slots at the same minute take about 10 transactions of 100 slots. A
  process that finds a row locked by another process skips it (SKIP LOCKED): a loser's transaction takes 2–4 ms at the
  median, the pool acquire included. From the connection on, a loser holds it 2.5 ms at the median and about 6 ms at p99
  (PostgreSQL); a p99 above that is the wait for a connection of the queue pool during the burst. No lease was lost. In
  the first 2 seconds of a burst the 1000 scheduled jobs compete with the other jobs for the handlers; with
  `jitter: '1m'` the slots spread over the minute.
- **Scenarios.** Idle: 2 processes, 1000 handled names, 60 s after `start()`, cron `0 0 1 1 *`. Fire: N `every: '10s'`
  schedules in 1 process. Burst: 1000 `* * * * *` schedules on 1000 names over 4 processes with a queue pool of 3
  each, while a producer enqueues 50 jobs/s that the same processes run, for 2 minutes.

## Method

`pnpm bench` starts the databases in Docker and prints these tables in about 2.5 minutes. The option
`--db postgres-18` runs only one database, and `--quick` runs fewer samples for a fast check. `--schedules` runs the
scenarios of the [schedules](#schedules) instead, in about 9 minutes per database. The time of each scenario
goes to stderr. The benchmarks do not run in CI, because the numbers depend on the machine.

The databases run from the official Docker images with their default configuration, with one exception: MariaDB gets
the binary log of MySQL 8.4 (`log_bin`, `sync_binlog=1`, row format), which it has off by default. So a commit syncs
the same files on both, and the numbers compare the databases, not their defaults. Their data is on disk, not on
tmpfs, and the client runs on the same machine. Each scenario has tables of its own. The handlers are empty, so the
numbers show the cost of the queue itself.

- **Probe.** The probe is the statement that finds the job names with pending jobs. The scenario has 1000 job names with
  100 completed jobs each, and 10 pending jobs in each of 0, 1, 10, 100 or 1000 names. It compares the probe with one
  `MIN(run_at)` query per name (a `UNION ALL` of 1000 queries), whose cost grows with the number of all names.
- **Latency.** The scenario measures the time from the return of `COMMIT` to the start of the handler. It enqueues
  100 jobs one at a time, with a random pause of 0–50 ms between them. The worker polls every 5 s. It wakes by
  re-probes in the same process, by a hint in memory from another instance (like Redis without its network hop), or
  by PostgreSQL NOTIFY.
- **Throughput.** 8 producers each run `enqueue` in a transaction of its own. Then workers with a pool of 5
  connections each run 5,000 due jobs.
