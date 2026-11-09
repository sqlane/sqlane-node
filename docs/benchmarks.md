# Benchmarks

`pnpm bench` starts the databases in Docker and prints these tables, in about 2 minutes. `--db postgres-18` runs one
database; `--quick` runs fewer samples, for a fast check. The time of each scenario goes to stderr. Not in CI: the
numbers depend on the machine.

Setup: the official Docker images with their default config, data on disk (not tmpfs), the client on the same machine.
Each scenario has tables of its own. An empty handler shows the cost of the queue itself.

- **Probe:** the statement that finds the job names with due jobs. 1000 job names with 100 completed jobs each, and
  10 pending jobs in a growing number of names. Compared with one `MIN(run_at)` per name (a `UNION ALL` of 1000
  queries): a probe that grows with all names.
- **Latency:** from the return of `COMMIT` to the start of the handler, 100 jobs one at a time, with a random pause of
  0–50 ms between jobs. The worker polls every 5 s; it wakes by re-probes (same process), a hint in memory (another
  instance: Redis without its network hop) or PostgreSQL NOTIFY.
- **Throughput:** 8 producers, each `enqueue` in a transaction of its own; 5,000 due jobs run by workers with a pool
  of 5 connections each.

## Results

Machine: Node.js v26.13.0, Apple M1 Pro (8 threads), 16 GiB

### mysql-8.4

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | p50  | p95  |
| ----------------------- | ---- | ---- |
| 0                       | 0.81 | 6.88 |
| 1                       | 0.33 | 0.55 |
| 10                      | 0.38 | 0.81 |
| 100                     | 0.51 | 0.75 |
| 1000                    | 2.03 | 2.94 |

One query per name instead (a `UNION ALL` of 1000), 10 names with pending jobs: p50 42 ms.

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker              | p50 | p95 | max |
| ------------------- | --- | --- | --- |
| Same process        | 24  | 31  | 35  |
| Other process, hint | 24  | 53  | 56  |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s |
| ----------------------------- | ------ |
| `enqueue`, a transaction each | 1,723  |
| `enqueueMany` of 100          | 54,854 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 1,027  |
| 1 process, concurrency 50   | 4,132  |
| 4 processes, concurrency 10 | 2,356  |

### postgres-15

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | p50  | p95  |
| ----------------------- | ---- | ---- |
| 0                       | 0.47 | 1.08 |
| 1                       | 0.45 | 0.61 |
| 10                      | 0.53 | 1.85 |
| 100                     | 0.94 | 1.50 |
| 1000                    | 4.34 | 6.24 |

One query per name instead (a `UNION ALL` of 1000), 10 names with pending jobs: p50 146 ms.

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker                | p50  | p95  | max  |
| --------------------- | ---- | ---- | ---- |
| Same process          | 22   | 25   | 30   |
| Other process, hint   | 20   | 51   | 81   |
| Other process, NOTIFY | 2.38 | 4.91 | 7.41 |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s  |
| ----------------------------- | ------- |
| `enqueue`, a transaction each | 3,907   |
| `enqueueMany` of 100          | 107,542 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 1,774  |
| 1 process, concurrency 50   | 5,163  |
| 4 processes, concurrency 10 | 4,963  |

### postgres-18

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | p50  | p95  |
| ----------------------- | ---- | ---- |
| 0                       | 0.48 | 1.81 |
| 1                       | 0.46 | 0.64 |
| 10                      | 0.51 | 0.85 |
| 100                     | 0.90 | 1.17 |
| 1000                    | 4.41 | 5.90 |

One query per name instead (a `UNION ALL` of 1000), 10 names with pending jobs: p50 127 ms.

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker                | p50  | p95  | max |
| --------------------- | ---- | ---- | --- |
| Same process          | 23   | 27   | 28  |
| Other process, hint   | 26   | 52   | 68  |
| Other process, NOTIFY | 2.31 | 5.28 | 11  |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s  |
| ----------------------------- | ------- |
| `enqueue`, a transaction each | 3,884   |
| `enqueueMany` of 100          | 110,614 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 2,579  |
| 1 process, concurrency 50   | 9,348  |
| 4 processes, concurrency 10 | 6,995  |

## Notes

- **Idle names cost nothing:** the probe reads only the names with pending jobs. 1000 handled names with 10 pending
  ones: under 1 ms. The `UNION` grows with all names: 43 ms on MySQL, 125–145 ms on PostgreSQL.
- **Latency:** about 25 ms with re-probes or a hint: the first re-probe is 20 ms after the enqueue, then the claim.
  NOTIFY comes after the commit: about 5 ms.
- **Throughput:** a commit flushes the log to disk, so a process completes its finished jobs in batches: one
  transaction for the jobs that finish during the previous write. More concurrency gives bigger batches. A claim of
  names without mutex keys finds, claims and reads the due jobs at once: one statement on PostgreSQL, one locking
  read and one update on MySQL. The 4 processes
  are 4 instances in one Node.js process: they share its CPU.
