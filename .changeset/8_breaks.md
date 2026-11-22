---
'@sqlane/core': major
---

`sqlane.jobs.stats()` counts the blocked jobs apart from the pending ones, and the completed jobs that sqlane keeps.
`sqlane.schedules.list()` lists the schedules. The enqueue option that deduplicates is `dedupeKey`.

Breaking changes:

- `sqlane.getStats()` is now `sqlane.jobs.stats()`. `pending` no longer counts the blocked jobs: add the new `blocked`
  for the number of 7.x. The new `completed` counts the completed jobs until cleanup deletes them, and a name with only
  completed jobs now has an entry. `stats()` reads every row kept, on every dialect: on MySQL and MariaDB it now also
  reads the rows of the completed jobs, so check the interval of your metric scrape.
- `sqlane.getSchedules()` is now `sqlane.schedules.list()`, with the same result.
- The enqueue option `jobId` is now `dedupeKey`, with the same rules, in `enqueue` and in the items of `enqueueMany`.
  The job id is still `<job name>:<dedupeKey>`. `jobId` rejects with an `InvalidOptionsError` that names `dedupeKey`.
- Types: `JobStats` gains `blocked` and `completed`; `EnqueueOptions.jobId` is now `dedupeKey`; the new
  `SqlaneSchedules`. See
  [Migrating from 7.x to 8.0](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/8.md).
