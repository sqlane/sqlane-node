<!--
Work in progress: the rewrite of docs/api.md. It replaces docs/api.md when it is complete.
Writers follow docs/for_agents/guide_for_writing_user_faced_api_docs.md.
Each TODO names its source lines in the old docs/api.md, and the old text that moves out of this file.
-->

# API reference

<!-- TODO: 2–3 sentences: what @sqlane/core is (jobs as rows in your MySQL, MariaDB or PostgreSQL database, enqueued in
your transaction), the semver promise, and a link to design.md. Source: api.md:1-8. -->

## Contents

<!-- TODO: nested list of the sections below, generated last. -->

## Glossary

The words of sqlane that no plain phrase replaces. Other terms explain themselves, or the section that uses them
explains them.

| Term   | Meaning                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------- |
| sqlane | The library.                                                                                          |
| lane   | A named kind of job, such as `send_email`. All lanes share the same tables and the same workers.      |
| stall  | A running job whose process stopped or hung. sqlane makes the job pending again, for another process. |

## Durations

<!-- TODO: number and string formats, valid and invalid examples. Source: api.md:99-111. -->

## Definitions

<!-- TODO: one sentence: definitions are frozen values, created at module load and shared by producers and workers.
Source: api.md:91-92, 121-122. -->

### `defineLane`

<!-- TODO: options table, when each option takes effect, example. Source: api.md:113-161, 442-456.
Move out: none. -->

#### Backoff

<!-- TODO: Source: api.md:163-175. -->

#### Typed payloads

<!-- TODO: Source: api.md:177-197. -->

### `defineHandler`

<!-- TODO: Source: api.md:199-231. Fix: the example's limit name erpCalls is undefined. -->

### `defineConcurrencyLimit`

<!-- TODO: Source: api.md:319-368. Fix: example passes localConcurrencyLimits to defineLane; it is a handler option. -->

### `defineRateLimit`

<!-- TODO: Source: api.md:370-440. Fix: example passes localRateLimits to defineLane; it is a handler option.
Move out to design.md: stored form `@<name>:<value>` (api.md:409-410). -->

### `defineSchedule`

<!-- TODO: signature, options table, errors, example. Behavior goes to "Schedules" below.
Source: api.md:233-252, 746-796 (one copy of the signature and errors). -->

## sqlane instance

### `createSqlane`

<!-- TODO: Source: api.md:254-289. -->

### `sqlane.enqueue`

<!-- TODO: Source: api.md:458-522. Fix: the jobs.get item in the error list (api.md:502) belongs to jobs.get. -->

### `sqlane.enqueueMany`

<!-- TODO: Source: api.md:524-545. -->

### `sqlane.jobs.get`

<!-- TODO: Source: api.md:1515-1551. -->

### `sqlane.jobs.list`

<!-- TODO: Source: api.md:1553-1620. Move out to design.md: paging internals that a caller cannot observe. -->

### `sqlane.jobs.retry`, `cancel` and `remove`

<!-- TODO: selector, options, result, per-method effects, transactions, events.
Source: api.md:1662-1791. Move out to design.md: row locks, lock order, gap locks, unblock timing (api.md:1747-1781). -->

### `sqlane.jobs.keyStats`

<!-- TODO: Source: api.md:1793-1872. Move out to design.md: how `max` is chosen (api.md:1817), cost formula
(api.md:1865-1867). -->

### `sqlane.lanes.stats`

<!-- TODO: Source: api.md:1445-1480. Move out to design.md: statements and cost (api.md:1477-1479). -->

### `sqlane.lanes.groupStats`

<!-- TODO: Source: api.md:1482-1513. -->

### `sqlane.lanes.pauseGlobally` and `resumeGlobally`

<!-- TODO: Source: api.md:1024-1061. Move out to design.md: the MySQL unblock race (api.md:1044-1045). -->

### `sqlane.schedules.list`

<!-- TODO: Source: api.md:914-937. -->

### `sqlane.schedules.runSlot`

<!-- TODO: Source: api.md:939-965. -->

### `sqlane.schedules.pauseGlobally` and `resumeGlobally`

<!-- TODO: Source: api.md:967-1005. -->

### `sqlane.schedules.remove`

<!-- TODO: Source: api.md:1007-1022. Move out to docs/migrations/10.md: keyless schedules of 9.x. -->

### `sqlane.schema.migrate`

