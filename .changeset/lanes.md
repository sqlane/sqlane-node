---
'@sqlane/core': major
---

The "job name" is now the **lane**: the jobs that share a name, with the default options of its definition. A rename
through the API, the code and the database, with no new behavior. Migration `0009_lanes` (9.0.0) renames the columns;
see the [guide](https://github.com/sqlane/sqlane-node/blob/main/docs/migrations/9.md).

Breaking changes:

- `defineJob()` is now `defineLane()`, `JobDefinition` is `LaneDefinition`, and `JobOptions` is `LaneOptions`
  (unrelated to the 4.x type of that name, removed in 5.0, as a lane is to the `lanes` option of 4.x).
- `sqlane.handle(job, handler)` is now `sqlane.lanes.add(lane, handler)`, and `sqlane.jobs.stats()` is
  `sqlane.lanes.stats()` (`JobStats` is `LaneStats`; the new type `SqlaneLanes` is that of `sqlane.lanes`).
- `createSqlane({ jobs, unknownJobs })` is now `createSqlane({ lanes, unknownLanes })`; `UnknownJobError` (code
  `UNKNOWN_JOB`) is `UnknownLaneError` (code `UNKNOWN_LANE`).
- `failureJob` is now `failureLane`: in a definition, in the enqueue options, in `JobRecord` and in the event
  `failure_job_not_added`.
- `jobName` is now `lane` in `JobFilter`, `JobSelector`, the events and the log fields; `name` is now `lane` in
  `JobInfo`, `JobRecord`, `ScheduleInfo` and the `job` of `FailedJobPayload`.
- The columns `job_name` and `failure_job` are now `lane` and `failure_lane`; on MySQL and MariaDB, the index
  `<prefix>jobs_status_name_run_at` is `<prefix>jobs_status_lane_run_at`. Stop the 8.x processes, run
  `schema.migrate()`, then deploy. 9.x requires `0009_lanes`.
- The errors that named the options of older majors are gone: `concurrency`, `maxConcurrency` and the `lanes` object of
  4.x, `mutexKeys` of 5.x, and the enqueue option `jobId` of 7.x, now reject as unknown or bad options.
