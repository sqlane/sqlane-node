# Queue comparison

The harness behind [docs/comparison.md](../../docs/comparison.md) (features) and
[docs/comparison-performance.md](../../docs/comparison-performance.md) (performance). It runs the libraries; the
documents report what they did.

```sh
pnpm bench:compare                                # checks and performance, about 13 minutes
pnpm bench:compare --only checks                  # the feature checks, about 1.5 minutes
pnpm bench:compare --only perf --libs sqlane,river
```

Requirements: macOS, Node.js 24 or later, and the servers from Homebrew: `postgresql@17`, `mysql@8.4`,
`mariadb@11.8` (`--pg-bin`, `--mysql-bin`, `--mariadb-bin` for others). The run starts private servers on ports 55442,
53317 and 53318, with data in a temporary directory, and stops them at the end. It writes `results.json` here and
prints Markdown tables.

The libraries are installed apart from sqlane, from this directory's `package.json` and lockfile: the script installs
them. sqlane runs from this checkout. The root type check skips this directory, which has its own dependencies:
`pnpm --dir bench/compare install && pnpm exec tsc -p bench/compare` checks it.

## Files

| File                 | What                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/<library>.mjs` | An adapter per library: the same small interface (`libs/common.mjs`), each in its library's own way. Its notes and limits say how it maps an option. |
| `checks.mjs`         | The feature checks: each library in a database of its own per check, the libraries in parallel.                                                      |
| `check_child.mjs`    | The worker that the stall check kills.                                                                                                               |
| `perf.mjs`           | One process of a performance workload: setup, worker or producer.                                                                                    |
| `run.mjs`            | Starts the servers, runs the checks and the workloads, reads the counters, prints the tables.                                                        |

## Checks

Each check runs a scenario and reports what happened: **Yes**, **Partial** (it works with a workaround or a fixed
setting, given in the note) or **No** (with the reason, or what happened instead).

| Check                                       | Scenario                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enqueue in the caller's transaction         | Two transactions each insert an order and enqueue a job; the first rolls back. Only the job of the committed order may run. A library without such an API enqueues on its own connection, and the job of the rolled-back order runs. |
| Delayed job                                 | A job with a delay of 2 s must not start sooner.                                                                                                                                                                                     |
| Retry after a configured backoff            | The first attempt throws; the second must start 2 s later.                                                                                                                                                                           |
| Timeout aborts the handler                  | A job with a timeout of 1 s: its handler's abort signal must fire.                                                                                                                                                                   |
| Job of a killed worker runs again           | A worker process takes a job and gets `SIGKILL`. Another worker must run the job again within 70 s, with the shortest recovery settings that the library allows (in the note).                                                       |
| Exclusion by one resource, across job names | Jobs of two names; two share a resource. They must not overlap, while the others run in parallel.                                                                                                                                    |
| Exclusion by several resources per job      | Each job has two resources: a job with `alice` and `bob` must not overlap one with `bob` and `carol`.                                                                                                                                |
| Priority                                    | Three low and one high priority jobs wait for a worker with one slot: the high one must run first.                                                                                                                                   |

## Performance

Only the libraries that enqueue in the caller's transaction: sqlane, pg-boss, Graphile Worker and River. The same
guarantee, so the same workload. PostgreSQL for all, plus sqlane on MySQL and MariaDB (steady load only).

- **Setup.** 1000 job names, as each library models them: sqlane handlers, pg-boss queues (a `work()` each), Graphile
  Worker tasks, River kinds in one queue. A worker process with 8 slots, empty handlers, a poll of 5 s, and each
  library's wakes (LISTEN/NOTIFY; on MySQL and MariaDB, a UDP hint stands in for Redis, as in `bench:cpu`).
- **Tuned.** pg-boss and River run twice: with their defaults, and with the throughput settings that their
  documentation offers (`pg-boss:tuned`, `river:tuned`). pg-boss: `batchSize` of the 8 slots and
  `burstWhenBatchFull`, so a full fetch fetches again at once instead of after the next poll. River: `fetchCooldown`
  of 1 ms, its minimum (default 100 ms), with the same 8 `maxWorkers`.
- **Steady load.** A producer process enqueues 20 jobs/s, each in a transaction with an `INSERT` into a business
  table. 9 of 10 jobs go to 10 hot names. 5 s warm-up, 15 s window.
- **Idle.** 1 and 1000 job names, no jobs.
- **Drain.** 10,000 due jobs over the names, enqueued before the worker starts. The time until the worker has run
  them all.
- **Counters.** Instructions retired, cycles and CPU time of each process (`bench/cpu/proc_usage.py`), the database
  with all its processes. Compare instructions: see [CPU cost per job](../../docs/cpu-cost.md#the-three-numbers). On
  PostgreSQL, `pg_stat_statements` counts the statements of the window, and `pg_stat_activity` the connections.
