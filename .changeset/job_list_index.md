---
'@sqlane/core': minor
---

The migration `0008_job_list` adds an index on `(job_name, created_at, id)` of the jobs, for the lists of
`sqlane.jobs`, which require it. Run `migrate()`, or apply its statement with your own migration tool. The build waits
for the open transactions that wrote the jobs, and the writes wait for the build. On PostgreSQL it blocks the writes of
the table while it builds. On a large table, build it first, with the name and the columns of the migration, where
`<prefix>` is your `tablePrefix` (`sqlane_` by default):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS <prefix>jobs_list ON <prefix>jobs (job_name, created_at, id);
```

The migration then skips it. A failed or cancelled concurrent build leaves an invalid index that the migration would
also skip: check `SELECT indisvalid FROM pg_index WHERE indexrelid = '<prefix>jobs_list'::regclass`, and if it is
`false`, drop the index and build it again.
