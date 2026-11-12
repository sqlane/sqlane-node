# Queue comparison

The harness behind [docs/comparison.md](../../docs/comparison.md) (features) and
[docs/comparison-performance.md](../../docs/comparison-performance.md) (performance). It runs the libraries; the
documents report what they did.

```sh
pnpm bench:compare                                # checks and performance of jobs, about 13 minutes
pnpm bench:compare --only checks                  # the feature checks, about 1.5 minutes
pnpm bench:compare --only perf --libs sqlane,river
pnpm bench:compare --only cron                    # the schedules, about 9 minutes
```

`--only` and `--libs` select runs: the other rows of `results.json` stay. Each command stays under 15 minutes.

Requirements: macOS, Node.js 24 or later, and the servers from Homebrew: `postgresql@17`, `mysql@8.4`,
`mariadb@11.8` (`--pg-bin`, `--mysql-bin`, `--mariadb-bin` for others). The run starts private servers on ports 55442,
53317 and 53318, with data in a temporary directory, and stops them at the end. It writes `results.json` here and
prints Markdown tables.

The libraries are installed apart from sqlane, from this directory's `package.json` and lockfile: the script installs
them. sqlane runs from this checkout. The root type check skips this directory, which has its own dependencies:
`pnpm --dir bench/compare install && pnpm exec tsc -p bench/compare` checks it.

## Adding or updating a library

The libraries run code on this machine, so each one goes through the same checks, in `pnpm-workspace.yaml` and by
hand. Record the output of each check with the change.

- **Guardrails** (`pnpm-workspace.yaml`): exact pins (`saveExact`), no build script unless `allowBuilds` lists it
  (`strictDepBuilds`), releases at least 7 days old (`minimumReleaseAge`), no package that lost its trusted publishing
  or provenance (`trustPolicy: no-downgrade`), and no dependency of a dependency from git or a URL
  (`blockExoticSubdeps`). An exception names one version and says why.
- **Who publishes it:** `npm view <package>@<version> dist.attestations maintainers repository license`: provenance,
  the maintainers, a repository that matches the package, and a license.
- **Signatures and advisories:** `npm audit signatures` and `pnpm audit` in this directory: no high or critical
  finding.
- **Install scripts:** the diff of `pnpm-lock.yaml` shows no new `requiresBuild` or lifecycle script that
  `allowBuilds` does not deny.
- **Pins:** an exact version in `package.json` for the library and for each optional peer that it uses (a driver, a
  Redis client).
- **Age:** the release is at least 7 days old.
- **Processes:** `run.mjs` starts the library's processes with PATH, HOME and NODE_* only: pass what the library needs
  as arguments.

## Files

