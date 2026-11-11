# CPU cost per job

How to measure what one job costs in CPU: in the worker, in the process that enqueues it, and in the database. Use it
to check a change that should make sqlane cheaper, or to find what to optimize next. The [benchmarks](benchmarks.md)
measure latency and throughput instead.

## Quick start

```sh
pnpm bench:cpu                                   # main vs the working tree, PostgreSQL, MySQL and MariaDB
BASE=v2.0.0 DIALECTS=postgres pnpm bench:cpu     # another baseline, one database
BASES="main v2.0.0" pnpm bench:cpu               # several baselines, against the same database server
```

It takes about 3 minutes and prints a table:

| Database | Variant      | Jobs | Instructions                       | Cycles                          | CPU ms                          |
| -------- | ------------ | ---- | ---------------------------------- | ------------------------------- | ------------------------------- |
| postgres | main         | 399  | 23.21 / 0.96 / 131.89 = **156.06** | 6.78 / 1.19 / 27.32 = **35.29** | 2.83 / 0.55 / 11.53 = **14.91** |
| postgres | working tree | 400  | 1.18 / 0.61 / 2.21 = **4.00**      | 2.34 / 2.48 / 4.00 = **8.82**   | 1.48 / 1.55 / 2.55 = **5.58**   |

Each cell is worker / producer / database = total, per job: instructions and cycles in millions, CPU in ms.

Requirements: macOS on Apple Silicon, `pnpm install`, and the servers from Homebrew: `postgresql@17`, `mysql@8.4`,
`mariadb@11.8`. `PG_BIN`, `MYSQL_BIN` and `MARIADB_BIN` point to other server binaries. The script starts private
instances on ports 55433, 53307 and 53308, with data in a temporary directory, and stops them at the end. Your own
database services are not touched. `WARMUP`, `MEASURE`, `NAMES`, `HISTORY` and `RATE` change the workload. `COMPLETED=1000000` adds that many
completed jobs, spread evenly over the names, for the cost with a large table (on PostgreSQL, one `INSERT` in a
few seconds). With a large table, use `MEASURE=40` or
more: a 20 s window can catch one periodic task and not the other. `MUTEX_KEYS=100` gives each job one of 100 mutex keys, with
handlers that hold it for 20 ms; the worker counts the overlaps of a key and the wrong keys, and the table reports
them. `BLOCKED=10000`, with `MUTEX_KEYS`, adds that many due jobs, spread over the names, that wait for a key held
for a day: a backlog that each claim of a name with mutex keys reads past. `QUEUED=10000` adds that many due jobs on one free key: a long queue that runs one
job at a time. On PostgreSQL, `sizes.json` of each run has the sizes of the tables and indexes after the setup.

## What it runs

- **Workload.** 1000 job names. Each has one pending job a year ahead, so every name has pending jobs, as in a busy
  app. A producer process enqueues 20 jobs/s, from a pool, outside a transaction. 9 of 10 jobs go to 10 hot names, the
  rest to the others. A worker process runs them with empty handlers, concurrency 8, poll interval 5 s. So the numbers
  are the cost of the queue itself.
- **Wake-ups.** PostgreSQL uses NOTIFY. MySQL and MariaDB have none: a hint over UDP on localhost stands in for Redis
  pub/sub.
- **Databases.** Default configuration, read no `my.cnf`. MariaDB gets the binary log of MySQL 8.4 (`sync_binlog=1`,
  row format), as in the benchmarks. TCP only.
- **Window.** After a 5 s warm-up, the script reads the counters of each process, waits 20 s, reads them again, and
  divides by the jobs that the worker completed in between. `before.json` and `after.json` of each run also split the
  database by process title: its connections (`backend`), autovacuum, the checkpointer and so on. The database is its server process with all its
  descendants (PostgreSQL forks a process per connection).
- **Baseline.** `git archive <BASE>` gives the sources of the baseline; both variants use the drivers of the working
  tree. Each variant runs against the same server instance, after fresh tables.

The files: `bench/cpu/measure.sh` (the run), `bench/cpu/app.js` (the setup, worker and producer processes),
`bench/cpu/proc_usage.py` (the counters).

## The three numbers

`proc_usage.py` reads two hardware counters per process with `proc_pid_rusage` (no root needed for your own
processes), and the CPU time from `ps`.

- **Instructions retired**: how much work the code does. It does not depend on the core type, the clock or the load of
  the machine, so two runs agree within about 3%. Compare variants with it.
- **Cycles**: the time the CPU spent, without the clock speed. It still depends on the core type and on how warm the
  caches are.
