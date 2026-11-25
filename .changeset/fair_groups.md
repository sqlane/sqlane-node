---
'@sqlane/core': minor
---

Fair groups: one group of a lane (a tenant) with a big backlog no longer starves the other groups of the lane.
`defineLane({ fairGroup: ({ payload }) => string | null })` gives each job a group at enqueue; a runner whose
definition of the lane has `fairGroup` gives the lane's slots to its due groups in turn: the fewest jobs running in
this runner first, ties round-robin. The lane's share against the other lanes is unchanged. See
[fair groups](https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#fair-groups).

```js
const convertVideo = defineLane({
    name: 'convert_video',
    timeout: '2h',
    fairGroup: ({ payload }) => payload.outputQueueName,
});
```

- New migration `0011_fair_groups` (tagged 10.1.0): the column `fair_group` and an index of the claim by group, which
  covers the pending rows of every lane. Optional: 10.1 runs on the 10.0 schema. Without it, the lanes with
  `fairGroup` are claimed FIFO (with a warning), and an enqueue with a group rejects with a `ConfigError`; a runner
  switches to groups after `schema.migrate()`, without a restart. On a large PostgreSQL table, build the index
  `CONCURRENTLY` first.
- New: `sqlane.lanes.groupStats(lane, { limit, orderBy })`: the groups of a lane with unfinished jobs, worst first.
- New fields: `JobInfo.fairGroup`, `fairGroup` on the job events of a runner, `runner.getStatus(lane).fairGroups`.
  Types `GroupStatsOptions`, `GroupStats`, `GroupStatsPage`.
- `fairGroup` does not combine with `globalConcurrencyLimits` or `globalRateLimits`. Every process that imports a
  definition with `fairGroup` needs 10.1: a 10.0 `defineLane` rejects the unknown option.
