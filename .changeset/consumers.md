---
'@sqlane/core': major
---

The failure job of a job comes from the definition of its lane in the process that fails it, and a job past its
`maxStalls` fails at its next claim, in a process that adds its lane, instead of in the stall recovery.

Breaking changes:

- The failure lane is read from the definition of the worker when the job fails for good, no longer from the job row.
  A job enqueued under a definition with another `failureLane`, or with none, gets the failure job of the worker's
  definition, or none. A lane added by name, without a definition in `lanes`, has no failure lane: its jobs get no
  failure job.
- `JobRecord.failureLane` is removed, and the enqueue no longer writes the column `failure_lane` (it stays in the
  schema; the rows of 9.x keep their value, which nothing reads).
- The enqueue option `failureLane` is removed (`EnqueueOptions.failureLane`): it rejects as an unknown option. Set the
  failure lane in the definition of the lane.
- After `maxStalls` stalls, the next stall releases the job as any stall (its slots linger for one lease), with
  `stalls` one above `maxStalls`, and keeps its due time: it is due at once, in its place in line. Its next claim fails
  it at once, without running its handler and without an attempt used, with a `StalledError` and the failure job of
  the claiming process's definition. That claim ignores the global limits and rate limits of the job: it is never
  blocked, takes no global slot and no global quota, and no quota of the local rate limits. It still counts toward the
  local concurrency of the process while its fail is written.
  The events of the failure are `claimed`, then `failed` (`durationMs` 0), from the claiming process; the stall
  recovery emits only `stalled`. `drain()` counts the failure. A job of a lane that no process adds stays pending
  until a process adds the lane.
