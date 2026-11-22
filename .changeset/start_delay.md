---
'@sqlane/core': minor
---

`JobInfo` and the `claimed` event carry the due time and the start time of a run. `JobInfo` gains `runAt` and
`startedAt`; the `claimed` event gains `runAt`, `enqueuedAt` and `startedAt`. `startedAt` is the database time of the
claim, the same as `JobRecord.startedAt`, so `startedAt − runAt` (the start delay) and `startedAt − enqueuedAt` (the
time since the enqueue) come from one clock. `runAt` is the job's due time as stored, its place in line: a block on a
key keeps it, and so does a `RateLimitedError` on a global rate key. The slots of global limits that a run takes get
its start time too.

Type changes, none at run time: a `JobInfo` or `HandlerContext` built by hand (in tests) needs `runAt` and
`startedAt`, and a `claimed` event built by hand needs `runAt`, `enqueuedAt` and `startedAt`.
