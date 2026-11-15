# Benchmarks

The benchmarks have two jobs: to catch a performance regression of sqlane before it ships, on every supported
database, and to compare sqlane with other job queues for the [performance page](../performance_vs_other_libs.md).

| Command                    | What it does                                                                                    | Time       |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ---------- |
| `pnpm bench:statements`    | Statements, rows and blocks of sqlane's hot paths on each supported version, against a snapshot | 2 min (CI) |
| `pnpm bench:regression`    | CPU instructions and statements per operation: the working tree against `main`                  | 5–6 min    |
| `pnpm bench:vs-other-libs` | sqlane and seven other queues on PostgreSQL ([bench/compare](../../bench/compare/README.md))    | 10 min     |
| `pnpm bench:generate-docs` | The charts and the generated blocks of the performance page and the README, from the results    | a second   |

## Regressions

The six hot paths: `enqueue` in a transaction of its own, `enqueueMany` of 100, a job claimed, run and completed over
1000 job names, idle with 1000 job names, a schedule firing (1000 schedules), and a job with a mutex key.

**`pnpm bench:statements`** runs them as fixed sequences of public calls (`bench/regression/scenarios.mjs`) on each
supported version in a container, and counts the statements, the rows and the blocks from the database's own
statistics (`pg_stat_statements`, `performance_schema`). CI fails when a count leaves the range of
`bench/regression/snapshot.json`, with a margin of 2% for statements and 20% for rows and blocks; one more statement
per operation leaves it in every scenario. A change of a hot path that adds or removes statements on purpose updates
the snapshot: `pnpm bench:statements:update` runs each scenario 10 times and keeps the range (about 20 minutes).
`--db mysql-8.4` and `--scenario run` narrow a run.

**`pnpm bench:regression`** runs the same hot paths under steady load in separate processes (`bench/regression/app.mjs`), on
PostgreSQL, MySQL and MariaDB from binaries, for the working tree and a baseline (`--ref main`, the default; `--ref .`:
the working tree itself). Per operation it reports the CPU instructions of the sqlane processes and the database
server, and the statements. A difference beyond ±5% in instructions or ±3% in statements reruns that pair once, and only
a confirmed slowdown fails. `--db`, `--scenario` and `--window` narrow a run; `--save <file>` writes the numbers.

On macOS, the servers come from Homebrew (`postgresql@17`, `mysql@8.4`, `mariadb@11.8`; `PG_BIN`, `MYSQL_BIN`,
`MARIADB_BIN` for others), and the counters from `bench/lib/proc_usage.py`. On Linux, `bench/run_linux.sh regression` runs it
in the container of `bench/compare/linux.dockerfile`, with the counters of `bench/lib/proc_usage_linux.py`.

## Publishing

The performance page and the README's charts come from one Linux machine:

```sh
bench/run_linux.sh vs-other-libs                                           # bench/compare/results.json
bench/run_linux.sh regression --ref . --save bench/regression/results.json   # sqlane on each backend
pnpm bench:generate-docs                                                      # the charts and the generated blocks
```

`kernel.perf_event_paranoid` must be 1 or less on the host, or the counters see user space only: the results say so
(`kernelCounted`), and the runs warn.

## The three numbers

`bench/lib/proc_usage.py` (macOS) reads two hardware counters per process with `proc_pid_rusage`, and the CPU time from
`ps`; `bench/lib/proc_usage_linux.py` (Linux) opens them on every thread with `perf_event_open`, and reads the CPU time
from `/proc`.

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
5. **Processes that exit lose their counters.** The pools of the benchmarks have no idle timeout, and the worker and
   producer live until the second reading, so their connections do too.
6. **Statement statistics are not CPU.** `pg_stat_statements` gives execution and planning time; the
   `performance_schema` of MySQL and MariaDB gives latency, so its `COMMIT` includes the wait for the disk.
7. **Unix sockets** in a long temporary path exceed the 104-byte limit of macOS: the benchmarks use TCP.

## Finding where the cost is

`pnpm bench:regression` says how much. These say where.

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
