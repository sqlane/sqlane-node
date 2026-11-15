# Queue comparison

The harness behind [docs/features_vs_other_libs.md](../../docs/features_vs_other_libs.md) (features) and
[docs/performance_vs_other_libs.md](../../docs/performance_vs_other_libs.md) (performance). It runs the libraries; the
documents report what they did.

```sh
pnpm bench:compare                                # checks and performance of jobs
pnpm bench:compare --only checks                  # the feature checks, about 1.5 minutes
pnpm bench:compare --only perf                    # the jobs
pnpm bench:compare --only perf --libs sqlane,river
pnpm bench:compare --only cron                    # the schedules
pnpm bench:compare --parallel 8                   # at most 8 runs at once
```

`--only` and `--libs` select runs: the other rows of `results.json` stay. `--parallel` caps the runs that share the
machine: phase A of the jobs and the schedule runs go in batches of that size (unlimited by default). With too many
runs per core, the libraries fall behind the load and the numbers are wrong: on 4 cores, unlimited runs missed slots.
The run starts private servers (`bench/lib/servers.mjs`) on ports from 55442 (PostgreSQL) and 56380 (Redis), with data
in a temporary directory, and stops them at the end. It writes `results.json` here, with the machine of each part
(`machines`: also the loopback's delay, `latency`, whether the counters count the kernel, `kernelCounted`, and the
part's `seconds`), and prints Markdown tables. `pnpm bench:docs` ([generate_docs.mjs](../generate_docs.mjs)) then
draws the documents' charts from it into `docs/images` and rewrites the generated blocks of the documents (between
`<!-- generated:NAME -->` markers); the prose around them is written by hand.

### Linux: the published numbers

