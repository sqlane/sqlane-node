---
'@sqlane/core': major
---

The worker of a process is a **runner** of its own: `createRunner(sqlane)` mounts handlers (`defineHandler`) and
schedules (`defineSchedule`), at any time, and `sqlane` acts on the database for every process. A producer creates no
runner. The failure job of a job comes from the definition of its lane in the process that
fails it, and a job past its `maxStalls` fails at its next claim, in a process that handles its lane.

```js
import { createRunner, createSqlane, defineHandler, defineLane, defineSchedule } from '@sqlane/core';

const report = defineLane({ name: 'report', maxAttempts: 3 }); // what a job is: producers import it
const nightly = defineSchedule(report, { key: 'nightly', cron: '0 3 * * *' }); // next to its lane

const sqlane = createSqlane({ adapter }); // the database, every process
const runner = createRunner(sqlane, { localMaxConcurrency: 10 }); // this process
const mount = runner.mount([defineHandler(report, ({ payload }) => build(payload)), nightly]);
await runner.start();
```

Breaking changes:

- `sqlane.lanes.add(lane, handler)` is now `runner.mount([defineHandler(lane, handler)])`, and
  `sqlane.schedule(lane, options)` is `runner.mount([defineSchedule(lane, { key, ...options })])`. A mount works before
  `start()` and after it (it claims and fires at once); `mount.unmount()` removes it. `sqlane.start()`, `drain()` and
  the worker part of `close()` are `runner.start()`, `drain()` and `close()`; `sqlane.close()` closes the runner, then
  stops publishing hints. `sqlane.wake()` is gone: the enqueues and the hints wake the runner.
- `createSqlane({ localMaxConcurrency })` is now `createRunner(sqlane, { localMaxConcurrency, logger })`. The options
  `lanes` and `unknownLanes`, and `UnknownLaneError` (code `UNKNOWN_LANE`), are gone: `enqueue` and `enqueueMany` take a
  lane definition only, and a `failureLane` is a definition only. The reads and the admin methods (`jobs.list`,
  `retry`, `cancel`, `remove`) still take a name.
- The local settings of a lane (`localConcurrencyLimits`, `localRateLimits`, `fairShareWeight`) move from `defineLane` to
  `defineHandler`: they are per process. `defineLane` rejects them, and a failure lane with a failure lane of its own.
- A schedule needs a `key`: its id is `<lane>:<key>`, and the job id of a slot `<lane>:schedule:<key>:<ISO>`. The rows of
  the keyless schedules of 9.x stay in `<prefix>schedules`: delete them by hand. The enqueue option `slot` is now
  `sqlane.schedules.runSlot(schedule, { at, connection })`: the slot of the spec (by default the latest one up to now),
  with the payload of the schedule; no runner needed.
- `schedules.list()` lists the rows of the table only: a schedule is listed once a started runner has mounted it.
  `nextAt` comes from the stored spec; `nextRunAt` has the jitter only for a schedule mounted in this process with the
  stored spec. `ScheduleInfo.registered` is gone:
  `runner.getStatus(schedule)`; `lastSlotAt` is never null.
- New: `runner.pauseLocally(lane)` / `resumeLocally(lane)` (this process claims none of its jobs, for the life of the
  runner), `runner.getStatus(lane | schedule)`. Types `LaneHandler`, `HandlerOptions`, `ScheduleDefinition`,
  `ScheduleOptions` (now with a required `key`), `ScheduleSettings`, `Runner`, `RunnerOptions`, `Mount`,
  `LaneRunStatus`, `ScheduleRunStatus`, `RunSlotOptions`; `EnqueueOptions` loses `slot`, `SlotOptions` and
  `ScheduleBaseOptions` are gone.
- The failure lane is read from the definition of the runner when the job fails for good, no longer from the job row.
  A job enqueued under a definition with another `failureLane`, or with none, gets the failure job of the runner's
  definition, or none; a job that fails after the unmount of its handler uses the definition of that handler.
- `JobRecord.failureLane` is removed, and the enqueue no longer writes the column `failure_lane` (it stays in the
  schema; the rows of 9.x keep their value, which nothing reads). The enqueue option `failureLane` is removed: it
  rejects as an unknown option.
- After `maxStalls` stalls, the next stall releases the job as any stall (its slots linger for one lease), with `stalls`
  one above `maxStalls`, and keeps its due time: it is due at once, in its place in line. Its next claim fails it at
  once, without running its handler and without an attempt used, with a `StalledError` and the failure job of the
  claiming runner's definition. That claim ignores the global limits and rate limits of the job: it is never blocked,
  takes no global slot and no global quota, and no quota of the local rate limits. The events of the failure are
  `claimed`, then `failed` (`durationMs` 0), from the claiming process; the stall recovery emits only `stalled`.
  `drain()` counts the failure. A job of a lane that no process handles stays pending until a process handles the lane.
