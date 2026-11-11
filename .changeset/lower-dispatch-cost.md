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