- **CPU time**: what you pay for. It depends on everything above, and on the clock.

Instructions and cycles can move apart. In this example, `main` spent most of its work in one tight loop over 1000
names, at 3.5–5 instructions per cycle. The working tree removed that loop; the work left is a few statements per job,
each after an idle gap, on cold caches, with syscalls and wake-ups, at 0.7–1 instruction per cycle. So instructions
fell 97% and cycles 78%. Report both: instructions for the work removed, cycles or CPU time for the cost.

## Pitfalls

What made earlier measurements wrong:

1. **CPU time of a light process on Apple Silicon.** A process that wakes 20 times per second runs on an efficiency
   core or a slow clock when the machine is quiet, and on a fast core when it is busy. The same producer cost 1.1 ms
   per job next to a busy database and 3.8 ms next to an idle one. Running both variants side by side does not fix
   it: each process lands on its own mix of cores. Compare instructions instead.
2. **Profilers cost CPU.** The Node inspector at a 200 µs sampling interval adds about 2 ms of system time per job to
   the process. Use a profile for where the time goes, a run without profiler for how much.
3. **Docker Desktop.** The database runs in a Linux VM. About half of its CPU went to the bridge network and netfilter
   of Docker, which a production database does not pay. Docker is fine to profile the database with `perf`; take the
   numbers from the host.
4. **`perf record -a` in Docker** records every container of the VM, also the ones of a test run. Filter by the cgroup
   of the database container (below).
5. **Processes that exit lose their counters.** The pg pool of the benchmark has no idle timeout, and the worker and
   producer linger 3 s after the window, so their connections live until the second reading.
6. **Statement statistics are not CPU.** `pg_stat_statements` gives execution and planning time; the
   `performance_schema` of MySQL and MariaDB gives latency, so its `COMMIT` includes the wait for the disk.
7. **Unix sockets** in a long temporary path exceed the 104-byte limit of macOS: the script uses TCP.

## Finding where the cost is

`measure.sh` says how much. These say where.

**Node.** A CPU profile of the worker or the producer, for the measured window only:

```js
import { Session } from 'node:inspector/promises';

const session = new Session();

session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.start');
// … the window …
const { profile } = await session.post('Profiler.stop'); // write it as a .cpuprofile: Chrome DevTools opens it
```

Sum the samples by function (self time) and by caller chain (inclusive time). `node --cpu-prof` also works, but covers
the start-up too.

**PostgreSQL statements.** Load `pg_stat_statements` with planning time:

```sh
postgres -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track_planning=on
```

Reset it after the warm-up (`SELECT pg_stat_statements_reset()`), then read `calls`, `total_exec_time`,
`total_plan_time` and `shared_blks_hit` per job. Planning time above execution time means that a prepared statement
does not get a cached plan: check `generic_plans` and `custom_plans` in `pg_prepared_statements` after a few
`EXECUTE`s. `EXPLAIN (ANALYZE, BUFFERS)` compares rewrites of one statement.

**PostgreSQL internals with `perf`.** In Docker, on the database container, by its cgroup:

```sh
# An image with perf: FROM debian:bookworm-slim, apt-get install linux-perf
CID=$(docker inspect -f '{{.Id}}' <container>)
docker run --rm --privileged --cgroupns=host --pid=host -v "$PWD/out":/out perf-image \
    perf record -e cpu-clock -F 499 -a -G "docker/$CID" -g -o /out/perf.data -- sleep 30
```

For the symbols, copy the binaries out of the database container into a directory (`docker cp -L
<container>:/usr/lib/postgresql/15/bin/postgres symfs/usr/lib/postgresql/15/bin/`, and `libc.so.6`). Then
`perf report --symfs symfs --kallsyms kallsyms --comm postgres --children --sort sym`, where `kallsyms` is a copy of
`/proc/kallsyms` read in a privileged container after `echo 0 > /proc/sys/kernel/kptr_restrict`. The inclusive view
splits the time into planning (`pg_plan_queries`), parsing (`pg_parse_query`), execution (`standard_ExecutorRun`),
commits (`XLogFlush`) and the network (`secure_read`, `secure_write`). The binaries of the official image keep their
exported symbols; static functions show as addresses.

**MySQL and MariaDB statements.** `performance_schema.events_statements_summary_by_digest`, reset with `TRUNCATE`
after the warm-up. MariaDB needs `--performance-schema=ON`. Its times are latency (pitfall 6): use `COUNT_STAR` and
`SUM_ROWS_EXAMINED` per job to compare variants.

**On Linux,** `perf stat -e instructions,cycles -p <pid>` gives the same counters as `proc_usage.py`.