<!-- TODO: Source: api.md:1187-1305 (keep the migration-tool example).
Move out to docs/migrations/: which version requires which migration (api.md:1214-1221). -->

### `sqlane.schema.rollback`

<!-- TODO: Source: api.md:1307-1341. Move out to docs/migrations/: 6.0 and 5.x history (api.md:1331-1332). -->

### `sqlane.schema.drop`

<!-- TODO: Source: api.md:1343-1374. Move out to design.md: how drop recognizes its tables (api.md:1360-1361);
to docs/migrations/: tables of older versions (api.md:1352). -->

### `sqlane.schema.getMigrationStatus`

<!-- TODO: Source: api.md:1376-1392. -->

### `sqlane.schema.findSchemaProblems`

<!-- TODO: Source: api.md:1394-1443 (keep the readiness-probe example).
Move out to design.md: catalog comparison details (api.md:1416-1422). -->

### `sqlane.close`

<!-- TODO: what sqlane.close adds to runner.close; link there. Source: api.md:1154-1185. -->

## sqlane runner

### `createRunner`

<!-- TODO: Source: api.md:291-317. -->

### `runner.mount`

<!-- TODO: Source: api.md:547-576. -->

#### `Mount.unmount`

<!-- TODO: Source: api.md:578-586. -->

### `runner.start`

<!-- TODO: Source: api.md:1093-1115. -->

### `runner.drain`

<!-- TODO: Source: api.md:1117-1152. -->

### `runner.close`

<!-- TODO: Source: api.md:1154-1185. -->

### `runner.pauseLocally` and `resumeLocally`

<!-- TODO: Source: api.md:1063-1078. -->

### `runner.getStatus`

<!-- TODO: Source: api.md:1080-1091. -->

## Handlers

### The handler context

<!-- TODO: payload, job (JobInfo), signal and its reasons. Source: api.md:588-639.
Move out to design.md: how startedAt is captured per dialect (api.md:622-627). -->

### How a handler ends

<!-- TODO: return, throw, and the three special errors. Source: api.md:641-655, 1912-1984. -->

## Behavior

### Where job options come from

<!-- TODO: Source: api.md:442-456. -->

### Concurrency and rate limits

<!-- TODO: blocking, FIFO per limit key, maxes and settings fixed at enqueue, at most 10 limit keys, start spacing
(max + burst − 1). Source: api.md:332-351, 385-415. -->

### Sharing worker slots

<!-- TODO: the rule, examples. Source: api.md:657-694. Move out to design.md: the odd remainder maths and very short
jobs (api.md:684-690); to docs/migrations/: the 4.x comparison (api.md:670-671). -->

### Fair groups

<!-- TODO: Source: api.md:696-744. Move out to design.md: cost, behaviour without the migration (api.md:729-736);
to docs/migrations/10.md: upgrading and "not in 10.1" (api.md:737-742). -->

### Schedules

<!-- TODO: how a slot fires, cron syntax, time zones and DST, every, missed slots and catch-up, overlap, jitter, deploys,
database time, guarantees. Source: api.md:746-912. Move out: the River comparison (api.md:821) to
features_vs_other_libs.md. -->

## Types

### `JobRecord` and `JobError`

<!-- TODO: Source: api.md:1622-1660. Say which `key` is which: in `JobRecord.globalConcurrencyLimits` and the
concurrency entries of `jobs.keyStats`, `key` is the full limit key, such as `order:42`; in `JobRecord.globalRateLimits`,
the `rate_limited` event and the rate entries of `jobs.keyStats`, `limit` is the limit name and `key` is the key value
only. -->

### `FailedJobPayload`

<!-- TODO: Source: api.md:2034-2060. -->

### `Hint`

<!-- TODO: Source: api.md:2062-2113. Fix: the example passes an unknown `jobs` option to createSqlane.
Words: `hint` names only the option and this type, in code style. Its first mention says what it is: a pub/sub service
by which sqlane wakes the other processes, so that they check a lane now, not at their next poll. Prose elsewhere uses
verbs: "sqlane wakes the other processes", not "the hint". -->

## Errors

<!-- TODO: one table: class, code, meaning. Methods list which classes they throw. Source: api.md:1874-1910.
Move out to docs/migrations/: "the jobId of 7.x" (api.md:1882). -->

## Events

<!-- TODO: Source: api.md:1986-2032. Move out to design.md: retried deadlocks and ER_CHECKREAD (api.md:2016). -->

## Adapters

<!-- TODO: Source: api.md:2115-2142. -->
