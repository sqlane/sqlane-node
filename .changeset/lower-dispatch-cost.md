---
'@sqlane/core': major
---

Lower the CPU cost of each job: about 70% less on PostgreSQL, 35–40% less on MySQL and MariaDB.

- A wake checks only the job names it concerns: a NOTIFY, a commit or a completion no longer probes every job name.
  The poll interval still checks all names.
- On PostgreSQL, a wake for job names without mutex keys claims their jobs at once: the claim also reports when the
  next job of each name is due, so no separate probe runs.
- The pg adapter uses named prepared statements (new option `prepare`, default `true`; set `false` behind PgBouncer
  before 1.21 in transaction mode). A claim of one name and a completion of one job use scalar parameters, so
  PostgreSQL reuses a cached plan.
- An enqueue on PostgreSQL is one statement that also sends its NOTIFY; on a pool it runs without `BEGIN`/`COMMIT`.
- New PostgreSQL migration `0002_pending_order`: the pending-jobs index becomes `(job_name, run_at, id)`, so claims read
  jobs in order without a sort. Run `migrate()` after the upgrade.
- MySQL and MariaDB: the checks that follow a hint probe only the names enqueued within their steps, and claim only
  names with due jobs. Under a steady load they no longer probe every job name.
- Mutex keys: a release wakes the jobs that wait for its keys (a NOTIFY or hint `#<key>`), not every job name. The
  FIFO of a key reads a new table, `sqlane_job_keys`: a row per key of each pending job, in the order of `run_at`
  (migrations `0003_job_keys` on PostgreSQL, `0002_job_keys` on MySQL and MariaDB). It no longer reads the due jobs of
  every name with mutex keys. Per job with mutex keys: about 25% fewer instructions on PostgreSQL, 85–90% fewer on
  MySQL and MariaDB; with a long queue on one key, 80–97% fewer. MariaDB no longer stalls with thousands of due jobs
  that wait for a held key. Processes of an older version ignore `#<key>` hints: during a rolling upgrade, their jobs
  with mutex keys can wait for the poll.
