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

Machine: Node.js v24.22.1, Apple M1 Pro (8 threads), 16 GiB

### mysql-8.4

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | p50  | p95  |
| ----------------------- | ---- | ---- |
| 0                       | 0.79 | 7.17 |
| 1                       | 0.27 | 0.33 |
| 10                      | 0.26 | 0.31 |
| 100                     | 0.50 | 0.79 |
| 1000                    | 2.27 | 3.07 |

One query per name instead (a `UNION ALL` of 1000), 10 names with pending jobs: p50 43 ms.

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker              | p50 | p95 | max |
| ------------------- | --- | --- | --- |
| Same process        | 26  | 31  | 37  |
| Other process, hint | 25  | 57  | 66  |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s |
| ----------------------------- | ------ |
| `enqueue`, a transaction each | 1,870  |
| `enqueueMany` of 100          | 58,330 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 1,045  |
| 1 process, concurrency 50   | 3,768  |
| 4 processes, concurrency 10 | 2,112  |

### postgres-15

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | p50  | p95  |
| ----------------------- | ---- | ---- |
| 0                       | 0.43 | 0.62 |
| 1                       | 0.49 | 0.68 |
| 10                      | 0.44 | 0.74 |
| 100                     | 0.79 | 1.24 |
| 1000                    | 4.28 | 5.59 |

One query per name instead (a `UNION ALL` of 1000), 10 names with pending jobs: p50 144 ms.

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker                | p50  | p95  | max |
| --------------------- | ---- | ---- | --- |
| Same process          | 26   | 30   | 42  |
| Other process, hint   | 24   | 57   | 68  |
| Other process, NOTIFY | 4.99 | 8.73 | 16  |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s  |
| ----------------------------- | ------- |
| `enqueue`, a transaction each | 3,966   |
| `enqueueMany` of 100          | 109,978 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 1,453  |
| 1 process, concurrency 50   | 4,894  |
| 4 processes, concurrency 10 | 3,391  |

### postgres-18

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | p50  | p95  |
| ----------------------- | ---- | ---- |
| 0                       | 0.38 | 0.50 |
| 1                       | 0.40 | 0.65 |
| 10                      | 0.50 | 0.85 |
| 100                     | 0.90 | 1.42 |
| 1000                    | 4.36 | 5.59 |

One query per name instead (a `UNION ALL` of 1000), 10 names with pending jobs: p50 125 ms.

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker                | p50  | p95  | max |
| --------------------- | ---- | ---- | --- |
| Same process          | 25   | 30   | 38  |
| Other process, hint   | 27   | 58   | 82  |
| Other process, NOTIFY | 4.56 | 8.55 | 11  |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s  |
| ----------------------------- | ------- |
| `enqueue`, a transaction each | 4,042   |
| `enqueueMany` of 100          | 105,181 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 1,823  |
| 1 process, concurrency 50   | 5,788  |
| 4 processes, concurrency 10 | 3,743  |

## Notes

- **Idle names cost nothing:** the probe reads only the names with pending jobs. 1000 handled names with 10 pending
  ones: under 1 ms. The `UNION` grows with all names: 43 ms on MySQL, 125–145 ms on PostgreSQL.
- **Latency:** about 25 ms with re-probes or a hint: the first re-probe is 20 ms after the enqueue, then the claim.
  NOTIFY comes after the commit: about 5 ms.
- **Throughput:** a commit flushes the log to disk, so a process completes its finished jobs in batches: one
  transaction for the jobs that finish during the previous write. More concurrency gives bigger batches. The 4 processes
  are 4 instances in one Node.js process: they share its CPU.