| File                 | What                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/<library>.mjs` | An adapter per library: the same small interface (`libs/common.mjs`), each in its library's own way. Its notes and limits say how it maps an option. |
| `checks.mjs`         | The feature checks: each library in a database of its own per check, the libraries in parallel.                                                      |
| `check_child.mjs`    | The worker that the stall check kills.                                                                                                               |
| `perf.mjs`           | One process of a performance workload: setup, worker or producer. With schedules, one of several workers.                                            |
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
guarantee, so the same workload. PostgreSQL for all, plus sqlane on MySQL and MariaDB.

- **Setup.** 1000 job names, as each library models them: sqlane handlers, pg-boss queues (a `work()` each), Graphile
  Worker tasks, River kinds in one queue. A worker process with 8 slots, empty handlers, a poll of 5 s, and each
  library's wakes (LISTEN/NOTIFY; on MySQL and MariaDB, a UDP hint stands in for Redis, as in `bench:cpu`).
- **Settings.** Each adapter uses the settings that its library's documentation offers for throughput, and says in a
  comment which, why and the default. pg-boss: `batchSize` of the 8 slots and `burstWhenBatchFull`, so a full fetch
  fetches again at once instead of after the next poll (defaults 1 and off). River: `fetchCooldown` of 1 ms, its
  minimum (default 100 ms), with the same 8 `maxWorkers`. A new library is one adapter in `libs/`.
- **Steady load.** A producer process enqueues 20 jobs/s, each in a transaction with an `INSERT` into a business
  table. 9 of 10 jobs go to 10 hot names. 5 s warm-up, 15 s window. A library whose enqueue cannot take the caller's
  transaction (`transactional: false` in its adapter) enqueues after the `COMMIT`, on its own connection: not atomic,
  and its rows say so.
- **Idle.** 1 and 1000 job names, no jobs.
- **Drain.** 10,000 due jobs over the names, enqueued before the worker starts. The time until the worker has run
  them all, at most 60 s: a longer drain stops, and its row gives the jobs that ran.
- **Two phases.** A lane per library and database that its adapter lists (`databases`), each with a server of its
  own. Phase A, for instructions: all the lanes at once, one workload at a time, their windows started together
  (steady, idle with 1 and with 1000 names, drain). Steady and idle instructions barely depend on the load of the
  machine; drain instructions do, so the drains come from phase B. Phase B, for times, on the PostgreSQL lanes: one
  lane at a time, the drains (their backlogs prepared in parallel), then the steady load, for the latency and the CPU
  time. Its rows have `timing: true`; it also checks phase A's instructions on those lanes.
- **Counters.** Instructions retired, cycles and CPU time of each process (`bench/cpu/proc_usage.py`), the database
  with all its processes. Compare instructions: see [CPU cost per job](../../docs/cpu-cost.md#the-three-numbers). On
  PostgreSQL, `pg_stat_statements` counts the statements of the window, and `pg_stat_activity` the connections.

### Schedules

`--only cron`, apart from the default run. PostgreSQL only. The schedules belong to one job name and differ by a key
(`s0000`…`s0999`), so the numbers are the cost of the schedules, not of 1000 job names. Each library schedules in its
own way: sqlane `schedule()`, pg-boss `schedule()` (stored by the setup), Graphile Worker crontab items, River periodic
jobs, with the settings above. pg-boss also forwards its cron occurrences every 1 s (`cronWorkerIntervalSeconds`,
default 5 s), the shortest that its scheduling documentation allows.

- **In parallel, 3 times.** The 5 runs of each library, of all the libraries, run at once, each in a database of its
  own, on a PostgreSQL server per library (ports from 55450; macOS allows about 32 servers at once). Each run counts
  the backends of its database's connections, and its own statements. The runs start together, after all their
  workers are ready. The whole set runs 3 times: a row of `results.json` has the median of each number, and each run in
  `samples`. Instructions do not depend on the load of the machine; latencies do: see the limits in the document.
- **cron-idle.** 1 and 1000 schedules of a daily cron 12 hours from the start, and 1000 of a yearly one
  (`0 0 1 1 *`), 1 worker, no jobs. A 10 s warm-up, then a 120 s window: twice the longest check (sqlane's longest
  timer sleep and Graphile Worker's minute timer, 60 s; pg-boss's cron pass, 30 s; River's election, 5 s), so each
  check counts a whole number of times.
- **cron-fire.** 1000 schedules of `* * * * *`, empty handlers, with 1 and with 3 worker processes. Two slots: the
  first comes at least 10 s after the start. The CPU window is one period, from 30 s after the first slot to 30 s
  after the second, and is divided by the 1000 slots of a minute. The jobs of both slots get 70 s after the second to
  start. Each worker notes the slot and the start of each scheduled job, for the lag. After the workers stop, the
  library's tables give the jobs that it stored (`scheduledJobs` of each adapter); Graphile Worker deletes a completed
  job, so its handlers' notes count too. Per key and slot, 1 job is expected. pg-boss's jobs do not carry the slot: its
  forwarding jobs do. Each key's jobs must not outnumber its forwarding jobs that ran, and they pair with them, in
  order, for the lag.
- **Time.** About 3 minutes per set, 9 in all.
