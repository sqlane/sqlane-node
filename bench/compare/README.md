# Queue comparison

The harness behind [docs/features_vs_other_libs.md](../../docs/features_vs_other_libs.md) (features) and
[docs/performance_vs_other_libs.md](../../docs/performance_vs_other_libs.md) (performance). It runs the libraries; the
documents report what they did.

```sh
pnpm bench:compare                                # checks and performance of jobs, about 10.5 minutes
pnpm bench:compare --only checks                  # the feature checks, about 1.5 minutes
pnpm bench:compare --only perf                    # the jobs, about 9 minutes
pnpm bench:compare --only perf --libs sqlane,river
pnpm bench:compare --only cron                    # the schedules, about 9.5 minutes
```

`--only` and `--libs` select runs: the other rows of `results.json` stay. Each command stays under 15 minutes.

Requirements: macOS, Node.js 24 or later, and the servers from Homebrew: `postgresql@17`, `mysql@8.4`,
`mariadb@11.8`, `redis` (`--pg-bin`, `--mysql-bin`, `--mariadb-bin`, `--redis-bin` for others). The run starts
private servers on ports from 55442 (PostgreSQL), 53317 (MySQL and MariaDB) and 56380 (Redis), with data in a
temporary directory, and stops them at the end. It writes `results.json` here and
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

sqlane, pg-boss, Graphile Worker, River, Izi Queue and Boring Node Queue enqueue in the caller's transaction; BullMQ
and Sidequest enqueue after the `COMMIT`. Each library on each database that its adapter lists: sqlane and Boring
Node Queue on PostgreSQL, MySQL and MariaDB; Sidequest and Izi Queue on PostgreSQL and MySQL; BullMQ on Redis and on
PostgreSQL; the others on PostgreSQL.

Oxen Queue: not compared (it pins mysql2 3.16.3, which has a known high-severity flaw).

- **Setup.** 1000 job names, as each library models them: sqlane handlers, pg-boss queues (a `work()` each), Graphile
  Worker tasks, River kinds in one queue, BullMQ job names in one queue, Sidequest job classes (`sidequest_jobs.mjs`),
  Boring Node Queue job classes (`Locator.register`), Izi Queue workers. A worker process with 8 slots, empty
  handlers, and each library's wakes: LISTEN/NOTIFY with a poll of 5 s as a fallback where the library has them; on
  MySQL and MariaDB, sqlane's hint goes over UDP, standing in for Redis, as in `bench:cpu`. A library that only polls
  keeps its default poll.
- **Settings.** Each adapter uses the settings that its library's documentation offers for throughput, and says in a
  comment which, why and the default. pg-boss: `batchSize` of the 8 slots and `burstWhenBatchFull`, so a full fetch
  fetches again at once instead of after the next poll (defaults 1 and off). River: `fetchCooldown` of 1 ms, its
  minimum (default 100 ms), with the same 8 `maxWorkers`. The others: their defaults. A new library is one adapter in
  `libs/`.
- **Redis.** BullMQ's Redis runs with the append-only file synced every second (`appendfsync everysec`) and no
  snapshots. Its database is Redis plus the PostgreSQL of the business table.
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
  machine; drain instructions do, so the drains come from phase B. Phase B,
  for times, on the PostgreSQL and Redis lanes: one lane at a time, the drains (their backlogs prepared in parallel),
  then the steady load, for the latency and the CPU time. Its rows have
  `timing: true`; it also checks phase A's instructions on those lanes.
- **Counters.** Instructions retired, cycles and CPU time of each process (`bench/cpu/proc_usage.py`), the database
  with all its processes. Compare instructions: see [CPU cost per job](../../docs/contributing/measuring_cpu_cost.md#the-three-numbers). On
  PostgreSQL, `pg_stat_statements` counts the statements of the window, and `pg_stat_activity` the connections.

### Schedules

`--only cron`, apart from the default run. The schedules belong to one job name and differ by a key
(`s0000`…`s0999`), so the numbers are the cost of the schedules, not of 1000 job names. Each library schedules in its
own way: sqlane `schedule()`, pg-boss `schedule()` (stored by the setup), Graphile Worker crontab items, River periodic
jobs, BullMQ job schedulers (`upsertJobScheduler`, stored by the setup), Sidequest `schedule()` in worker 0, Boring
Node Queue `schedule().id()` (stored by the setup), Izi Queue CronPlugin entries in each worker, with the settings
above. pg-boss also forwards its cron occurrences every 1 s (`cronWorkerIntervalSeconds`, default 5 s), the shortest
that its scheduling documentation allows. Sidequest registers its schedules in worker 0 only, its documentation's
"restrict scheduling to a single node": its other option, uniqueness per period, rejects every run after the first
with `schedule()`. Izi Queue's CronPlugin ticks every 1 s (`interval`, default 60 s). Each adapter's comment says how its library keeps a slot to one
job.

- **In parallel, 3 times.** A lane per library and database that its adapter lists, but MariaDB. The 5 runs of each
  lane, of all the lanes, run at once, each in a database of its own. PostgreSQL: a server per lane (ports from 55450;
  macOS allows about 32 servers at once), and each run counts the backends of its database's connections, and its own
  statements. Redis (ports from 56450) and MySQL (ports from 53450): a server per run, whose process is the run's
  database, and no statements; on MySQL, the 2 firing runs only. The runs start together, after all their
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
  library's tables give the jobs that it stored (`scheduledJobs` of each adapter; BullMQ on Redis: its keys); Graphile
  Worker and Boring Node Queue delete a completed job, so their handlers' notes count too. Per key and slot, 1 job is
  expected. pg-boss's jobs do not carry the slot: its forwarding jobs do. Each key's jobs must not outnumber its
  forwarding jobs that ran, and they pair with them, in order, for the lag.
- **Time.** About 3 minutes per set, 9.5 in all (53 runs).
- **Kept by hand.** `pooled` (pg-boss with 3 workers: the run with the median total among this row's 3 runs and
  those of `cronHistory`), `cronHistory` (the earlier runs of the day) and `sidequestUniquePerMinute` in
  `results.json` were assembled by hand: `run.mjs` does not write them, and a new `--only cron` run drops `pooled`
  (`charts.mjs` then uses the single run).
