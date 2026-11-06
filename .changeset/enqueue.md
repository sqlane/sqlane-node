---
'@sqlane/core': patch
---

`enqueue()` and `enqueueMany()` add jobs with the caller's connection, in its transaction (or a transaction of their own
with a pool). A `jobId` adds one job while its row exists: a duplicate resolves to `{ created: false }` and changes
nothing. `createSqlane` checks its options: unknown options, `jobs`, `unknownJobs`, `maxPayloadBytes`, `defaults`.
