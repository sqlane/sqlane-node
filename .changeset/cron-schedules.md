---
'@sqlane/core': major
---

Cron and repeatable jobs, with three small breaking changes.

Breaking:

- `enqueue` and `enqueueMany` reject a `jobId` that starts with `schedule:`. This prefix now marks the slots of
  schedules. To run a slot by hand, use the new option `slot: { at, key? }`.
- `JobInfo.scheduledAt: Date | null` is a new required field. A `HandlerContext` that you build by hand in tests
  needs `scheduledAt: null`.
- `SqlaneEvent` has a new type, `schedule_fired`. An exhaustive `switch` on `event.type` needs a case for it. From now
  on, new event types may come in minor versions: handle unknown types in a `default` branch.

New:

- `sqlane.schedule(job, { cron, timezone })` or `{ every }` adds a job at each slot. Each slot adds at most one job
  in the cluster, without a leader, and the database clock decides. A slot missed during a short downtime runs once
  (`missed: 'once' | 'skip'`), and `overlap: 'skip'` skips a slot while the previous run is not done. `jitter`
  spreads the runs of many schedules over a window.
- Handlers get `job.scheduledAt`, `getSchedules()` gives the next and the last slot, and the event `schedule_fired`
  reports each slot.

Migration: if you use schedules, run `migrate()` after the upgrade. It adds the table `sqlane_schedules` (migration
`0004_schedules`). Apps without schedules need nothing: they run no new query.
