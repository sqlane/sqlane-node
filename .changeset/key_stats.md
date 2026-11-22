---
'@sqlane/core': minor
---

`sqlane.jobs.keyStats({ limit, type, orderBy })` lists the keys of the global limits that have blocked jobs, or held or
lingering slots, worst first: for alerts on a blocked chain (`orderBy: 'blocked'`) or on a key held too long
(`orderBy: 'held'`). A concurrency key shows its max, its held and lingering slots, its blocked jobs (up to 1000), and
the ages of its oldest blocked job and of its oldest slot. A rate key shows its blocked jobs, the age of the oldest, and
when it may start its next job. One statement on the queue's pool, with no new index or migration. New types:
`KeyStats`, `KeyStatsOptions`, `KeyStatsPage`.

Type change, none at run time: code that implements `SqlaneJobs` (a mock) needs `keyStats`.
