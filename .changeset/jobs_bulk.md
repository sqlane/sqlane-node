---
'@sqlane/core': minor
---

`sqlane.jobs` retries, cancels and removes jobs in bulk.

- `jobs.retry(selector, options)` runs failed jobs again: pending, with the same id and enqueue time, due now or when
  the lingering slots of their earlier runs end. `budget: 'reset'` (the default) sets `attempts` and `stalls` back to
  0; `budget: 'one_more'` gives exactly one more attempt and changes the stored maxes. A job without a payload is not
  retried.
- `jobs.cancel(selector, options)` fails pending and blocked jobs at once, with a `JobCancelledError` as `lastError` and
  no failure job, and emits a `cancelled` event after the commit.
- `jobs.remove(selector, options)` deletes jobs in any status but running, with their payloads.

A selector is `{ jobIds }`, up to 1000 full ids, or a filter as `jobs.list` takes it. A call runs in one transaction by
default: sqlane's own, one of its own on a pool given as `connection`, or the caller's transaction. `mode: 'batches'`
walks a large filter in short transactions. `strict: true` rejects with an `IgnoredJobsError` when an id would be
ignored. The result has the count of the changed jobs, their ids with `includeAffectedJobIds`, and the ignored ids with
a reason. A running job is never changed.

New exports: `JobCancelledError`, `IgnoredJobsError`, and the types `JobSelector`, `BulkOptions`, `RetryOptions` and
`BulkResult`. `SqlaneJobs` gains a type parameter for the connection, with a default, and three methods: code that
implements it, such as a mock, needs them. The `SqlaneEvent` union gains `cancelled`: a `switch` over its types needs a
`default`. Adapters gain an optional member, `poolTransaction`; an adapter of your own without it runs a pool given as
`connection` as a caller's connection.
