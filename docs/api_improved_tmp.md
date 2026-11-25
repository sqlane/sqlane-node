<!--
Work in progress: the rewrite of docs/api.md. It replaces docs/api.md when it is complete.
Writers follow docs/for_agents/guide_for_writing_user_faced_api_docs.md.

How to write a section:
- Each TODO lists what the section covers. Write it new, from the code: src/ and types/sqlane.d.ts.
- "Facts:" names a section of the old docs/api.md by its heading. Use it only as a list of facts to check against the
  code. Do not copy or rephrase its sentences: much of its wording is what this rewrite replaces.
- "Leave out:" names old content that does not belong in this file: internals, history and upgrade notes. Do not
  write it here.
- "Fix:" names an error of the old text. Do not repeat it.
-->

# API reference

<!-- TODO: 2–3 sentences: what @sqlane/core is (jobs as rows in your MySQL, MariaDB or PostgreSQL database, added in
your own transaction), and a link to design.md for how it works. Facts: old intro. -->

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

<!-- TODO: Covers: the number form (milliseconds) and the string form, its units, valid and invalid examples.
Facts: old "Durations". -->

## Definitions

<!-- TODO: one sentence: definitions are frozen values, created at module load and shared by producers and workers.
Facts: old "Two scopes: the sqlane and the runner", old "defineLane". -->

### `defineLane`

<!-- TODO: Covers: the options table (name, timeout, attempts, backoff, retention, failure lane, fair share weight,
fairGroup, global limits), when each option takes effect (at enqueue or at claim), an example.
Facts: old "defineLane", old "Where job options come from". -->

#### Backoff

<!-- TODO: Covers: the backoff forms, the default, the delay of each attempt. Facts: old "Backoff". -->

#### Typed payloads

<!-- TODO: Covers: how a lane's payload type flows to enqueue and to the handler, a TypeScript example.
Facts: old "Typed payloads". -->

### `defineHandler`

<!-- TODO: Covers: the signature, the handler options table (local limits, fair share weight, …), an example.
Facts: old "defineHandler". Fix: the old example uses a limit name that it never defines. -->

### `defineConcurrencyLimit`

<!-- TODO: Covers: the signature, `max`, `limit.key(value)`, the local use (a handler option) and the global use (a
lane option), an example of each. Facts: old "defineConcurrencyLimit". Fix: the old example passes
localConcurrencyLimits to defineLane; it is a handler option. -->

### `defineRateLimit`

<!-- TODO: Covers: the signature, the limit per period, burst, cost, `limit.key(value)`, the local and the global use,
an example of each. Facts: old "defineRateLimit". Fix: the old example passes localRateLimits to defineLane; it is a
handler option. Leave out: how a rate key is stored. -->

### `defineSchedule`

<!-- TODO: Covers: the signature, the options table, the errors, an example. How schedules behave goes to "Schedules"
below. Facts: old "defineSchedule", old "Schedules". -->

## sqlane instance

### `createSqlane`

<!-- TODO: Covers: the options table (adapter, tablePrefix, hint, logger, events, …), the return value, an example.
Facts: old "createSqlane". -->

### `sqlane.enqueue`

<!-- TODO: Covers: the signature, the options (connection, runAt, dedupeKey, jobId, limit keys, …), the return
value, the errors, the transaction rules, an example. Facts: old "enqueue". Fix: the old error list has an item about
jobs.get; it belongs to jobs.get. -->

### `sqlane.enqueueMany`

<!-- TODO: Covers: how it differs from enqueue (one statement, per-item options, the result), an example.
Facts: old "enqueueMany". -->

### `sqlane.jobs.get`

<!-- TODO: Covers: the signature, the return value (JobRecord or null), the errors. Facts: old "jobs", old "jobs.get".
-->

### `sqlane.jobs.list`

<!-- TODO: Covers: the filters, the order, the page size, the page cursor, the return value, an example of paging.
Facts: old "jobs.list". Leave out: how paging works inside, where a caller cannot see it. -->