The documents' numbers come from Linux, in the container of `linux.dockerfile`: Node.js, pnpm, PostgreSQL and Redis at
pinned versions (MySQL and MariaDB too, which the comparison doesn't use), every download checked against its SHA-256.
`bench/run_linux.sh compare` runs the whole comparison there (`bench/run_linux.sh ab …`: the A/B regression run of
`bench/regression/ab.mjs` in the same container, without the delay):

```sh
podman build -f bench/compare/linux.dockerfile -t sqlane-bench:linux bench/compare
bench/run_linux.sh compare        # ENGINE=docker for Docker
```

- **Network latency.** The servers listen on the loopback, where a round trip takes microseconds; a database is
  usually across a network. The script adds 0.5 ms each way on the container's loopback
  (`tc qdisc add dev lo root netem delay 0.5ms`), so each round trip between a client and its database costs about
  1 ms. `tc` needs root in the container (`--cap-add NET_ADMIN`) and PostgreSQL refuses root, so the container starts
  as root, adds the delay, and runs the comparison as the image's `bench` user (`setpriv`). `run.mjs` reads the delay
  from `tc qdisc show dev lo` into `machines.<part>.latency`, and warns on Linux without one.
- **Counters.** `bench/lib/counters.mjs` runs `bench/lib/proc_usage_linux.py`, which opens a hardware counter on
  every thread of the container (`perf_event_open`). It counts the kernel too with `CAP_PERFMON` in the host's user
  namespace, or with `kernel.perf_event_paranoid` of 1 or less on the host: a rootless container's `CAP_PERFMON` is
  not enough (`sudo sysctl kernel.perf_event_paranoid=1`). Without it, the run warns, counts user space only, and
  records `kernelCounted: false`.

On a Ryzen 5 3600 (6 cores, 12 threads), the whole run takes about 10 minutes: the checks about 1.5, the jobs about
5.5, the schedules about 3.

### macOS: for development

Node.js 24 or later and the servers from Homebrew: `postgresql@17` and `redis` (`--pg-bin`, `--redis-bin` for
others). The counters come from `bench/lib/proc_usage.py` (`proc_pid_rusage`). No netem: `latency` is null, and the
latencies are those of a bare loopback. Good for comparing two versions of sqlane on one machine; the documents don't
use these numbers.

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
| `../run_linux.sh`    | The published run (`compare`): the whole comparison in the container of `linux.dockerfile`, with 0.5 ms each way on its loopback.                    |

## Checks

Each check runs a scenario and reports what happened: **Yes**, **Partial** (it works with a workaround or a fixed
setting, given in the note) or **No** (with the reason, or what happened instead).

| Check                               | Scenario                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enqueue in the caller's transaction | Two transactions each insert an order and enqueue a job; the first rolls back. Only the job of the committed order may run. A library without such an API enqueues on its own connection, and the job of the rolled-back order runs. |
| Delayed job                         | A job with a delay of 2 s must not start sooner.                                                                                                                                                                                     |
| Retry after a configured backoff    | The first attempt throws; the second must start 2 s later.                                                                                                                                                                           |
| Timeout aborts the handler          | A job with a timeout of 1 s: its handler's abort signal must fire.                                                                                                                                                                   |
| Job of a killed worker runs again   | A worker process takes a job and gets `SIGKILL`. Another worker must run the job again within 70 s, with the shortest recovery settings that the library allows (in the note).                                                       |
| Mutex key across job names          | Jobs of two names; two share a resource. They must not overlap, while the others run in parallel.                                                                                                                                    |
| Multiple mutex keys per job         | Each job has two resources: a job with `alice` and `bob` must not overlap one with `bob` and `carol`.                                                                                                                                |
| Priority                            | Three low and one high priority jobs wait for a worker with one slot: the high one must run first.                                                                                                                                   |

## Performance

On PostgreSQL, and BullMQ also on Redis: a lane per library and database among those that its adapter lists
(`databases`), PostgreSQL or Redis; the adapters' MySQL and MariaDB lanes don't run here. sqlane, pg-boss, Graphile
Worker, River, Izi Queue and Boring Node Queue enqueue in the caller's transaction; BullMQ and Sidequest enqueue after
the `COMMIT`.

Oxen Queue: not compared (it pins mysql2 3.16.3, which has a known high-severity flaw).

- **Setup.** 1000 job names, as each library models them: sqlane handlers, pg-boss queues (a `work()` each), Graphile
  Worker tasks, River kinds in one queue, BullMQ job names in one queue, Sidequest job classes (`sidequest_jobs.mjs`),
  Boring Node Queue job classes (`Locator.register`), Izi Queue workers. A worker process with 8 slots, empty
  handlers, and each library's wakes: LISTEN/NOTIFY with a poll of 5 s as a fallback where the library has them. A
  library that only polls keeps its default poll.
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
  and its rows say so. `keptUp`: the worker ran at least 95% of the window's jobs.
- **Idle.** 1000 job names, no jobs, a 15 s window.
- **Two phases.** Phase A, for instructions and statements: the lanes at once (in batches of `--parallel`), one
  workload at a time (steady, then idle), their windows started together; instructions barely depend on the load of
  the machine. Phase B, for times: one lane at a time, the steady load, for the latency (enqueue to handler start, p50
  and p99) and the CPU time. Its rows have `timing: true`.
- **Counters.** Instructions retired, cycles and CPU time of each process, the database with all its processes. Compare
  instructions: see [the three numbers](../../docs/contributing/benchmarks.md#the-three-numbers).
- **Statements per job.** `pg_stat_statements` counts the statements of the window's database (`statements`) and
  `pg_stat_activity` its connections. `queueStatements` leaves out the benchmark's own business work: each job of the
  producer is `BEGIN`, `INSERT INTO orders`, the library's enqueue, `COMMIT`. The statements that name the business
  table `orders`, which no library touches, are the business `INSERT`s; each came with one `BEGIN` and one `COMMIT`, so
  `businessStatements` is 3 per `INSERT`, and `queueStatements` the rest: the library's enqueue, its own transactions,
  its worker. On BullMQ's Redis lane, whose PostgreSQL holds the business table only, `queueStatements` comes out at 0:
  the check of the method.
- **Redis commands per job.** `INFO commandstats` before and after the window: `redisCommands` is the difference, less
  the 1 `INFO` of the first reading, and `redisByCommand` the same per command. Redis counts the commands that its Lua
  scripts call too: `evalsha` is the number of script calls.

### Schedules

`--only cron`, apart from the default run. The schedules belong to one job name and differ by a key
(`s0000`…`s0999`), so the numbers are the cost of the schedules, not of 1000 job names. Each library schedules in its
own way: sqlane `schedule()`, pg-boss `schedule()` (stored by the setup), Graphile Worker crontab items, River periodic
jobs, BullMQ job schedulers (`upsertJobScheduler`, stored by the setup), Sidequest `schedule()` in worker 0, Boring
Node Queue `schedule().id()` (stored by the setup), Izi Queue CronPlugin entries in each worker, with the settings
above. pg-boss also forwards its cron occurrences every 1 s (`cronWorkerIntervalSeconds`, default 5 s), the shortest
that its scheduling documentation allows. Sidequest registers its schedules in worker 0 only, its documentation's
"restrict scheduling to a single node": its other option, uniqueness per period, rejects every run after the first
with `schedule()`. Izi Queue's CronPlugin ticks every 1 s (`interval`, default 60 s). Each adapter's comment says how
its library keeps a slot to one job.

- **The runs.** 1000 schedules of `* * * * *`, empty handlers, 3 worker processes. A run per lane, as for the jobs,
  each with a server of its own (PostgreSQL: ports from 55450, each run counts the backends of its database's
  connections; Redis: ports from 56450, with a PostgreSQL for the setup's business table), all at once (with
  `--parallel`, in batches). They start together, after all their workers are ready. One run each
  (`CRON_REPEATS`; with more, a row has the median of each number, and each run in `samples`).
- **Window.** Two slots: the first comes at least 10 s after the start. The CPU window is one period, from 30 s after
  the first slot to 30 s after the second, and is divided by the 1000 slots of a minute; so are `queueStatements`
  (no business work here) and BullMQ's `redisCommands`. The jobs of both slots get 70 s after the second to start.
- **Slots.** Each worker notes the slot and the start of each scheduled job, for the lag. After the workers stop, the
  library's tables give the jobs that it stored (`scheduledJobs` of each adapter; BullMQ on Redis: its keys); Graphile
  Worker and Boring Node Queue delete a completed job, so their handlers' notes count too. Per key and slot, 1 job is
  expected: `decided` and `started` of `expected` (2000), and `duplicates`. pg-boss's jobs do not carry the slot: its
  forwarding jobs do. Each key's jobs must not outnumber its forwarding jobs that ran, and they pair with them, in
  order, for the lag.
- **Time.** About 3 minutes.

## Limits

What the documents leave out: how far the numbers can be trusted.

- **One machine, one run.** 15 s windows: differences of about 10% are noise. The setups don't have the same
  capacity: pg-boss has its slots per queue, the others 8 in all.
- **The two phases agree.** On the PC run of 14 November 2026 (`--parallel 8`), phase B's instructions per job were
  within 5% of phase A's at steady load on all 9 lanes.
- **The latency is a model.** netem delays every packet on the loopback by the same 0.5 ms, with no jitter, loss or
  bandwidth limit: it counts round trips, not a real network.
- **What the database counts.** On PostgreSQL, the processes of its connections only, not autovacuum or the
  checkpointer. On Linux, a counter opens up to 50 ms after a thread starts: the pools keep their connections, so a
  window loses next to nothing.
- **Statements and commands.** A statement or a command is not a unit of cost: one may scan a table, another touch a
  row. They count round trips and work items; the instructions give the cost.
- **Boring Node Queue 0.9.1**, not 0.10.0: 0.10.0 came out on 12 November 2026, less than the 7 days that the
  guardrails require.
- **Schedule lags aren't in the documents.** They depend on how many runs fire in the same second on the machine;
  `results.json` keeps them.
- **The slot of a scheduled job.** sqlane and River give the handler the slot (`scheduledAt`), Graphile Worker the
  payload's `_cron.ts`, BullMQ `prevMillis`, Izi Queue `meta.cronMinute`. Sidequest's slot is the minute of the job's
  insert, Boring Node Queue's the minute a worker took it: right while the lag stays under a minute.
- **One job per slot.** For sqlane it is enforced, not measured: the job id `<name>:schedule:<key>:<slot>` is the
  primary key. The runs cover a steady state only, not a leader change, a crash, a missed slot or clock skew.
