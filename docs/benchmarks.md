# Benchmarks

`pnpm bench` starts each database in Docker and prints these tables. `pnpm bench --db postgres-18 --quick` runs one
database with fewer samples. Not in CI: the numbers depend on the machine.

Setup: the official Docker images with their default config, data on disk (not tmpfs), the client on the same machine.
Each scenario has tables of its own. An empty handler shows the cost of the queue itself.

- **Probe:** the statement that finds the job names with due jobs. 1000 job names with 100 completed jobs each, and
  10 pending jobs in a growing number of names. Compared with one `MIN(run_at)` per name (a `UNION ALL` of 1000
  queries): a probe that grows with all names.
- **Latency:** from the return of `COMMIT` to the start of the handler, one job at a time, with a random pause of
  0–300 ms between jobs. The worker polls every 5 s; it wakes by re-probes (same process), a hint in memory (another
  instance: Redis without its network hop) or PostgreSQL NOTIFY.
- **Throughput:** 8 producers, each `enqueue` in a transaction of its own; 20,000 due jobs run by workers with a pool
  of 5 connections each.

## Results

Machine: Node.js v24.22.1, Apple M1 Pro (8 threads), 16 GiB

### mysql-8.4

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | sqlane probe p50 | p95  | One query per name p50 |
| ----------------------- | ---------------- | ---- | ---------------------- |
| 0                       | 0.57             | 7.64 | 42                     |
| 1                       | 0.41             | 1.18 | 42                     |
| 10                      | 0.39             | 0.58 | 42                     |
| 100                     | 0.51             | 1.02 | 42                     |
| 1000                    | 2.00             | 2.86 | 42                     |

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker              | p50 | p95 | p99 | max |
| ------------------- | --- | --- | --- | --- |
| Same process        | 30  | 38  | 49  | 60  |
| Other process, hint | 30  | 42  | 57  | 63  |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s |
| ----------------------------- | ------ |
| `enqueue`, a transaction each | 1,606  |
| `enqueueMany` of 100          | 62,580 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 758    |
| 1 process, concurrency 50   | 1,107  |
| 4 processes, concurrency 10 | 1,485  |

### postgres-15

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | sqlane probe p50 | p95  | One query per name p50 |
| ----------------------- | ---------------- | ---- | ---------------------- |
| 0                       | 0.49             | 0.82 | 156                    |
| 1                       | 0.61             | 1.13 | 151                    |
| 10                      | 0.56             | 1.30 | 150                    |
| 100                     | 1.15             | 2.71 | 154                    |
| 1000                    | 4.39             | 6.23 | 79                     |

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker                | p50  | p95 | p99 | max |
| --------------------- | ---- | --- | --- | --- |
| Same process          | 26   | 36  | 43  | 52  |
| Other process, hint   | 27   | 46  | 56  | 58  |
| Other process, NOTIFY | 6.16 | 12  | 16  | 20  |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s  |
| ----------------------------- | ------- |
| `enqueue`, a transaction each | 4,003   |
| `enqueueMany` of 100          | 112,444 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 989    |
| 1 process, concurrency 50   | 1,898  |
| 4 processes, concurrency 10 | 1,944  |

### postgres-18

Probe, with 1000 job names and 100,000 completed jobs (ms):

| Names with pending jobs | sqlane probe p50 | p95  | One query per name p50 |
| ----------------------- | ---------------- | ---- | ---------------------- |
| 0                       | 0.41             | 0.61 | 125                    |
| 1                       | 0.44             | 0.64 | 129                    |
| 10                      | 0.58             | 0.98 | 126                    |
| 100                     | 0.96             | 1.54 | 129                    |
| 1000                    | 4.34             | 6.06 | 77                     |

From the COMMIT of the enqueue to the start of the handler, one job at a time (ms):

| Worker                | p50  | p95 | p99 | max |
| --------------------- | ---- | --- | --- | --- |
| Same process          | 26   | 34  | 153 | 193 |
| Other process, hint   | 26   | 45  | 57  | 181 |
| Other process, NOTIFY | 6.02 | 12  | 17  | 29  |

Throughput (jobs/s):

| Enqueue, 8 producers          | Jobs/s  |
| ----------------------------- | ------- |
| `enqueue`, a transaction each | 3,970   |
| `enqueueMany` of 100          | 110,016 |

| Run, empty handler          | Jobs/s |
| --------------------------- | ------ |
| 1 process, concurrency 10   | 1,192  |
| 1 process, concurrency 50   | 2,038  |
| 4 processes, concurrency 10 | 2,411  |

## Notes

- **Idle names cost nothing:** the probe reads only the names with pending jobs. 1000 handled names with 10 pending
  ones: under 1 ms. The `UNION` grows with all names: 42 ms on MySQL, 125–155 ms on PostgreSQL.
- **Latency:** about 25–30 ms with re-probes or a hint: the first re-probe is 20 ms after the enqueue, then the claim.
  NOTIFY comes after the commit: about 6 ms. A rare commit slower than a re-probe step waits for the next one (the
  PostgreSQL 18 p99).
- **Throughput:** each job takes a claim, a payload read and a result write. More concurrency or more processes share
  the same tables. Not profiled yet.