### `sqlane.jobs.retry`, `cancel` and `remove`

<!-- TODO: Covers: the selector, the options, the result, what each method does, how they behave in a transaction,
the events. Facts: old "Retry, cancel and remove". Leave out: row locks, lock order, gap locks, when
blocked keys are unblocked. -->

### `sqlane.jobs.keyStats`

<!-- TODO: Covers: the signature, the options, the fields of each entry (concurrency and rate), an example.
Facts: old "Key stats". Leave out: how the `max` field is chosen, the cost of the read. -->

### `sqlane.lanes.stats`

<!-- TODO: Covers: the signature, the fields, that it works before start() and after close(), an example.
Facts: old "lanes.stats". Leave out: its statements and their cost. -->

### `sqlane.lanes.groupStats`

<!-- TODO: Covers: the signature, the options (limit, orderBy), the fields, an example.
Facts: old "lanes.groupStats". -->

### `sqlane.lanes.pauseGlobally` and `resumeGlobally`

<!-- TODO: Covers: the signatures, what a paused lane does and does not do, when the pause takes effect, the
connection option, an example. Facts: old "lanes.pauseGlobally and resumeGlobally". Leave out: the short
window after a pause on MySQL and MariaDB in which an unblock can still start a job. -->

### `sqlane.schedules.list`

<!-- TODO: Covers: the signature, the fields of each schedule, an example. Facts: old "schedules.list". -->

### `sqlane.schedules.runSlot`

<!-- TODO: Covers: the signature, what a manual run adds, the errors, an example. Facts: old "schedules.runSlot". -->

### `sqlane.schedules.pauseGlobally` and `resumeGlobally`

<!-- TODO: Covers: the signatures, what a paused schedule does with its slots, when the pause takes effect, an example.
Facts: old "schedules.pauseGlobally and resumeGlobally". -->

### `sqlane.schedules.remove`

<!-- TODO: Covers: the signature, what it removes and what it keeps, an example. Facts: old "schedules.remove".
Leave out: schedules without a key from 9.x. -->

### `sqlane.schema.migrate`

<!-- TODO: Covers: the signature, the options, the result, running it from your own migration tool (keep that example).
Facts: old "schema.migrate". Leave out: which version requires which migration. -->

### `sqlane.schema.rollback`

<!-- TODO: Covers: the signature, the target version, the result, the errors. Facts: old "schema.rollback".
Leave out: the history of the lowest version (6.0, 5.x). -->

### `sqlane.schema.drop`

<!-- TODO: Covers: the signature, what it drops, the result, the errors. Facts: old "schema.drop".
Leave out: how drop recognizes sqlane's tables; the tables of older versions. -->

### `sqlane.schema.getMigrationStatus`

<!-- TODO: Covers: the signature, the fields of the result. Facts: old "schema.getMigrationStatus". -->

### `sqlane.schema.findSchemaProblems`

<!-- TODO: Covers: the signature, the kinds of problems, the fields of each problem, a readiness-probe example (keep
it). Facts: old "schema.findSchemaProblems". Leave out: how it compares types, collations and indexes
with the catalog. -->

### `sqlane.close`

<!-- TODO: Covers: what sqlane.close adds to runner.close, with a link there. Facts: old "runner.close and
sqlane.close". -->

## sqlane runner

### `createRunner`

<!-- TODO: Covers: the signature, the options (localMaxConcurrency, …), one runner per sqlane instance, an example.
Facts: old "createRunner". -->

### `runner.mount`

<!-- TODO: Covers: the signature, what it mounts (handlers, schedules), mounting after start(), the return value, an
example. Facts: old "runner.mount". -->

#### `Mount.unmount`

<!-- TODO: Covers: what an unmount stops, and what happens to running jobs. Facts: old "Mount.unmount". -->

### `runner.start`

<!-- TODO: Covers: the signature, what start() checks and begins, the errors, an example. Facts: old "runner.start".
-->

### `runner.drain`

