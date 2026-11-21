---
'@sqlane/core': minor
---

`sqlane.jobs` reads the jobs in the database. `jobs.get(jobId)` returns one job with its payload, or `null`.
`jobs.list({ jobName, status }, { limit, cursor, includePayload })` lists the jobs of a name, newest first, a page at a
time, with an opaque cursor bound to its filter. A job is a `JobRecord`: its status, attempts, times, last error, keys,
what it is blocked on, and its payload. The reads require the migration `0008_job_list`.

The new types are `SqlaneJobs`, `JobRecord`, `JobStatus`, `JobError`, `JobFilter`, `ListJobsOptions` and `JobPage`, and
`HandlerPayload` is exported. `FailedJobPayload.error` is a `JobError`, the same shape as before.