<!-- TODO: Covers: the signature, when it resolves, the result, its use in tests and scripts, an example.
Facts: old "runner.drain". -->

### `runner.close`

<!-- TODO: Covers: the signature, the options (deadline, mode), what happens to running jobs in each mode, an example.
Facts: old "runner.close and sqlane.close". -->

### `runner.pauseLocally` and `resumeLocally`

<!-- TODO: Covers: the signatures, how a local pause differs from a global pause. Facts: old "runner.pauseLocally".
-->

### `runner.getStatus`

<!-- TODO: Covers: the signature, the fields of the result. Facts: old "runner.getStatus". -->

## Handlers

### The handler context

<!-- TODO: Covers: payload, job (its JobInfo fields), signal and the reasons for an abort. Facts: old "The handler
context". Leave out: how each dialect captures startedAt. -->

### How a handler ends

<!-- TODO: Covers: return, throw, and the three errors that a handler throws on purpose (RetryJobError, FatalJobError,
RateLimitedError). Facts: old "The handler context", old "Errors that handlers throw". -->

## Behavior

### Where job options come from

<!-- TODO: Covers: which option the lane definition, the enqueue call and the handler each set, and which wins.
Facts: old "Where job options come from". -->

### Concurrency and rate limits

<!-- TODO: Covers: blocked jobs, FIFO per limit key, max and settings fixed at enqueue, at most 10 limit keys per job,
the spacing of starts (max + burst − 1). Facts: old "defineConcurrencyLimit", old "defineRateLimit". -->

### Sharing worker slots

<!-- TODO: Covers: the rule (by weight, the fewest running first, ties in turn), examples. Facts: old "How free slots
are shared". Leave out: the uneven share of an odd slot, and very short jobs; the
comparison with 4.x. -->

### Fair groups

<!-- TODO: Covers: what fairGroup does, how the slots of a lane go to its groups, groupStats, an example.
Facts: old "Fair groups". Leave out: the cost, and the behavior without the migration
0011_fair_groups; upgrading, and what is not in 10.1. -->

### Schedules

<!-- TODO: Covers: how a slot fires, cron syntax, time zones and DST, every, missed slots and catch-up, overlap, jitter,
deploys, the database clock, the guarantees. Facts: old "Schedules" and its subsections.
Leave out: the comparison with River. -->

## Types

### `JobRecord` and `JobError`

<!-- TODO: Covers: the fields of each. Say which `key` is which: in `JobRecord.globalConcurrencyLimits` and the
concurrency entries of `jobs.keyStats`, `key` is the full limit key, such as `order:42`; in
`JobRecord.globalRateLimits`, the `rate_limited` event and the rate entries of `jobs.keyStats`, `limit` is the limit
name and `key` is the key value only. Facts: old "JobRecord". -->

### `FailedJobPayload`

<!-- TODO: Covers: the fields, when a failure lane gets it, an example handler. Facts: old "FailedJobPayload". -->

### `Hint`

<!-- TODO: Covers: the interface, the channel and the message, what happens when publish fails, that without it other
processes find jobs at their next poll, the PostgreSQL `notify` adapter option, the Redis example.
Facts: old "Hint". Fix: the old example passes an unknown `jobs` option to createSqlane.
Words: `hint` names only the option and this type, in code style. Its first mention says what it is: a pub/sub service
by which sqlane wakes the other processes, so that they check a lane now, not at their next poll. Prose elsewhere uses
verbs: "sqlane wakes the other processes", not "the hint". -->

## Errors

<!-- TODO: one table: class, code, meaning. Methods list which classes they throw. Facts: old "Errors".
Leave out: the note on the jobId of 7.x. -->

## Events

<!-- TODO: Covers: the event names, the fields of each, how to subscribe. Facts: old "Events".
Leave out: which database errors sqlane retries, such as deadlocks. -->

## Adapters

<!-- TODO: Covers: the adapter of each driver and ORM, their options, an example of each. Facts: old "Adapters". -->
