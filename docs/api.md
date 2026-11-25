# API reference

This page describes the public API of `@sqlane/core`. sqlane is a job queue that stores its jobs as rows in your own
MySQL, MariaDB or PostgreSQL database. You add a job inside your business transaction, so the job exists only if that
transaction commits.

sqlane follows semantic versioning since 1.0, so only a major version breaks this API. The [design](design.md)
explains how sqlane works and why.

## Contents

- [Terms](#terms)
- [Durations](#durations)
- [Two scopes: the sqlane and the runner](#two-scopes-the-sqlane-and-the-runner)
- [`defineLane`](#definelane)
- [`defineHandler`](#definehandler)
- [`defineSchedule`](#defineschedule)
- [`createSqlane`](#createsqlane)
- [`createRunner`](#createrunner)
- [`defineConcurrencyLimit`](#defineconcurrencylimit)
- [`defineRateLimit`](#defineratelimit)
- [Where job options come from](#where-job-options-come-from)
- [`enqueue`](#enqueue)
- [`enqueueMany`](#enqueuemany)
- [`runner.mount`](#runnermount)
- [How free slots are shared](#how-free-slots-are-shared)
- [Schedules](#schedules)
- [`schedules.list`](#scheduleslist)
- [`schedules.runSlot`](#schedulesrunslot)
- [`schedules.pauseGlobally` and `resumeGlobally`](#schedulespauseglobally-and-resumeglobally)
- [`schedules.remove`](#schedulesremove)
- [`lanes.pauseGlobally` and `resumeGlobally`](#lanespauseglobally-and-resumeglobally)
- [`runner.pauseLocally`](#runnerpauselocally)
- [`runner.getStatus`](#runnergetstatus)
- [`runner.start`](#runnerstart)
- [`runner.drain`](#runnerdrain)
- [`runner.close` and `sqlane.close`](#runnerclose-and-sqlaneclose)
- [`schema.migrate`](#schemamigrate)
- [`schema.rollback`](#schemarollback)
- [`schema.drop`](#schemadrop)
- [`schema.getMigrationStatus`](#schemagetmigrationstatus)
- [`schema.findSchemaProblems`](#schemafindschemaproblems)
- [`lanes.stats`](#lanesstats)
- [`lanes.groupStats`](#lanesgroupstats)
- [`jobs`](#jobs)
- [Retry, cancel and remove](#retry-cancel-and-remove)
- [Key stats](#key-stats)
- [Errors](#errors)
- [Events](#events)
- [`FailedJobPayload`](#failedjobpayload)
- [`Hint`](#hint)
- [Adapters](#adapters)

## Terms

| Term              | Meaning                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job               | One unit of work. It is one row in the database, with a payload, a state and a number of attempts.                                                                                                                                                                                                                                                                         |
| Lane              | The jobs that share a name, for example `build_report`; their default options come from the lane definition. The lanes share the table and the runners, with [fair sharing](#how-free-slots-are-shared) between them. A lane is not a priority, and sqlane has no other queue object. It is unrelated to the `lanes` of 4.x, which became local concurrency limits in 5.0. |
| Lane definition   | The name and the options of a lane: what a job is. You create it with `defineLane`. Producers and workers import the same definition.                                                                                                                                                                                                                                      |
| Handler           | How a process runs the jobs of a lane: its function, and the settings of the lane in that process. You create it with `defineHandler`, and a runner mounts it.                                                                                                                                                                                                             |
| Runner            | The part of a process that runs jobs and fires schedules: `createRunner`. A producer has none.                                                                                                                                                                                                                                                                             |
| Concurrency limit | The most jobs that run at once. A handler lists it as a local limit, which each runner counts, or a lane definition as a global limit, which the whole cluster counts per key. You create it with `defineConcurrencyLimit`.                                                                                                                                                |
| Rate limit        | The most job starts in a period. A handler lists it as a local limit, which each runner counts, or a lane definition as a global limit, which the whole cluster counts per key. You create it with `defineRateLimit`.                                                                                                                                                      |
| Fair share weight | The share of the free slots that a lane gets, against the other due lanes: `fairShareWeight`, default 1.                                                                                                                                                                                                                                                                   |
| Lease             | The time for which a process owns a running job. The process renews the lease while the handler runs. If the process stops, the lease ends and another process can take the job.                                                                                                                                                                                           |
| Stall             | A stall happens when the lease of a running job ends because its process stopped or blocked. sqlane then puts the job back in the queue.                                                                                                                                                                                                                                   |
| Key               | A string such as `order:42`: a global limit counts the jobs of each of its keys. Two jobs with one key of a limit of 1 never run at the same time in the whole cluster, as long as handlers stop when their `signal` aborts.                                                                                                                                               |
| Blocked job       | A due job with a full key, or with a rate key that has no quota left. It waits out of the due jobs until a job of the key ends, or until the next start of the rate key.                                                                                                                                                                                                   |
| Failure job       | A job that sqlane adds to the failure lane of a job when that job fails for good. It lets you react to the failure, for example by sending an alert.                                                                                                                                                                                                                       |
| Adapter           | The object that connects sqlane to your database driver or ORM.                                                                                                                                                                                                                                                                                                            |
| Hint              | A message that tells other processes that jobs of a lane are ready. Hints only make jobs start sooner. If a hint is lost, the job still runs at the next poll.                                                                                                                                                                                                             |
| Schedule          | A cron or an interval that adds a job of a lane at each of its times. You create it with `defineSchedule`, and a runner mounts it. Its id is `<lane>:<key>`.                                                                                                                                                                                                               |
| Slot              | One time of a schedule. Each slot adds at most one job, whose id is `<lane>:schedule:<key>:<ISO time>`.                                                                                                                                                                                                                                                                    |

An object that is a lane names it `name`: `LaneDefinition.name`, `LaneStats.name`. An object that refers to a lane names
it `lane`: `JobInfo.lane`, `JobRecord.lane`, the events, the filters and `ScheduleInfo.lane`. A reference to a failure
lane is `failureLane`.

## Two scopes: the sqlane and the runner

The API has two scopes, and each method acts in one of them:

- **`sqlane`** (from `createSqlane` of `@sqlane/core`) acts on the database, for every process: `enqueue`, `jobs`,
  `lanes` (their counts, and their pauses in every process), `schedules`, `schema`. Its methods are async. A producer, a
  web process, a script or an admin tool needs nothing else.
- **`runner`** (from `createRunner` of `@sqlane/core`) acts on this process: what it runs (`mount`), what it holds back
  (`pauseLocally`), what runs here (`getStatus`), and `start`, `drain` and `close`. Its methods change memory only, at
  once, but `start`, `drain` and `close`. A process without a runner claims no job and fires no schedule.

The definitions (`defineLane`, `defineHandler`, `defineSchedule`, `defineConcurrencyLimit`, `defineRateLimit`) are
frozen values with no instance: create them at module load.

A lane runs in a process while a handler of the lane is mounted in its runner, no local pause holds it
([`runner.pauseLocally`](#runnerpauselocally)), and no global pause holds it
([`lanes.pauseGlobally`](#lanespauseglobally-and-resumeglobally)). The names say the scope: `pauseLocally` pauses this
process, `pauseGlobally` every process.

## Durations

Many options take a duration. A number must be non-negative safe integer milliseconds. A string contains one or
more non-negative decimal quantities with lowercase short units, in descending order: `w`, `d`, `h`, `m`, `s`,
`ms`. Each unit may appear only once; units may be skipped. A day is 24 hours and a week is 7 days.

Examples: `'1s'`, `'1ms'`, `'1.5h'`, `'1h 1m 1s'`, `'1d1h1ms'`. ASCII spaces may surround the string or separate
components; quantity and unit must be adjacent. Fractional quantities such as `'.5s'` are allowed. The sum is
rounded once to the nearest millisecond and must be a safe integer. Positive-duration options reject values
that round to zero.

Invalid: `'1 days'`, `'1ms 1d'`, `'1s 2s'`, `'1 ms'`, `'1S'`, `'1h30'`, `'1:30'`, `'1e3ms'`, `'5'`, signed
quantities, tabs, newlines or trailing text. Use numeric `5` or `'5ms'` for five milliseconds.

## `defineLane`

`defineLane` creates a lane definition, which holds the name and the options of a lane: what a job is.

```ts
defineLane<P = any>(options: LaneOptions<P>): LaneDefinition<P>
```

The definition is a frozen object. Keep it in a small module that both producers and workers import. A producer then
does not need to import the handler and its dependencies.

| Option                    | Type                                                                    | Default                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                    | `string`                                                                | Required                                                            | The name of the lane. It must match `^[a-z][a-z0-9_.-]{0,127}$`, so it cannot contain `:`. It is case-sensitive.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `maxAttempts`             | integer, at least 1                                                     | `3`                                                                 | The number of times a job runs before it fails for good. Set at enqueue; a `one_more` retry changes it.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `maxStalls`               | integer, at least 0                                                     | `2`                                                                 | The number of stalls that a job survives. After the next stall, the next claim of the job fails it for good, without running it. Set at enqueue; a `one_more` retry changes it.                                                                                                                                                                                                                                                                                                                                                                                   |
| `backoff`                 | [`Backoff`](#backoff)                                                   | `{ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 }` | The wait before the next attempt after a failed attempt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `retention`               | `{ completed?: Duration, failed?: Duration }`                           | `{ completed: '1h', failed: '30d' }`                                | How long sqlane keeps a completed or a failed job before it deletes the row. A `dedupeKey` blocks duplicates while the row exists. That is while the job is pending or running, then during this retention, until the next cleanup. A started runner runs the cleanup every 5 minutes. If every sqlane sets `cleanup: false`, the rows stay until you delete them.                                                                                                                                                                                                |
| `timeout`                 | positive duration                                                       | None                                                                | The time after which sqlane aborts the handler. A definition with `globalConcurrencyLimits` needs a timeout, here or in the `defaults` of the sqlane.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `globalConcurrencyLimits` | `({ payload }) => readonly (ConcurrencyLimit \| ConcurrencyLimitKey)[]` | None                                                                | A function that returns the global limits of a job: [limits and their keys](#defineconcurrencylimit). It must be synchronous and use only its argument. sqlane calls it at enqueue, with the payload as JSON gives it back, and stores the keys with their maxes in the job.                                                                                                                                                                                                                                                                                      |
| `globalRateLimits`        | `({ payload }) => readonly (RateLimit \| RateLimitKey)[]`               | None                                                                | A function that returns the global rate limits of a job: [limits, their keys and costs](#defineratelimit). It follows the rules of `globalConcurrencyLimits`: synchronous, called at enqueue, and the keys are stored with their settings in the job.                                                                                                                                                                                                                                                                                                             |
| `fairGroup`               | `({ payload }) => string \| null \| undefined`                          | None                                                                | A function that returns the [fair group](#fair-groups) of a job: the due jobs of the lane take its slots in a runner by group, in turn, so one group with a big backlog does not starve the others. Synchronous, from its argument only, called at enqueue with the payload as JSON gives it back; the group is stored in the job. 1–255 printable ASCII characters, without spaces at the ends (hash an id that may not fit); `null` or `undefined`: no group. Not with `globalConcurrencyLimits` or `globalRateLimits`. Needs the migration `0011_fair_groups`. |
| `failureLane`             | `LaneDefinition`                                                        | None                                                                | The lane of the job that sqlane adds when a job of this lane fails for good: its failure job. The definition in the process that fails the job decides, not the one of its enqueue. A lane cannot be its own failure lane, and the failure lane cannot have a `failureLane` of its own. Its payload is a [`FailedJobPayload`](#failedjobpayload).                                                                                                                                                                                                                 |

`defineLane` throws a `ConfigError` if an option is unknown or has a bad value, if the failure lane has a failure
lane of its own, or if `fairGroup` and `globalConcurrencyLimits` or `globalRateLimits` are both set (to a value other
than `undefined`). It does not check whether a definition with global limits has a timeout, because `runner.mount()`
checks that, with the defaults of its sqlane.

**When a lane option takes effect.** The options stored on the job row (`maxAttempts`, `maxStalls`, `retention`, the
global limits, the fair group) are fixed at enqueue, from the producer's definition: a change applies to the jobs
enqueued after it. Whether a lane is claimed by fair group is up to the definition mounted in each runner.
`backoff`, `timeout` and `failureLane` take effect in the process that runs or fails the job, from the definition
mounted there. So the stalled-out jobs of a lane that no process handles wait pending.

```js
import { defineConcurrencyLimit, defineLane } from '@sqlane/core';

export const order = defineConcurrencyLimit({ name: 'order', max: 1 });
export const syncOrderFailed = defineLane({ name: 'sync_order_failed' });

export const syncOrder = defineLane({
    name: 'sync_order',
    maxAttempts: 5,
    globalConcurrencyLimits: ({ payload }) => [order.key(payload.orderId)],
    timeout: '2m',
    failureLane: syncOrderFailed,
});
```

### Backoff

A backoff decides how long a job waits after a failed attempt.

| Field      | Type                         | Default  | Description                                                                                                    |
| ---------- | ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `type`     | `'exponential'` or `'fixed'` | Required | With `exponential`, the wait is `delay × 2^(attempt − 1)`. With `fixed`, the wait is always `delay`.           |
| `delay`    | `Duration`                   | Required | The base wait.                                                                                                 |
| `maxDelay` | `Duration`                   | None     | The longest wait. It is only allowed with `exponential`, and it must be at least `delay`.                      |
| `jitter`   | number from 0 to 1           | `0.2`    | sqlane multiplies the wait by `1 − jitter × random()`, so jobs do not retry all at once. `0` turns jitter off. |

The jitter only makes the wait shorter, never longer. A `backoff` object replaces the default backoff as a whole, so
sqlane does not merge its fields with the default.

### Typed payloads

A definition can declare the type of its payload. `enqueue` and `enqueueMany` then check the payload against this
type. The handler's `payload`, the `payload` of a schedule and the `payload` of `globalConcurrencyLimits` and
`globalRateLimits` also get this type.

In TypeScript, pass the type to `defineLane`:

```ts
export const buildReport = defineLane<{ reportId: string }>({ name: 'build_report' });
```

In JavaScript with JSDoc, put the type on the constant:

```js
/** @type {import('@sqlane/core').LaneDefinition<{ reportId: string }>} */
export const buildReport = defineLane({ name: 'build_report' });
```

Without a declared type, `enqueue` only checks that the payload is JSON, and the handler gets `any`. sqlane does not
validate payloads at runtime, so your app must validate its own payloads if it needs to.

## `defineHandler`

`defineHandler` defines how a process runs the jobs of a lane: its function, and the settings of the lane in that
process. A [runner mounts it](#runnermount).

```ts
defineHandler<J extends LaneDefinition>(
    lane: J,
    fn: (context: HandlerContext<HandlerPayload<J>>) => unknown,
    options?: HandlerOptions,
): LaneHandler<HandlerPayload<J>>
```

The lane is a lane definition, never a name. `fn` gets `{ payload, job, signal }`, the payload typed by the lane: see
[the handler context](#the-handler-context). The handler is a frozen object: keep it next to the code of the worker,
apart from the definitions that the producers import.

| Option                   | Type                          | Default | Description                                                                                                             |
| ------------------------ | ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `localConcurrencyLimits` | `readonly ConcurrencyLimit[]` | None    | Limits that the runner of this process counts for its own jobs. A job starts while each of them has room.               |
| `localRateLimits`        | `readonly RateLimit[]`        | None    | Rate limits that the runner of this process counts for its own starts, without keys. A job starts while each has quota. |
| `fairShareWeight`        | integer, 1 to 1000            | `1`     | The lane's share of the free slots of the runner. See [How free slots are shared](#how-free-slots-are-shared).          |

`defineHandler` throws a `ConfigError` for a lane that is not a definition, a function that is not one, or a bad
option.

```js
import { defineHandler } from '@sqlane/core';

export const syncOrderHandler = defineHandler(syncOrder, async ({ payload, signal }) => {
    await erp.syncOrder(payload.orderId, { signal });
}, { localConcurrencyLimits: [erpCalls] });
```

## `defineSchedule`

`defineSchedule` defines a schedule: a cron or an interval that adds a job of the lane at each slot. A [runner mounts
it](#runnermount) to fire it.

```ts
defineSchedule<J extends LaneDefinition>(lane: J, options: ScheduleOptions<HandlerPayload<J>>): ScheduleDefinition
```

It holds no handler code, so define it next to its lane: a producer or an admin process can then
[run a slot by hand](#schedulesrunslot) without the worker's code. Its id is `<lane>:<key>`. The options are those of
[Schedules](#schedules); `key` is required. The payload is checked (JSON) and frozen at once; a payload above
`maxPayloadBytes` or bad global limits throw at the mount. `defineSchedule` throws a `ConfigError` for a bad option, a
missing key, or a cron that never fires within 50 years.

```js
import { defineSchedule } from '@sqlane/core';

export const nightly = defineSchedule(nightlyReport, { key: 'nightly', cron: '0 3 * * *', timezone: 'Europe/Berlin' });
```

## `createSqlane`

`createSqlane` creates a sqlane: the database side, for every process.

```ts
createSqlane<C>(options: SqlaneOptions<C>): Sqlane<C>
```

The type `C` is the connection type that `enqueue` accepts, and it comes from the adapter. `createSqlane` does not
connect, migrate or start anything. It throws a `ConfigError` if an option is unknown or has a bad value. Its methods
work without a runner.

| Option            | Type                           | Default     | Description                                                                                                                                                                                              |
| ----------------- | ------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter`         | `Adapter<C>`                   | Required    | The adapter of your driver or ORM, created over the queue's own pool. sqlane uses this pool to claim jobs, renew leases and write results. See [Adapters](#adapters).                                    |
| `defaults`        | `JobDefaults`                  | See below   | Defaults for `maxAttempts`, `maxStalls`, `backoff`, `retention` and `timeout`. A definition overrides them.                                                                                              |
| `hint`            | [`Hint`](#hint) or `null`      | `null`      | A publish/subscribe service that wakes other processes after an enqueue. With `null`, other processes find new jobs at their next poll. You cannot combine it with the `notify` option of an adapter.    |
| `logger`          | `Logger`                       | None        | A pino-compatible logger with `debug`, `info`, `warn` and `error` methods. Each method takes an object and an optional message. Without a logger, sqlane writes no logs.                                 |
| `onEvent`         | `(event: SqlaneEvent) => void` | None        | A function that receives every [event](#events): the job lifecycle of the runner of this sqlane, and the sqlane's own, such as `cancelled` and `error`. If it throws, sqlane logs the error and goes on. |
| `tablePrefix`     | `string`                       | `'sqlane_'` | The prefix of the table names. It must match `^[a-z][a-z0-9_]{0,31}$`.                                                                                                                                   |
| `pollInterval`    | positive duration              | `'5s'`      | How often a started runner checks the database for due jobs when nothing wakes it.                                                                                                                       |
| `maxPayloadBytes` | integer, at least 1            | `262144`    | The largest payload, in bytes of JSON. The default is 256 KiB.                                                                                                                                           |
| `cleanup`         | `boolean`                      | `true`      | When it is `true`, a started runner deletes the completed and failed jobs after their retention.                                                                                                         |

The built-in job defaults are `maxAttempts: 3`, `maxStalls: 2`, the default [backoff](#backoff),
`retention: { completed: '1h', failed: '30d' }` and no timeout.

```js
import { createSqlane } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';

const sqlane = createSqlane({
    adapter: mysql2Adapter(queuePool, { dialect: 'mysql' }),
    defaults: { timeout: '10m' },
});
```

## `createRunner`

`createRunner` creates the runner of this process over a sqlane. A producer creates none.

```ts
import { createRunner } from '@sqlane/core';

createRunner(sqlane: Sqlane<any>, options?: RunnerOptions): Runner
```

| Option                | Type                | Default      | Description                                                                                                                                 |
| --------------------- | ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `localMaxConcurrency` | integer, at least 1 | `10`         | The highest number of handlers that run at the same time in this runner. The free slots are [shared by weight](#how-free-slots-are-shared). |
| `logger`              | `Logger`            | The sqlane's | The logger of the runner. The queries of the sqlane, the runner's too, log to the logger of the sqlane.                                     |

The runner reads `pollInterval` and `cleanup` from its sqlane, and its events go to the `onEvent` of the sqlane. One
runner per sqlane: a second `createRunner` of one sqlane throws a `ConfigError`, and so does a sqlane that this copy of
`@sqlane/core` did not create. After `sqlane.close()`, it throws a `ClosedError`.

```js
import { createRunner } from '@sqlane/core';

const runner = createRunner(sqlane, { localMaxConcurrency: 20 });

runner.mount([syncOrderHandler, nightly]);
await runner.start();
```

## `defineConcurrencyLimit`

`defineConcurrencyLimit` defines a limit: the most jobs that run at once.

```ts
defineConcurrencyLimit(options: { name: string, max: number }): ConcurrencyLimit
```

| Option | Type               | Description                                                     |
| ------ | ------------------ | --------------------------------------------------------------- |
| `name` | `string`           | It must match `^[a-z][a-z0-9_.-]{0,127}$`.                      |
| `max`  | integer, 1 to 1000 | The most jobs that hold the limit, or one of its keys, at once. |

Define a limit once, at module level, like a lane definition. The limit is a frozen object. It is used in one of two
ways:

- **Local**, in the `localConcurrencyLimits` of a [handler](#definehandler): each runner counts its own jobs of all the
  lanes whose handlers list the limit, in memory. It costs no database work. A local limit above the runner's
  `localMaxConcurrency` is allowed: the lower one applies, so one handler fits large and small machines.
- **Global**, returned from `globalConcurrencyLimits`: the whole cluster counts the jobs, in the database. The limit
  itself is one key, `<name>`. `limit.key(value)` gives one key per value, `<name>:<value>`, each with its own count:
  `perClient.key('42')` counts the jobs of client 42. A value is a string or an integer.

A job with global limits starts while each of its keys has fewer running jobs than its max. A job whose key is full is
blocked on it: it leaves the due jobs, so it does not hold back the jobs of other keys, and it is due again when a
job of the key ends. Jobs of a key start in FIFO order among those that can start; a job with several keys waits only
for its full keys. The maxes are stored in the job at enqueue, with the keys: after a deploy that changes a max, the
jobs enqueued before it keep the old one.

A job has at most 10 global keys. A key, with the limit name, has at most 255 printable ASCII characters, without
spaces at the ends. Duplicate keys count once. Two limits with one name and different maxes in one job throw an
`InvalidConcurrencyLimitError` at enqueue; in the local limits of one runner, `runner.mount()` throws a `ConfigError`.

`defineConcurrencyLimit` throws a `ConfigError` for an unknown option, a bad name or a bad `max`.

```js
import { defineConcurrencyLimit, defineLane } from '@sqlane/core';

export const heavy = defineConcurrencyLimit({ name: 'heavy', max: 2 });
export const perClient = defineConcurrencyLimit({ name: 'client', max: 2 });
export const allMessages = defineConcurrencyLimit({ name: 'messages', max: 100 });

export const transcode = defineLane({ name: 'transcode', timeout: '5m', localConcurrencyLimits: [heavy] });
export const sendMessage = defineLane({
    name: 'send_message',
    timeout: '1m',
    // At most 100 messages at once in the cluster, and 2 of each client
    globalConcurrencyLimits: ({ payload }) => [allMessages, perClient.key(payload.clientId)],
});
```

## `defineRateLimit`

`defineRateLimit` defines a rate limit: the most job starts in a period.

```ts
defineRateLimit(options: { name: string, max: number, per: Duration, burst?: number }): RateLimit
```

| Option  | Type                    | Default  | Description                                                                                      |
| ------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `name`  | `string`                | Required | It must match `^[a-z][a-z0-9_.-]{0,127}$`.                                                       |
| `max`   | integer, 1 to 1,000,000 | Required | The most starts per `per`, on average: one every `per / max`.                                    |
| `per`   | duration, 1 ms to 7 d   | Required | The period. `max` must be at most the microseconds of `per`.                                     |
| `burst` | integer, 1 to `max`     | `1`      | The starts that may come at once after a quiet time. With `1`, the starts are `per / max` apart. |

Define a limit once, at module level, like a concurrency limit. The limit is a frozen object, with `per` in
milliseconds. It is used in one of two ways:

- **Local**, in the `localRateLimits` of a [handler](#definehandler): each runner counts the starts of all the lanes
  whose handlers list the limit, in memory. It costs no database work, and N runners start up to N times the rate. A local limit has no keys, and each start
  costs 1. A lane over one of its local rate limits takes no slot: its jobs stay pending until the limit allows a
  start.
- **Global**, returned from `globalRateLimits`: the whole cluster counts the starts, in the database. The limit itself
  is one key. `limit.key(value)` gives one key per value, each with its own quota: `perToken.key('t1')` counts the
  starts of token t1. A value is a string or an integer. `limit.key(value, { cost })` and `limit.cost(n)` make a job
  take `n` starts at once, for an API that counts points. A cost is 1 to `burst`, and 1 by default.

A job with global rate limits starts when each of its rate keys has quota. Otherwise it is blocked on the key: it
leaves the due jobs, without using an attempt, and it is due again at the next start of the key. Jobs of a rate key
start in FIFO order: a new job waits while an older job is blocked on its key. A job takes its quota when it starts:
a retry, or a run after a stall, takes it again, and a job that fails at once gives nothing back. The settings are
stored in the job at enqueue, with the keys: after a deploy that changes them, the jobs enqueued before it keep the old
ones.

**How many starts.** sqlane spreads the starts ([GCRA](design.md#rate-limits)): one every `per / max`, and up to
`burst` at once after a quiet time. Any window of length `per` sees at most `max + burst − 1` starts. So
`{ max: 10, per: '1s' }` starts a job every 100 ms, never 10 at once. With `burst: 10`, 10 jobs may start at once, and
up to 19 in one second. For an API that allows N calls in any window, keep `max + burst − 1` at most N.

A job has at most 10 global keys, of concurrency and rate limits together. A rate key is stored as `@<name>` or
`@<name>:<value>`, so it never collides with a concurrency key, and it has at most 255 printable ASCII characters,
without spaces at the ends. Duplicate keys count once. One key with two settings (`max`, `per`, `burst` or the cost)
in one job throws an `InvalidRateLimitError` at enqueue; two local rate limits with one name and different settings in
one runner make `runner.mount()` throw a `ConfigError`. A global rate limit needs no `timeout`: a rate key holds nothing
while the job runs.

`defineRateLimit` throws a `ConfigError` for an unknown option, a bad name, or a bad `max`, `per` or `burst`.
`limit.key()` and `limit.cost()` throw an `InvalidRateLimitError` for a bad value or cost.

```js
import { defineLane, defineRateLimit } from '@sqlane/core';

export const perToken = defineRateLimit({ name: 'github', max: 5000, per: '1h' });
export const allSms = defineRateLimit({ name: 'sms', max: 10, per: '1s', burst: 10 });
export const diskIo = defineRateLimit({ name: 'disk_io', max: 50, per: '1s' });

export const syncRepo = defineLane({
    name: 'sync_repo',
    // 5000 starts an hour per GitHub token in the cluster, and 50 a second in each process
    globalRateLimits: ({ payload }) => [perToken.key(payload.tokenId)],
    localRateLimits: [diskIo],
});
export const sendSms = defineLane({
    name: 'send_sms',
    // 10 a second in the cluster; a message of 2 parts takes 2 starts
    globalRateLimits: ({ payload }) => [payload.parts > 1 ? allSms.cost(2) : allSms],
});
```

A job can have both kinds of limits: it starts when each of its keys has room and quota. When the other side answers
with a 429, the handler throws a [`RateLimitedError`](#errors-that-handlers-throw).

## Where job options come from

A job gets each option from the first place that sets it, in this order:

1. The options of the `enqueue` call.
2. The lane definition that the producer passes to `enqueue`.
3. The `defaults` of `createSqlane`.
4. The built-in defaults.

`retention` is merged field by field, so you can override only `completed` or only `failed`. `fairGroup` comes from
the definition only: it is not an enqueue option. `backoff`, `timeout` and `failureLane` are not enqueue options: the runner reads them from the definition of the mounted handler, else from
`defaults`. `fairShareWeight` and the local limits come from the handler.

sqlane fixes the other options of a job, the global limits with their maxes and settings included, when you enqueue
it. A later change to a definition does not change the jobs that already exist.

## `enqueue`

`enqueue` adds one job, with your connection, in your transaction.

```ts
sqlane.enqueue(connection: C, lane: LaneDefinition, payload: P, options?: EnqueueOptions): Promise<EnqueueResult>
```

The `connection` is the raw connection of your driver or ORM, as the [adapter](#adapters) defines it. If it is a
connection or a transaction client, it must be in a transaction, because sqlane cannot always detect one. If it is a
pool, sqlane runs the insert in a transaction of its own, outside of any transaction of yours.

The `lane` is a lane definition: it gives the job its options. A name is not accepted: a producer imports the module of
its lanes, which holds no handler code, so it never enqueues a job with options that differ from what it meant.

The `payload` must be JSON. sqlane rejects a payload that `JSON.stringify` cannot write, a string that is not
well-formed UTF-16, and a NUL character (`\u0000`), because PostgreSQL refuses it. The handler gets the payload as
JSON gives it back, so a `Date` would arrive as a string. The TypeScript types reject a `Date`, a `Map`, a `Set`, a
function, a `bigint` and a class instance with methods.

| Option                    | Type                                                   | Default                        | Description                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dedupeKey`               | `string`                                               | None                           | A key that prevents duplicates: the job id is `<lane>:<dedupeKey>`. It has 1 to 120 printable ASCII characters, without spaces at the ends. While a job with this key and lane exists, a second enqueue adds nothing: a job cancelled by `jobs.cancel` keeps blocking it until cleanup deletes it, and `jobs.remove` frees it. It cannot start with `schedule:`, which is reserved for the slots of schedules. |
| `delay`                   | `Duration`                                             | `0`                            | The wait before the job becomes due. You cannot combine it with `runAt`.                                                                                                                                                                                                                                                                                                                                       |
| `runAt`                   | `Date`                                                 | None                           | The time at which the job becomes due. You cannot combine it with `delay`.                                                                                                                                                                                                                                                                                                                                     |
| `maxAttempts`             | integer, at least 1                                    | From the definition            | Overrides `maxAttempts` for this job. A `one_more` retry changes it.                                                                                                                                                                                                                                                                                                                                           |
| `maxStalls`               | integer, at least 0                                    | From the definition            | Overrides `maxStalls` for this job. A `one_more` retry changes it.                                                                                                                                                                                                                                                                                                                                             |
| `retention`               | `{ completed?: Duration, failed?: Duration }`          | From the definition            | Overrides the retention for this job, field by field.                                                                                                                                                                                                                                                                                                                                                          |
| `globalConcurrencyLimits` | `readonly (ConcurrencyLimit \| ConcurrencyLimitKey)[]` | From the definition's function | Replaces the global limits that the definition computes. An empty array removes them all.                                                                                                                                                                                                                                                                                                                      |
| `globalRateLimits`        | `readonly (RateLimit \| RateLimitKey)[]`               | From the definition's function | Replaces the global rate limits that the definition computes. An empty array removes them all.                                                                                                                                                                                                                                                                                                                 |

The global limits follow the rules of [`defineConcurrencyLimit`](#defineconcurrencylimit) and
[`defineRateLimit`](#defineratelimit). Keys are global, so jobs of different lanes can share a key.

`enqueue` resolves to an `EnqueueResult`:

| Field     | Type      | Description                                                                                                    |
| --------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `id`      | `string`  | The job id. It is `<lane>:<dedupeKey>` when you give a `dedupeKey`, and a new ULID without one.                |
| `created` | `boolean` | It is `false` when a job with this id (of this `dedupeKey`) exists already. In that case sqlane added nothing. |

`enqueue` checks everything before it writes, and it rejects with these errors:

- `InvalidOptionsError` for a lane that is not a definition, a bad option, `delay` together with `runAt`, a
  `dedupeKey` that starts with `schedule:`, or a payload that is not JSON, or a `jobId` of `jobs.get` that is not a
  string. Also for a bad [fair group](#fair-groups), and for the options `globalConcurrencyLimits` or
  `globalRateLimits` on a lane with `fairGroup`, unless `[]`.
- `ConfigError` for a job with a fair group on a schema without the migration `0011_fair_groups`: run
  `schema.migrate()`. A job without a group works on that schema.
- The error of a `fairGroup` function that throws, as it is.
- `PayloadTooLargeError` if the payload is larger than `maxPayloadBytes`.
- `InvalidConcurrencyLimitError` if a global limit breaks the rules of `defineConcurrencyLimit`.
- `InvalidRateLimitError` if a global rate limit breaks the rules of `defineRateLimit`, or the job has more than 10
  global keys of both kinds.

`enqueue` and `enqueueMany` still work after `close()`, because they use only your connection. A process without a
runner sends the hint (or the NOTIFY of the adapter) for each lane that gets a job; a process whose runner handles the
lane, not paused, with a free slot, starts the job itself.

```js
await connection.beginTransaction();
await connection.query('INSERT INTO reports (id) VALUES (?)', [reportId]);
const { id, created } = await sqlane.enqueue(connection, buildReport, { reportId }, { dedupeKey: String(reportId), delay: '10s' });
await connection.commit();
```

## `enqueueMany`

`enqueueMany` adds several jobs of one lane in one call.

```ts
sqlane.enqueueMany(
    connection: C,
    lane: LaneDefinition,
    items: readonly { payload: P, options?: EnqueueOptions }[],
): Promise<EnqueueResult[]>
```

Each item has a `payload` and optional [enqueue options](#enqueue). The results are in the order of the items. sqlane
checks all the items before it writes, so one bad item adds no job at all. If two items in one call have the same
`dedupeKey`, the first item adds the job and the next items get `created: false`.

```js
const results = await sqlane.enqueueMany(connection, sendEmail, [
    { payload: { to: 'a@example.com' } },
    { payload: { to: 'b@example.com' }, options: { delay: '1m' } },
]);
```

## `runner.mount`

`runner.mount` runs handlers and fires schedules in this process, from now on.

```ts
runner.mount(parts: readonly (LaneHandler | ScheduleDefinition)[]): Mount
```

The parts are handlers from [`defineHandler`](#definehandler) and schedules from [`defineSchedule`](#defineschedule).
Mount them before `start()` or after it: after it, the runner claims the due jobs of the new lanes and fires the new
schedules at once. A schedule fires in this process while it is mounted, whether its lane is handled here or not, so a
process can be a scheduler only. A mount is checked whole, then added whole.

The handler runs outside any transaction, and its return value is ignored. A handler runs in the async context of the
`start()` or `drain()` call, never in the context of the code that woke the runner: an enqueue, the commit of a
transaction or a hint. So the `AsyncLocalStorage` stores of a request, and its CLS transaction, do not reach the
handlers. To give the handlers a context, such as a logger, call `start()` inside it.

`mount` throws a `ConfigError`, and mounts nothing, in these cases:

- A lane is handled here already, or twice in the parts.
- A schedule id is mounted here already, or twice in the parts.
- Two different definitions have one name, among the mounted lanes (of handlers and schedules) and their failure lanes.
- Two local limits with one name have different maxes in this runner; two local rate limits with one name have
  different settings. One local limit name has one max for the life of the runner.
- A definition has `globalConcurrencyLimits`, but no timeout is set in the definition or `defaults`.
- The job of a schedule would be refused: a payload above `maxPayloadBytes`, bad global limits.
- `drain()` runs.

`mount` throws a `ClosedError` after `close()`.

### `Mount.unmount`

`unmount` removes the parts of its mount from this process, at once: the runner stops claiming their lanes and firing
their schedules. A claim or a fire in flight completes with the old parts; the jobs that run go on to their end, and
`close()` waits for them. A job that fails for good after the unmount gets the failure lane of the old definition. The
lanes can be mounted again at once, with any handler: the jobs of the old one that still run count toward the running
count of the lane (its share) and toward the local limits that both handlers list.

`unmount` is sync and idempotent. During `drain()`, it throws a `ConfigError`; after `close()`, it does nothing.

### The handler context

The handler receives one object with three fields:

| Field     | Type          | Description                                                                                               |
| --------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `payload` | `P`           | The payload, as JSON gives it back. Its type is the declared payload type, or `any` without one.          |
| `job`     | `JobInfo`     | Information about the job (see below).                                                                    |
| `signal`  | `AbortSignal` | A signal that aborts when the handler must stop. Pass it to `fetch` and other APIs, or check it in loops. |

The `job` object has these fields:

| Field                     | Type                                      | Description                                                                                                          |
| ------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`                      | `string`                                  | The job id.                                                                                                          |
| `lane`                    | `string`                                  | The lane.                                                                                                            |
| `attempt`                 | `number`                                  | The current attempt. It is 1 for the first run.                                                                      |
| `maxAttempts`             | `number`                                  | The highest number of attempts for this job. Set at enqueue; a `one_more` retry changes it.                          |
| `enqueuedAt`              | `Date`                                    | The time of the enqueue.                                                                                             |
| `globalConcurrencyLimits` | `readonly { key: string, max: number }[]` | The keys of the global limits of the job, sorted, with their maxes.                                                  |
| `scheduledAt`             | `Date` or `null`                          | The slot of a job of a [schedule](#schedules), also when it runs late. `null` for other jobs.                        |
| `runAt`                   | `Date`                                    | The job's due time, as stored: its place in line (below).                                                            |
| `startedAt`               | `Date`                                    | The start of this run, by the database clock, as `JobRecord.startedAt` shows it.                                     |
| `fairGroup`               | `string` or `null`                        | Its [fair group](#fair-groups), whatever claimed it. `null`: none, or this runner's schema lacks `0011_fair_groups`. |

**The start delay** of a run is `startedAt − runAt`, and the time since the enqueue is `startedAt − enqueuedAt`. Both come
from one clock, the database's, whatever the clock of the process.

- `runAt` is the job's due time as stored, which is its place in line. A retry, a release, a stall,
  `drain({ includeDelayed })` and `jobs.retry` set it. A block on a key and its unblock keep it. After a
  [`RateLimitedError`](#errors-that-handlers-throw) on a global rate key, it also stays: the job keeps its place in line,
  so its start delay includes the run that was rate limited and the wait that followed.
- A `runAt` given with the `runAt` option is the app's time until the first rerun: the start delay may then be off by
  the skew between the clocks of the app and of the database.
- `startedAt` is the database time of the claim's last read before it writes the job, and the time at which the run's
  slots of global limits were taken. On MySQL and MariaDB, the claim takes it from its last read, after its waits on
  keys and slots. On PostgreSQL, it is taken when the claim inserts its slots (without slots, at its final write): a
  wait on another claim's insert of the same slot comes after that time, so `startedAt` may be early by that wait
  (milliseconds: the rest of the other claim's transaction). The `claimed` event, `JobInfo`, `JobRecord` and the slot
  show the same time.

The `signal.reason` tells you why the signal aborted:

- A `JobTimeoutError` means that the timeout has passed. The attempt fails with this error, even if the handler
  finishes later.
- A `LeaseLostError` means that the process could not renew the lease until 30 s before it ends, for example because
  the database is unreachable. The process then also emits `lease_lost`. Another process may now run the job.
- A `ShutdownError` means that `close()` reached its deadline.

JavaScript cannot stop a running function. After a timeout, the job keeps its keys and its slot until the
handler settles, but for at most one more lease (4 minutes). Your handler should therefore stop soon after the signal
aborts.

A handler finishes in one of these ways:

- If it returns or resolves, the job completes.
- If it throws, sqlane retries the job after the backoff. When no attempts are left, the job fails for good, and its
  failure job is added.
- If it throws a [`RetryJobError`](#errors-that-handlers-throw), sqlane retries the job after the delay of the error.
- If it throws a [`FatalJobError`](#errors-that-handlers-throw), the job fails for good at once.
- If it throws a [`RateLimitedError`](#errors-that-handlers-throw), the job waits for its rate limit, without using an
  attempt.

```js
runner.mount([defineHandler(buildReport, async ({ payload, job, signal }) => {
    await generateReport(payload.reportId, { signal });
})]);
```

## How free slots are shared

A runner runs at most `localMaxConcurrency` handlers at once. When slots are free and several lanes have due
jobs, a free slot goes to the due lane with the lowest `running / fairShareWeight` (of its handler). `running` counts
the jobs of the lane that run in this runner, by any of its handlers, retries included. The lane must be under each of
its local limits and the runner's cap. Ties go round-robin, in the order of the mounts.

- **Within a lane**, jobs start in FIFO order: `run_at`, then the id. Jobs of a key of a global limit start in FIFO
  order among those that can start. A lane with [fair groups](#fair-groups) shares its slots between its groups.
- **A lane is not in the race, and banks nothing,** while it has no due job, its due jobs have full keys, it is paused
  in this process, or it is at one of its local limits or over one of its local rate limits. The rule keeps no history: only the running counts of
  the moment.
- **The shares are per runner.** Each process shares its own slots.
- **Not oldest first across lanes.** In 4.x, the oldest due job across lanes started first. Now a busy lane cannot
  crowd out the others.
- **A lane woken by the end of a job of a key** competes by its share, like any other lane. The jobs blocked on the key
  are due again before the slot of the ended job is free, so they compete for it too.

With weights 3 and 1 on 8 slots, and both lanes busy, 6 jobs of the first lane and 2 of the second run. When a job
ends, its slot goes back to its own lane.

**The rule equalizes the running counts, not the order of the starts.** Take A's 10 jobs, then B's 3, with equal
weights and `localMaxConcurrency: 4`. A1 to A4 start first.

- When the 4 jobs end together, the next claims take `{A5, B1, A6, B2}`, then `{B3, A7, A8, A9}`.
- When the slots free one at a time, B first catches up to its share: `B1 B2 A5 A6 B3 …`.

**The odd remainder.** When a share is not a whole number of slots, the extra slot goes to a lane at each tie, not by
time. So a lane with long jobs keeps it longer. With jobs of 10 s against 1 s, equal weights and 3 slots, the long
jobs take 63.5 % of the slot time and the short ones 36.5 %: 1.9 and 1.1 slots, against 1.5 each. The error stays
below one slot. With 4 or 8 slots, each lane gets exactly half.

**Very short jobs.** Shares count running handlers. A lane whose jobs take a few milliseconds loses the short gap
between a completion and the next claim, so its measured slot time is a little below its share.

**Local limits.** Take T (weight 2, with a local limit of 1 of its own) and R (weight 1), which share a local limit
`heavy` of 2, and E (weight 3), on 10 slots. T and R each run 1 job, and E runs 8. With `heavy` at 4, R and E share
the 9 slots that T leaves by 1:3. A lane can have several local limits: it takes a slot while each of them has room.

### Fair groups

A lane with `fairGroup` in its definition shares its slots between the groups of its jobs, so one group with a big
backlog does not starve the others: one lane for the jobs of all tenants, each tenant a group.

```js
export const convertVideo = defineLane({
    name: 'convert_video',
    timeout: '2h',
    fairGroup: ({ payload }) => payload.outputQueueName,
});
```

- **The runner's definition decides.** A runner claims a lane by group when the definition of its mounted handler has
  `fairGroup`, and the schema has `0011_fair_groups`. Else it claims the lane FIFO, whatever groups the rows carry.
  `runner.getStatus(lane).fairGroups` tells which.
- **Within the lane, in one runner.** The lane's share of the free slots against the other lanes is unchanged: a lane
  with 50 groups takes one share, not 50. Each free slot of the lane goes to the due group with the fewest jobs running
  in this runner; ties go round-robin in the byte order of the groups, the jobs without a group last, from the group
  after the last one that won a tie. FIFO within a group. As between lanes, the rule equalizes the running counts as
  jobs end: a group that was alone keeps its slots until its jobs end.
- **The jobs without a group** (`null`, or enqueued by a definition without `fairGroup`) form one group together.
- **Per runner.** Each runner takes turns on its own, with no count in the database. With one runner, one slot and no
  other process on the lane's rows, between two starts of a group, every other group that was due gets one turn: a
  start, or a claim that fails a job past its `maxStalls` or puts back a job without its payload. With several
  runners, the starts are balanced on average.
- **Fixed at enqueue.** A retry, a stall, a release and `jobs.retry` keep the group. Groups are per lane: the same
  string in two lanes is two groups.
- **`dedupeKey` is per lane, not per group.** Producers that share a lane and reuse their own ids prefix the
  `dedupeKey` with their group, or their jobs collide.
- **Not with global limits.** `defineLane` rejects `fairGroup` with `globalConcurrencyLimits` or `globalRateLimits`. Jobs
  that bring global limits anyway (from another definition of the lane, or older enqueue options) make the runner claim
  the lane FIFO with their limits until it restarts, with a warning.
- **Cost.** A turn with a grouped lane reads its groups that have pending jobs (due or not) on the index of
  `0011_fair_groups`, then locks the oldest due jobs of a few groups per free slot. Hundreds of groups with pending jobs
  per lane are fine. The index covers the pending rows of every lane: a few more blocks per enqueue.
- **Without `0011_fair_groups`.** A runner claims the lane FIFO and logs a warning once; the jobs that it adds itself
  (failure jobs, slots of schedules) get no group; `JobInfo.fairGroup` is `null`. While it lacks it, a runner with a
  lane, a schedule or a failure lane with `fairGroup` reads the records of the migrations at `start()`, `drain()` and
  each poll interval: after `schema.migrate()`, it claims by group without a restart. A runner without such a lane
  reads them once, at its first `start()` or `drain()`.
- **Upgrading.** Every process that imports a definition with `fairGroup` needs 10.1: a 10.0 `defineLane` rejects the
  unknown option, so a package that exports one declares a peer dependency on `@sqlane/core >=10.1`. Then run
  `schema.migrate()`, then add `fairGroup`. Producers with an older definition put their jobs in the group without a
  name; a 10.0 runner claims FIFO.
- **Not in 10.1:** weights per group, a pause of one group, and a `fairGroup` filter of `jobs.list`. To clear the
  backlog of one group, list the lane's jobs with their payloads and cancel them by id.

[`lanes.groupStats`](#lanesgroupstats) shows the groups of a lane, worst first.

## Schedules

A schedule adds a job at each time of a cron in a time zone, or at a fixed interval. You define it with
[`defineSchedule`](#defineschedule), next to its lane, and a runner fires it while it is mounted.

```ts
defineSchedule(lane: LaneDefinition, options: ScheduleOptions): ScheduleDefinition
```

Each time of a schedule is a **slot**. At each slot, every started runner that mounts the schedule tries to add the job,
and one of them adds it: each slot adds at most one job in the whole cluster, with no leader. A scheduled job is an
ordinary job: its definition gives its retries, backoff, timeout, global limits, failure job and retention.

| Option     | Type                  | Default   | Description                                                                                                                                                                                      |
| ---------- | --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key`      | `string`              | Required  | Tells the schedules of a lane apart, in their id `<lane>:<key>`. It has 1 to 64 printable ASCII characters, without spaces at the ends.                                                          |
| `cron`     | `string`              | None      | A cron expression with 5 fields (see below). Set either `cron` or `every`.                                                                                                                       |
| `timezone` | `string`              | `'UTC'`   | An IANA time zone, such as `'Europe/Berlin'`, in any case: `'europe/berlin'` is the same zone. Only with `cron`.                                                                                 |
| `every`    | `Duration`            | None      | A fixed interval from `'1s'` to `'1d'`, counted from 1970-01-01 00:00 UTC. An interval over 1 hour must divide 1 day: `'2h'`, `'3h'`, `'4h'`, `'6h'`, `'8h'`, `'12h'` or `'1d'`.                 |
| `payload`  | `P`                   | `{}`      | The payload of each job. It is fixed: the handler gets the slot from `job.scheduledAt`. When the definition declares a payload type, `payload` is required and checked.                          |
| `missed`   | `'once'` or `'skip'`  | `'once'`  | What happens to a slot that no process enqueued within 1 minute, for example during a downtime. `'once'` runs the latest missed slot once, within the catch-up reach (below). `'skip'` drops it. |
| `overlap`  | `'allow'` or `'skip'` | `'allow'` | With `'skip'`, a slot adds no job while the previous job of this schedule is pending or running, including its retries.                                                                          |
| `jitter`   | `Duration`            | None      | Spreads the runs of many schedules. Each slot runs at a fixed offset after its time, below `jitter` and below the next slot. At most `'1d'`, and below `every`.                                  |

Every started runner that mounts the schedule fires it. The runner does not need to handle the lane, so a dedicated
scheduler process works. A process without a runner, such as a web process, never adds scheduled jobs.

```js
export const nightlyReport = defineLane({ name: 'nightly_report', timeout: '10m' });
export const nightly = defineSchedule(nightlyReport, { key: 'nightly', cron: '0 3 * * *', timezone: 'Europe/Berlin' });
export const tenant42 = defineSchedule(syncTenant, {
    key: 'tenant-42', every: '15m', payload: { tenantId: 42 }, overlap: 'skip',
});

runner.mount([
    defineHandler(nightlyReport, async ({ job, signal }) => {
        await buildReport({ day: job.scheduledAt, signal }); // the slot, also when the run is late
    }),
    nightly,
    tenant42,
]);
await runner.start();
```

The **schedule id** `<lane>:<key>` names one schedule in the whole cluster: two services must not use one id for two
different schedules.

`defineSchedule` throws a `ConfigError` for bad options and for a cron that never fires within 50 years.
`runner.mount()` throws one for a schedule id mounted here already, a payload above `maxPayloadBytes` and bad global
limits of the definition: a bad schedule fails at deploy time, not at 03:00. With schedules, `runner.start()` also
needs the table of migration `0004_schedules`: run `schema.migrate()`.

### Cron syntax

A cron has 5 fields: `minute hour day-of-month month day-of-week`. Spaces or tabs separate them.

| Field        | Values              |
| ------------ | ------------------- |
| Minute       | 0–59                |
| Hour         | 0–23                |
| Day of month | 1–31                |
| Month        | 1–12 or `JAN`–`DEC` |
| Day of week  | 0–7 or `SUN`–`SAT`  |

- Each item of a comma list is `*`, `n`, `a-b`, `*/s`, `a-b/s` or `a/s`. `a/s` runs from `a` to the end of the field.
  Names ignore case and work in ranges.
- Both 0 and 7 mean Sunday. In the day of week, `*` and `a/s` count over 0–6: `1/2` is Mon, Wed and Fri.
- If both day fields are restricted, which means that neither starts with `*`, a day matches when either field
  matches. Otherwise both must match.
- The macros `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight` and `@hourly` work.
- There is no seconds field: use `every` for less than a minute. `L`, `W`, `#`, `?`, `H`, a year field and `@reboot`
  throw a `ConfigError`.

**Differences from other cron libraries:**

- `*/2` in a day field counts as `*` for the day rule above, as in Vixie cron. River treats it as restricted.
- The steps of the day of week run over 0–6.
- The DST rules below.
- There is no seconds field.

### Time zones and DST

A cron matches wall-clock times in its zone. A spec whose hour field has all 24 hours (`*`, `0-23` or `*/1`) is an
**every-hour** spec. It counts elapsed time. Any other spec is an appointment.

| Case                                              | An appointment                                                        | An every-hour spec                                        |
| ------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| Spring forward: Berlin 02:00–02:59 does not exist | A matching time in the gap runs once, when the gap ends (03:00 CEST). | The gap is skipped. The next match comes within the hour. |
| Fall back: Berlin 02:00–02:59 happens twice       | A matching time runs at its first occurrence only.                    | It runs at both occurrences.                              |

So `30 2 * * *` runs exactly once every day of the year. `*/15 0-22 * * *` is not every-hour, so on the fall-back night
its 02:xx times run once. `every` counts in UTC, so DST does not affect it.

### `every`

`every` counts from the Unix epoch in UTC, so all processes compute the same slots, and a restart keeps them. An
interval over 1 hour must divide 1 day, so it lands on the same UTC times each day: `'6h'` runs at 00, 06, 12 and 18
UTC, and `'1d'` at midnight UTC. For weekly runs, use a cron such as `0 0 * * 1`. An interval up to 1 hour that does
not divide 1 hour, such as `'7m'`, does not start at a fixed minute of the hour.

### Missed slots and the catch-up reach

A slot is on time while the database time minus the slot is at most 1 minute. With `missed: 'once'`, a later start runs
the **latest** missed slot once, as a job that is due now (after its [jitter](#jitter) offset, if any). It runs only if
the schedule's last decided slot is at most one period plus 1 day older than that slot. That is the catch-up reach.
After a longer absence, the schedule starts fresh.

| Example                                                              | Catch-up            |
| -------------------------------------------------------------------- | ------------------- |
| A daily job's slot is missed by a 2-minute full restart.             | Yes                 |
| A weekly job's slot is missed, and the restart comes 20 hours later. | Yes                 |
| A daily job's process is down for 3 days.                            | No: it starts fresh |
| A schedule is removed from code, then added back 2 months later.     | No: it starts fresh |
| A job that runs every minute is down for 3 hours.                    | Yes, once           |

A process that stalls runs only the latest due slot, never a burst. A slot before the first start of a schedule never
runs.

### Overlap

| Need                                             | How                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs may overlap                                 | The default, `overlap: 'allow'`.                                                                                                                                                                                                                                      |
| Skip a slot while the previous run is not done   | `overlap: 'skip'`. "Not done" means that the last job of the schedule is pending or running, retries included.                                                                                                                                                        |
| Queue the slot and run it after the previous one | A global limit of 1 in the definition, such as `globalConcurrencyLimits: () => [nightly]` with `nightly = defineConcurrencyLimit({ name: 'nightly_report', max: 1 })`, and a `timeout`. The runs wait in line. They pile up if every run is slower than the interval. |

### Jitter

`jitter` spreads the runs of many schedules. Each slot runs at a fixed offset after its time, below `jitter` and below
the time of the next slot, so a slot's jitter never pushes it past the next slot. The offset is in whole seconds when
that limit is at least 1 second. It comes from the schedule id and the slot, so every process agrees. The job's
`scheduledAt` stays the slot, and its `runAt` is the slot plus the offset. A late catch-up keeps its offset as a delay.
A slot run by hand (`schedules.runSlot`) has no jitter. A change of `jitter` alone keeps the catch-up.

### Deploys and removed schedules

- Each slot adds at most one job, whatever the spec. During a rolling deploy, old and new processes both run their
  on-time slots until the old ones stop. For a clean break, change `key`: that makes a new schedule.
- A late catch-up needs the stored spec to equal the spec of the process. So moving `0 3 * * *` to `0 5 * * *` does
  not run the 05:00 slot of today at once. The specs are normalized, so `MON-FRI` and `1-5` are the same spec.
- A change of `payload`, `overlap` or `missed` applies from the next slot.
- A schedule that you remove from code stops. Its row stays: `schedules.list()` lists it with its last slot. Delete it
  with [`schedules.remove`](#schedulesremove); the rows of the keyless schedules of 9.x too.
- To stop a schedule in every process without a deploy, pause it:
  [`schedules.pauseGlobally`](#schedulespauseglobally-and-resumeglobally).

### The clock

Each process computes its slots, but the **database clock** decides them. If the clock of a process differs from the
database clock by more than 5 seconds, sqlane logs a warning, at most once per 10 minutes. A process with a wrong
clock still adds each job at its slot by the database time.

### The `schedule:` prefix and a manual run

The job id of a slot is `<lane>:schedule:<key>:<ISO time>`, for example
`nightly_report:schedule:nightly:2026-11-11T02:00:00.000Z`. The `dedupeKey` prefix `schedule:` is reserved: `enqueue`
rejects it. To run a slot by hand, use [`schedules.runSlot`](#schedulesrunslot): it builds the same job id as the
scheduler, so the scheduler adds no second job for that slot.

### Guarantees

- Each slot adds **at most one job, ever**. The cursor row of the schedule only moves forward, and it outlives the
  retention of the job.
- A slot adds a job if a started process with the schedule is up within 1 minute after it, or, with `missed: 'once'`,
  at the next start within the catch-up reach. One exception: if a fire of a slot rolls back, and a later slot of the
  schedule is decided first, the earlier slot is skipped.
- The job itself runs at least once, as any job does.

## `schedules.list`

`sqlane.schedules.list` lists the schedules of the table: the database, for every process. A schedule is listed once
a started runner has mounted it, or a pause has created its row. `sqlane.schedules` is a frozen object of the sqlane.
It needs no runner.

```ts
sqlane.schedules.list(): Promise<ScheduleInfo[]>
```

| Field            | Type               | Description                                                                                                                                                                             |
| ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `string`           | `<lane>:<key>`.                                                                                                                                                                         |
| `lane`           | `string`           | The lane.                                                                                                                                                                               |
| `spec`           | `string`           | The stored spec, for example `cron 0 3 * * * Europe/Berlin` or `every 900000`. `unknown` for a schedule paused by its id before a runner fired it.                                      |
| `nextAt`         | `Date` or `null`   | The next slot, by the stored spec and the database clock. `null` while the schedule is paused, or for a spec that this version cannot read.                                             |
| `nextRunAt`      | `Date` or `null`   | When the job of the next slot will be due: `nextAt` plus its jitter, for a schedule mounted in this process with the stored spec. For another schedule, it is `nextAt`, without jitter. |
| `lastSlotAt`     | `Date`             | The last decided slot; for a new schedule, the time a runner first started it, or the time of the pause that created its row.                                                           |
| `lastJobId`      | `string` or `null` | The job that the last enqueued slot added.                                                                                                                                              |
| `pausedGlobally` | `boolean`          | [`schedules.pauseGlobally`](#schedulespauseglobally-and-resumeglobally) paused it: no process fires it.                                                                                 |

Sorted by id. After a deploy that changes a spec, `spec` shows the old one until the first slot of the new spec. Without
schedules and without the table, it resolves to `[]`. On a schema without the migration `0010_pause`, it rejects with a
`ConfigError`: run `schema.migrate()`.

## `schedules.runSlot`

`sqlane.schedules.runSlot` enqueues a slot of a schedule by hand, as a runner would: the payload of the schedule,
the dedupe key of the slot, the options of its lane.

```ts
sqlane.schedules.runSlot(schedule: ScheduleDefinition, options?: { at?: Date, connection?: C }): Promise<EnqueueResult>
```

| Option       | Type   | Default                                       | Description                                                                                                                             |
| ------------ | ------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `at`         | `Date` | The latest slot at or before now              | The slot: a slot of the spec, not in the future. The default uses the clock of this process; the runners use the clock of the database. |
| `connection` | `C`    | The queue's pool, in a transaction of its own | Your transaction, or a connection in one, of the adapter's library; or a pool.                                                          |

The job is due now: `runSlot` ignores `overlap` and the jitter, and leaves `lastSlotAt` and `lastJobId` of the schedule
as they are. A second run of the slot gives `created: false`. When the slot comes, the runners add no second job, and
record this one as `lastJobId`, so `overlap: 'skip'` tracks it. It works without a runner, so in tests and in admin
tasks. It takes a schedule definition only, which holds the payload. An `at` off the spec or in the future rejects with
an `InvalidOptionsError`.

```js
// A test: the slot, then the runner runs its job
await sqlane.schedules.runSlot(nightly);
await runner.drain();
```

`runSlot` ignores a [global pause](#schedulespauseglobally-and-resumeglobally) of the schedule.

## `schedules.pauseGlobally` and `resumeGlobally`

`sqlane.schedules.pauseGlobally` stops a schedule in every process: no runner fires it, until
`sqlane.schedules.resumeGlobally`.

```ts
sqlane.schedules.pauseGlobally(schedule: ScheduleDefinition | string, options?: { connection?: C }): Promise<void>
sqlane.schedules.resumeGlobally(schedule: ScheduleDefinition | string, options?: { connection?: C }): Promise<void>
```

| Parameter            | Type                           | Description                                                                                               |
| -------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `schedule`           | `ScheduleDefinition \| string` | A schedule definition, or its id `<lane>:<key>`.                                                          |
| `options.connection` | `C`                            | Your transaction, or a connection in one, of the adapter's library; or a pool. Default: the queue's pool. |

- The pause is stored in the row of the schedule, so it holds across restarts and deploys, in every process. The
  runners see it at their next slot.
- The slots during the pause are skipped: no job, and no `schedule_fired` event. A slot that a runner was firing when
  the pause came may still add its job.
- `resumeGlobally` moves the cursor of the schedule to now: the slots of the pause are not caught up, whatever
  `missed` says. The next slot after the resume fires as usual. A schedule that is not paused, or that has no row:
  nothing changes.
- A schedule with no row yet (never started): `pauseGlobally` creates its row, paused, with its cursor at now. So you
  can pause a schedule before its first deploy. By its id, the row gets the spec `unknown` until its first fire after
  the resume. A typo makes a row too: `schedules.list()` shows it, and [`schedules.remove`](#schedulesremove)
  deletes it.
- The jobs of the schedule that exist go on. To hold them too, pause the lane:
  [`lanes.pauseGlobally`](#lanespauseglobally-and-resumeglobally). A paused lane's schedules go on firing, and their
  jobs wait pending.
- Both are idempotent: a second pause keeps the time of the first.

They reject with an `InvalidOptionsError` for a schedule that is neither a definition nor an id `<lane>:<key>`, or an
unknown option, and with a `ConfigError` on a schema without the migration `0010_pause`.

```js
await sqlane.schedules.pauseGlobally(nightly); // or 'nightly_report:nightly'
// …
await sqlane.schedules.resumeGlobally(nightly);
```

## `schedules.remove`

`sqlane.schedules.remove` deletes the row of a schedule: its cursor, its last job and its pause.

```ts
sqlane.schedules.remove(schedule: ScheduleDefinition | string, options?: { connection?: C }): Promise<{ removed: boolean }>
```

Use it for a schedule deleted from the code, for the row of a typo, and for the rows of the keyless schedules of 9.x,
whose id is `<lane>`. `removed` is `false` when there was no row. A schedule that a started runner still mounts gets its
row back at its next fire, fresh: not paused, with its cursor at that slot. It rejects with an `InvalidOptionsError` for
a schedule that is neither a definition nor an id `<lane>:<key>` or `<lane>`.

```js
await sqlane.schedules.remove('nightly_report'); // a keyless schedule of 9.x
```

## `lanes.pauseGlobally` and `resumeGlobally`

`sqlane.lanes.pauseGlobally` stops the claims of a lane in every process: no runner claims its jobs, until
`sqlane.lanes.resumeGlobally`.

```ts
sqlane.lanes.pauseGlobally(lane: LaneDefinition | string, options?: { connection?: C }): Promise<void>
sqlane.lanes.resumeGlobally(lane: LaneDefinition | string, options?: { connection?: C }): Promise<void>
```

| Parameter            | Type                       | Description                                                                                               |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `lane`               | `LaneDefinition \| string` | A lane definition, or the name of a lane. A lane with no job yet is fine.                                 |
| `options.connection` | `C`                        | Your transaction, or a connection in one, of the adapter's library; or a pool. Default: the queue's pool. |

- The pause is stored in the database, so it holds across restarts and deploys, in every process. The runners see it
  at their next poll, or at a hint. `drain()` sees it at its next round.
- The running jobs finish. The enqueues go on, and so do the schedules of the lane: their jobs wait pending. The stall
  recovery, the retries and the cleanup go on.
- The blocked jobs of a paused lane stay blocked, and take no room of a key that other lanes share: the jobs of the
  other lanes on the key run. On MySQL and MariaDB, for one poll after the pause, one of them can still take the room
  of an unblock, until the next release of the key.
- `resumeGlobally` makes the blocked jobs of the lane pending again, as far as their keys have room or quota, wakes the
  runner of this process, and sends the [hint](#hint) (if any) to the others. With a `connection`, the lane runs again
  within seconds of the commit.
- A paused lane still counts in [`lanes.stats`](#lanesstats): its `due` and its `oldestDueAgeMs` grow. An alert on
  them should skip the entries with `pausedGlobally: true`.
- Both are idempotent: a second pause keeps the time of the first; a resume of a lane that is not paused does nothing.

They reject with an `InvalidOptionsError` for a lane that is neither a definition nor a name, or an unknown option, and
with a `ConfigError` on a schema without the migration `0010_pause`. To pause a lane in this process only, use
[`runner.pauseLocally`](#runnerpauselocally).

```js
await sqlane.lanes.pauseGlobally(report); // an incident: no process runs it
// …
await sqlane.lanes.resumeGlobally(report);
```

## `runner.pauseLocally`

`runner.pauseLocally(lane)` makes this process stop claiming the jobs of the lane; `runner.resumeLocally(lane)` claims
them again, at once. To pause a lane in every process, use
[`lanes.pauseGlobally`](#lanespauseglobally-and-resumeglobally).

```ts
runner.pauseLocally(lane: LaneDefinition | string): void
runner.resumeLocally(lane: LaneDefinition | string): void
```

The pause is in memory, by lane name, for the life of the runner: it works before the lane is mounted, and it holds
across an unmount and a mount. The running jobs finish; the schedules of the lane go on, and its jobs wait pending; the
enqueues of the lane in this process send the hint to the others. Both are sync and idempotent. A pause during
`drain()` applies to the jobs that it claims next. Both throw an `InvalidOptionsError` for a lane that is neither a
definition nor a name.

## `runner.getStatus`

`runner.getStatus` tells what a lane or a schedule does in this process.

```ts
runner.getStatus(lane: LaneDefinition | string): { mounted: boolean, pausedLocally: boolean, running: number, fairGroups: boolean }
runner.getStatus(schedule: ScheduleDefinition | `${string}:${string}`): { mounted: boolean }
```

For a lane: a handler of it is mounted here; a local pause holds it; its jobs that run here, by any of its handlers;
this runner claims it by [fair group](#fair-groups) now (false in each case where it claims the lane FIFO). For
a schedule, a definition or an id (a string with `:`): it is mounted here. An unknown name or id gives `mounted: false`.

## `runner.start`

`runner.start` starts the runner of this process.

```ts
runner.start(): Promise<void>
```

After `start()`, the runner claims and runs the due jobs of the mounted lanes that no pause holds, local or global. It
also renews leases, recovers stalled jobs and, if `cleanup` is on, deletes expired jobs. It fires the mounted
[schedules](#schedules) that no global pause holds. A second call does nothing, and concurrent calls share one start.
The mounts after it claim and fire at once.

`start` needs the migration `0010_pause`: it rejects with a `ConfigError` until it is applied (run `schema.migrate()`).
With schedules, it adds their rows to the table first. If the database is down, `start` resolves anyway, emits an
`error` event, claims nothing until it can check the migrations, and adds the rows when the database is back. A
rejected `start` can be called again.

The first `start()` or `schema.migrate()` of a sqlane checks the server: it rejects with a `ConfigError` if the
server is not the database of the adapter's `dialect`, is below the supported version, or has a `sql_mode` that sqlane
does not support ([server check](adapters.md#the-dialect-and-the-server-check)). If the database is down, `start`
resolves anyway and emits an `error` event. `start` rejects with a `ConfigError` during `drain()`, and with a
`ClosedError` after `close()`.

## `runner.drain`

`runner.drain` runs the due jobs of the mounted lanes until none is left, without `start()`. It is meant for tests.

```ts
runner.drain(options?: DrainOptions): Promise<DrainResult>
```

`drain` only runs the lanes mounted in this runner that no pause holds, local or global, and only the jobs that are due.
It does not wait for jobs of other lanes, nor for the jobs of a paused lane. It does not fire schedules: in tests, run a
slot with [`sqlane.schedules.runSlot`](#schedulesrunslot). Like `start`, it needs the migration `0010_pause`.

| Option           | Type       | Default | Description                                                                               |
| ---------------- | ---------- | ------- | ----------------------------------------------------------------------------------------- |
| `timeout`        | `Duration` | `'10s'` | The longest time that `drain` runs. After it, `drain` rejects with a `DrainTimeoutError`. |
| `includeDelayed` | `boolean`  | `false` | When it is `true`, delayed jobs and retries that wait for their backoff run at once.      |

`drain` resolves to counts of what it did:

| Field       | Type     | Description                                 |
| ----------- | -------- | ------------------------------------------- |
| `completed` | `number` | The jobs that completed.                    |
| `retried`   | `number` | The failed attempts that sqlane will retry. |
| `failed`    | `number` | The jobs that failed for good.              |

`drain` also waits for the jobs that a rate limit holds back in this runner, when their next start comes before
the `timeout`. A `RateLimitedError` that sends a job back to wait is not counted.

`drain` rejects with a `ConfigError` after `start()`, while another `drain()` runs, or without the migration
`0010_pause`; a mount or an unmount during it throws one too. It rejects with an `InvalidOptionsError` for a bad
`timeout`, and with a `ClosedError` after `close()`.

```js
await orderReport('report-1');
const { completed, failed } = await runner.drain({ includeDelayed: true });
```

## `runner.close` and `sqlane.close`

`runner.close` stops the runner of this process and waits for the running handlers. `sqlane.close` closes the runner
of the sqlane, if any, with these options, then stops publishing hints and unsubscribes from the hint. It never ends
your pools.

```ts
runner.close(options?: CloseOptions): Promise<void>
sqlane.close(options?: CloseOptions): Promise<void>
```

`close` stops claiming new jobs and firing schedules. Then it waits for the running handlers until the deadline. At the deadline, it aborts
the `signal` of each unfinished handler with a `ShutdownError`.

| Option     | Type                       | Default                                                           | Description                                                                                                                                                                                                    |
| ---------- | -------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deadline` | `Duration`                 | `'30s'`                                                           | How long `close` waits for the running handlers, counted from the call.                                                                                                                                        |
| `mode`     | `'release'` or `'abandon'` | `'release'`                                                       | What happens to an unfinished job at the deadline. With `'release'`, the job goes back to the queue without using an attempt. With `'abandon'`, sqlane writes nothing, and the job stalls when its lease ends. |
| `exitsBy`  | `Duration`                 | The deadline plus one lease (`'4m30s'` with the default deadline) | The latest time at which the process exits, counted from the call. A released job whose handler still runs waits until this time plus 2 seconds before it runs again, and its keys stay held until then.       |

Set `exitsBy` lower if your process exits sooner, so released jobs can run again sooner. `close` never rejects
because of its options, so a shutdown always releases its jobs. Instead, each invalid option logs a warning, and sqlane
uses its default. This includes an unknown option, and an `exitsBy` that is earlier than the deadline.

`close` resolves when the handlers have settled or the deadline has passed, and the releases are written. It also
waits for a schedule fire in flight. A second call returns the same promise. `close` ends only what sqlane opened, such
as the LISTEN connection. After `runner.close()`, the sqlane still enqueues, and sends the hint; after `sqlane.close()`,
it sends no hint: a hint not sent yet is dropped, and its jobs run at the next poll.

```js
process.once('SIGTERM', () => sqlane.close({ deadline: '30s', exitsBy: '35s' }));
```

## `schema.migrate`

`schema.migrate` creates or updates the tables of sqlane in the database.

```ts
sqlane.schema.migrate(options?: { targetVersion?: string, lockTimeout?: Duration }): Promise<{ applied: string[] }>
```

`schema.migrate` applies the missing migrations in order, and resolves to the ids of the migrations it applied. It
holds a database lock, so several processes can call it at the same time. It uses a connection of the adapter's pool.

Each migration is tagged with the lowest version of sqlane that ships it. With `targetVersion`, `schema.migrate`
applies only the migrations tagged at or below that version. So a migration file of your app pins the schema of a
version, and a new install replays the same steps.

| Option          | Type       | Default         | Description                                                                                                                     |
| --------------- | ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `targetVersion` | `string`   | Every migration | A version `'X.Y.Z'`, from `'6.0.0'` up to the installed version. `schema.migrate` applies the migrations tagged at or below it. |
| `lockTimeout`   | `Duration` | `'10m'`         | How long `schema.migrate` waits for the lock. After it, `schema.migrate` rejects with a `MigrationLockTimeoutError`.            |

`schema.migrate` rejects with an `InvalidOptionsError` for a bad `lockTimeout`, or for a `targetVersion` that is not
`X.Y.Z` (`'v9.0.0'`, `'9.0'` or a pre-release), is below `'6.0.0'`, or is above the installed version. An installed
pre-release, such as `9.0.0-rc.1`, counts as its base version, `9.0.0`. It rejects with a `ConfigError` if the server
is not the database of the adapter's `dialect`, is below the supported version, or has a `sql_mode` that sqlane does
not support: the first `schema.migrate()` or `start()` of an instance checks it
([server check](adapters.md#the-dialect-and-the-server-check)). After `close()`, it rejects with a `ClosedError`.

10.x requires `0010_pause`, the global pauses: `runner.start()` and `runner.drain()` reject without it. 10.1 adds
`0011_fair_groups`, the column and the index of the [fair groups](#fair-groups): optional, only a lane with
`fairGroup` needs it. Its index covers the pending rows of every lane: on a large PostgreSQL table, build it
`CONCURRENTLY` first, as for `0008_job_list`. 9.x requires
`0009_lanes`, which renames the columns of the lane. `get`, `list` and the batches of
[`sqlane.jobs`](#jobs) also require the migration `0008_job_list`, an index of the jobs. The build of the index waits
for the writes of the jobs, and they wait for it: on a large PostgreSQL table, build the index `CONCURRENTLY` first, as the
[design](design.md#migrations) describes.

```js
const { applied } = await sqlane.schema.migrate();
```

### From your own migration tool

Call `schema.migrate` from a migration file of your tool, with the version that the file pins. A later file moves to a
later version, and its down goes back with [`schema.rollback`](#schemarollback). The first file's down drops the
tables with [`schema.drop`](#schemadrop).

Do not run these calls inside a transaction of the tool. sqlane runs them on a connection of its own, so the
transaction would not include them, and the locks that it holds can block them. Pass a short `lockTimeout`, such as
`'10s'`, to `schema.rollback` and `schema.drop` while processes run: their DDL waits for the locks of the tables, and
the queries of the queue wait behind it.

A Sequelize CLI migration, in full. `@sqlane/core` is an ES module, so CommonJS code imports it with `import()`. A
module outside the folder of the migrations creates the instance, for every migration file:

```js
// db/sqlane_schema.cjs
'use strict';

/**
 * A sqlane instance over the Sequelize instance of a migration.
 * @param {import('sequelize').Sequelize} sequelize
 */
async function sqlaneOf(sequelize) {
    const { createSqlane } = await import('@sqlane/core');
    const { sequelizeAdapter } = await import('@sqlane/core/adapter-sequelize');

    return createSqlane({
        // Your database: 'postgres', 'mysql' or 'mariadb'
        adapter: sequelizeAdapter(sequelize, { dialect: 'postgres' }),
        // The same prefix as in your app
        tablePrefix: 'sqlane_',
    });
}

module.exports = { sqlaneOf };
```

```js
// migrations/20261120000000-sqlane.cjs
'use strict';

const { sqlaneOf } = require('../db/sqlane_schema.cjs');

module.exports = {
    // Not inside queryInterface.sequelize.transaction(): sqlane runs on a connection of its own
    async up(queryInterface) {
        const sqlane = await sqlaneOf(queryInterface.sequelize);

        await sqlane.schema.migrate({ targetVersion: '9.0.0' });
    },
    async down(queryInterface) {
        const sqlane = await sqlaneOf(queryInterface.sequelize);

        await sqlane.schema.drop({ lockTimeout: '10s' });
    },
};
```

A later file pins a later version:

```js
// migrations/20270201000000-sqlane-9-2.cjs
'use strict';

const { sqlaneOf } = require('../db/sqlane_schema.cjs');

module.exports = {
    async up(queryInterface) {
        const sqlane = await sqlaneOf(queryInterface.sequelize);

        await sqlane.schema.migrate({ targetVersion: '9.2.0' });
    },
    async down(queryInterface) {
        const sqlane = await sqlaneOf(queryInterface.sequelize);

        await sqlane.schema.rollback({ targetVersion: '9.0.0', lockTimeout: '10s' });
    },
};
```

## `schema.rollback`

`schema.rollback` reverts the migrations tagged above a version.

```ts
sqlane.schema.rollback(options: { targetVersion: string, lockTimeout?: Duration }): Promise<{ reverted: string[] }>
```

`schema.rollback` reverts the recorded migrations tagged above `targetVersion`, newest first. For each one, it runs its
down statements, then deletes its record. It resolves to the ids that it reverted. Nothing above the version, or no
table of the migrations: `reverted` is empty. It holds the lock of `schema.migrate`.

| Option          | Type       | Default  | Description                                                                                                                             |
| --------------- | ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `targetVersion` | `string`   | Required | A version `'X.Y.Z'`, from `'6.0.0'` up to the installed version. The migrations tagged above it are reverted.                           |
| `lockTimeout`   | `Duration` | `'10m'`  | How long `schema.rollback` waits for the lock, and for the lock of each table. After it, it rejects with a `MigrationLockTimeoutError`. |

- Each down statement is safe to run again. A rollback that was cut, by a crash or a timeout, finishes when you run it
  again.
- A down that drops a column or a table loses its data. Today, the downs are those of `0008_job_list`, which drops an
  index, of `0009_lanes`, which renames the columns of the lane back, of `0010_pause`, which drops the global pauses
  (the paused lanes and schedules run again), and of `0011_fair_groups`, which drops the groups of the jobs: run it with
  the runners stopped, as a runner that saw it fails its claims until it restarts.
- Run it only when no process of a newer version uses the tables.
- `'6.0.0'` is the lowest version: the migrations of 6.0 turned the mutex keys of 5.x into slots, and they have no way
  back.

`schema.rollback` rejects with an `InvalidOptionsError` for a missing or bad `targetVersion`, as in `schema.migrate`,
or a bad `lockTimeout`. It rejects with a `ConfigError` when the table of the migrations records a migration that this
version does not know: a newer version applied it, and its down is not in this code. It also rejects with a
`ConfigError` while the runner of this sqlane is started or draining, and with a `ClosedError` after `close()`.

```js
const { reverted } = await sqlane.schema.rollback({ targetVersion: '9.0.0', lockTimeout: '10s' });
```

## `schema.drop`

`schema.drop` drops the tables of sqlane, with their data.

```ts
sqlane.schema.drop(options?: { lockTimeout?: Duration }): Promise<{ dropped: string[] }>
```

`schema.drop` drops every table that sqlane created under the prefix in any version, in one statement: the current
tables, the `mutexes` and `job_keys` of older versions, and the table of the migrations last. It resolves to the tables
that existed. With no table, it does nothing. It holds the lock of `schema.migrate`. Stop the other processes on the
prefix first.

| Option        | Type       | Default | Description                                                                                                                          |
| ------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `lockTimeout` | `Duration` | `'10m'` | How long `schema.drop` waits for the lock, and for the locks of the tables. After it, it rejects with a `MigrationLockTimeoutError`. |

`schema.drop` drops only the tables of sqlane. It checks that `<prefix>jobs` has the columns `enqueue_token` and
`lock_token`, or that `<prefix>migrations` records `0001_initial`. If neither holds, it rejects with a `ConfigError`
that names the tables it found, and drops nothing. So pick a prefix that shares no table name with your app: a
collision on any table already breaks sqlane, and `schema.drop` would drop that table too.

`schema.drop` also rejects with a `ConfigError` when the table of the migrations records a migration that this version
does not know (a newer version would leave tables behind), and while the runner of this sqlane is started or draining. It rejects
with an `InvalidOptionsError` for a bad `lockTimeout`, and with a `ClosedError` after `close()`.

A `schema.migrate()` cut before its first table leaves only an empty `<prefix>migrations`, which `schema.drop`
refuses: run `schema.migrate()` again.

```js
const { dropped } = await sqlane.schema.drop({ lockTimeout: '10s' });
```

## `schema.getMigrationStatus`

`schema.getMigrationStatus` tells what `schema.migrate` would do, by the records of the migrations.

```ts
sqlane.schema.getMigrationStatus(): Promise<MigrationStatus>
```

| Field             | Type       | Description                                                                                                     |
| ----------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `ok`              | `boolean`  | `missingRequired` is empty.                                                                                     |
| `missingRequired` | `string[]` | The migrations not recorded and tagged up to the base of the installed major, `X.0.0`. This version needs them. |
| `missingOptional` | `string[]` | The migrations not recorded and tagged above `X.0.0`. Only the features that they serve need them.              |
| `unknownApplied`  | `string[]` | The migrations recorded but unknown to this version: a newer version migrated.                                  |

It only reads, and never throws on a mismatch. It reads the table of the migrations only if the catalog has it, in the
current schema. With no table, every migration is missing.

## `schema.findSchemaProblems`

`schema.findSchemaProblems` tells whether the queries of this version find what they need, by the catalog.

```ts
sqlane.schema.findSchemaProblems(): Promise<SchemaProblems>
```

It compares the tables of the prefix with the exact definitions that the migrations of this version create, per
dialect, by name. It ignores anything extra: a column or an index of your own does no harm. It resolves to `ok`, true
when no problem is required, and to `problems`:

| Field      | Type      | Description                                                                                             |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------- |
| `table`    | `string`  | The table, with its prefix.                                                                             |
| `column`   | `string`  | The column of a column problem.                                                                         |
| `index`    | `string`  | The index of an index problem, with its prefix. The primary key of MySQL and MariaDB is `PRIMARY`.      |
| `issue`    | `string`  | `missing_table`, `missing_column`, `wrong_type`, `wrong_nullability`, `missing_index` or `wrong_index`. |
| `expected` | `string`  | For a wrong type, nullability or index: what this version expects.                                      |
| `found`    | `string`  | For a wrong type, nullability or index: what the catalog has.                                           |
| `required` | `boolean` | False: from a migration tagged above the base of the installed major, `X.0.0`.                          |

- **Types** are compared as the catalog reports them: MySQL and MariaDB `COLUMN_TYPE` without the display widths of
  the integers (MariaDB stores JSON as `longtext`), PostgreSQL `format_type`, such as `timestamp(3) with time zone`.
- **Collations** are compared where a migration sets one (`ascii_bin`, `COLLATE "C"`). A wrong collation is a
  `wrong_type`: `expected` and `found` end with ` collate <name>`.
- **Indexes**, primary keys included, are compared by name: their columns in order, uniqueness, and on PostgreSQL the
  predicate of a partial index. On PostgreSQL, an index that a failed concurrent build left invalid is a `wrong_index`,
  and `found` ends with ` invalid`.

It only reads, never throws on a mismatch, and looks only in the current schema.

### At boot and in a readiness probe

sqlane runs neither read by itself: `start()`, `enqueue()` and `schema.migrate()` never call them. The two can disagree,
for example after records written by hand, an index built beforehand, or a cut run. Check both, before `start()` or in
a readiness probe, and the same in a process that only enqueues:

```js
const [status, schema] = await Promise.all([
    sqlane.schema.getMigrationStatus(),
    sqlane.schema.findSchemaProblems(),
]);

if (!status.ok || !schema.ok) {
    throw new Error(`sqlane: the schema is not ready: ${JSON.stringify({ status, schema })}`);
}

await runner.start();
```

## `lanes.stats`

`lanes.stats` returns counts of jobs per lane, for monitoring and alerts.

```ts
sqlane.lanes.stats(): Promise<LaneStats[]>
```

The list has one entry for each lane that has jobs in any status, and for each
[globally paused](#lanespauseglobally-and-resumeglobally) lane, sorted by name: every lane in the database, also the
lanes that no runner handles.

| Field            | Type             | Description                                                                                               |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `name`           | `string`         | The name of the lane.                                                                                     |
| `pending`        | `number`         | The jobs that wait to run, including the ones that are not due yet. It does not count the blocked jobs.   |
| `blocked`        | `number`         | The jobs blocked on a key of a global limit: a full key, or a rate key without quota.                     |
| `due`            | `number`         | The pending jobs that are due now.                                                                        |
| `running`        | `number`         | The jobs that run now.                                                                                    |
| `stuck`          | `number`         | The running jobs that have timed out but whose handler has not settled yet.                               |
| `failed`         | `number`         | The failed jobs that sqlane still keeps.                                                                  |
| `completed`      | `number`         | The completed jobs that sqlane still keeps.                                                               |
| `oldestDueAgeMs` | `number \| null` | How long the oldest due pending job has waited, in milliseconds. It is `null` when no pending job is due. |
| `pausedGlobally` | `boolean`        | [`lanes.pauseGlobally`](#lanespauseglobally-and-resumeglobally) paused it: no process claims its jobs.    |

`pending` and `blocked` never count the same job, and `due` is a part of `pending`. A job held back by a local rate
limit stays pending and due. `oldestDueAgeMs` ignores the blocked jobs: [`keyStats`](#key-stats) shows how long they
wait. `failed` and `completed` count the rows until cleanup deletes them, which can be later than their retention. A
growing `oldestDueAgeMs` usually means that no process runs the lane, or that the workers cannot keep up. A paused
lane's `due` and `oldestDueAgeMs` grow too: skip `pausedGlobally` in such an alert. A growing `blocked` can mean that a
rate limit is below the rate of the enqueues, or that a key is held too long.

It is two statements, without locks, on the queue's pool (the counts, and the paused lanes), and it works before
`start()` and after `close()`. On every dialect it reads every row that sqlane keeps, so its cost grows with the
throughput times the retentions: mind the interval of your metric scrape. On a schema without the migration
`0010_pause`, it rejects with a `ConfigError`.

## `lanes.groupStats`

`lanes.groupStats` returns the [fair groups](#fair-groups) of one lane that have unfinished jobs, worst first: for
alerts such as "a tenant has waited too long", and to see who holds the backlog.

```ts
sqlane.lanes.groupStats(lane: LaneDefinition | string, options?: GroupStatsOptions): Promise<GroupStatsPage>
```

| Option    | Type                       | Default       | Description                                                                         |
| --------- | -------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `limit`   | integer                    | `100`         | The most groups of the page: 1 to 1000.                                             |
| `orderBy` | `'oldestDue'`, `'pending'` | `'oldestDue'` | By `oldestDueAgeMs` descending, the groups without a due job last; or by `pending`. |

It resolves to `{ groups, truncated }`: at most `limit` groups, and `truncated` when more matched. There is no cursor:
it is a view of the worst groups, as [`keyStats`](#key-stats). Ties go by the group in byte order, the jobs without a
group last.

| Field            | Type             | Description                                                                           |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `fairGroup`      | `string \| null` | The group; `null`: the jobs without one.                                              |
| `pending`        | `number`         | Its pending jobs, due or not. It does not count the blocked jobs.                     |
| `due`            | `number`         | Its pending jobs that are due now.                                                    |
| `blocked`        | `number`         | Its jobs blocked on a key of a global limit (jobs that brought global limits).        |
| `running`        | `number`         | Its jobs that run now, in the whole cluster.                                          |
| `oldestDueAgeMs` | `number \| null` | How long its oldest due pending job has waited, in milliseconds. `null`: none is due. |

A group is listed while it has a pending, blocked or running job. A lane without groups gives one entry, `null`. A
globally paused lane's `oldestDueAgeMs` keeps growing: check `lanes.stats()` `pausedGlobally` in such an alert. It is
one statement, without locks, on the queue's pool, and reads the unfinished rows of the lane: mind the interval of your
metric scrape. It rejects with an `InvalidOptionsError` for a bad lane or option, and with a `ConfigError` on a schema
without the migration `0011_fair_groups`.

## `jobs`

`sqlane.jobs` acts on the jobs in the database. It reads them, one job by its id or the jobs of a lane a page at a time,
it retries, cancels and removes them in bulk, and it shows the keys of the global limits. It is a frozen object of the
instance. The counts per lane are [`lanes.stats`](#lanesstats).

```ts
sqlane.jobs.get<P = any>(jobId: string): Promise<JobRecord<P> | null>
sqlane.jobs.list<J extends LaneDefinition | string>(filter: JobFilter<J>, options?: ListJobsOptions): Promise<JobPage<HandlerPayload<J>>>
sqlane.jobs.retry(selector: JobSelector, options?: RetryOptions<C>): Promise<BulkResult>
sqlane.jobs.cancel(selector: JobSelector, options?: BulkOptions<C>): Promise<BulkResult>
sqlane.jobs.remove(selector: JobSelector, options?: BulkOptions<C>): Promise<BulkResult>
sqlane.jobs.keyStats(options?: KeyStatsOptions): Promise<KeyStatsPage>
```

The bulk methods are described in [Retry, cancel and remove](#retry-cancel-and-remove), and `keyStats` in
[Key stats](#key-stats). The rest of this section is about the reads.

- The reads are plain reads on the queue's pool, without locks. They never take a connection of your app.
- They work without a runner, before `runner.start()` and after `close()`: any valid lane may be read, by definition or
  by name.
- They require the migration `0008_job_list`. Without it, their behavior is not specified: `list` rejects on MySQL and
  MariaDB. Before `schema.migrate()`, or when the database fails, they reject with the error of the driver.
- A known field of the filter or the options that is `undefined` counts as absent. An unknown field rejects, also when
  its value is `undefined`.

### `jobs.get`

`jobs.get` reads one job, with its payload.

The `jobId` is the full id, as `enqueue` returns it and as the events carry it: `<lane>:<dedupeKey>`,
`<lane>:schedule:[<key>:]<ISO time>`, or a ULID. `get` resolves to `null` when no job has this id: it was never
added, or cleanup deleted it. A string that cannot be a job id also resolves to `null`, on every database, without a
query: an empty string, more than 255 characters, a character outside printable ASCII, or a space at an end. `get`
rejects with an `InvalidOptionsError` only when `jobId` is not a string.

`P` names the type of the payload. sqlane does not check it.

### `jobs.list`

`jobs.list` lists the jobs of one lane, newest first, a page at a time.

| Filter   | Type                                  | Default      | Description                                         |
| -------- | ------------------------------------- | ------------ | --------------------------------------------------- |
| `lane`   | `string` or `LaneDefinition`          | Required     | A lane definition or the name of a lane.            |
| `status` | `JobStatus` or `readonly JobStatus[]` | All statuses | One status, or a non-empty list without duplicates. |

| Option           | Type               | Default | Description                                                              |
| ---------------- | ------------------ | ------- | ------------------------------------------------------------------------ |
| `limit`          | `number`           | `100`   | The most jobs of a page: an integer from 1 to 1000.                      |
| `cursor`         | `string` or `null` | None    | The `nextCursor` of the previous page. `null` or absent: the first page. |
| `includePayload` | `boolean`          | `false` | When it is `true`, each job has its payload.                             |

`list` resolves to a `JobPage`:

| Field        | Type               | Description                                           |
| ------------ | ------------------ | ----------------------------------------------------- |
| `jobs`       | `JobRecord<P>[]`   | At most `limit` jobs, newest first.                   |
| `nextCursor` | `string` or `null` | The cursor of the next page. `null` on the last page. |

With a definition as `lane`, the jobs get the payload type of the definition, as the handler does. With a name, the
payload is `any`.

**Order and pages.**

- The jobs come by `enqueuedAt`, newest first, then by id, descending, in ASCII byte order. The order is total, and a
  job never moves in it: neither its enqueue time nor its id changes.
- `nextCursor` continues after the last job of its page. The pages list each row at most once, and a job that exists
  and matches the filter for the whole paging exactly once. A page may be empty, and a page with a `nextCursor` may be
  followed by an empty last page.
- A job becomes visible when its transaction commits, but `enqueuedAt` is the time of its insert. A job that commits
  after a page was read is listed by the later pages if its `enqueuedAt` comes after the cursor in the order, and
  missed if it comes before. A job enqueued again with the same `dedupeKey` after its deletion is a new row, newer than the
  old one: the later pages do not list it.
- Each page filters by the status of a job when the page is read. A job that changes status between pages is listed by
  the page that reaches its place, if its status matches then.

**Cursors.**

- A cursor is opaque and bound to its filter, the lane and the set of statuses: a cursor used with another filter
  rejects. `status: 'failed'` and `status: ['failed']` are the same filter, and the order of a list does not matter. An
  absent `status` and a list of every status are different filters: absent means every status, also those of a later
  major.
- `limit` and `includePayload` may change between pages.
- A cursor is not bound to an instance, a process or a version within a major: any instance with the same table prefix
  can continue it, also an older one during a rolling deploy.
- A cursor is not a security token. sqlane rejects a malformed cursor, not a well-formed one that someone built.

`list` rejects with an `InvalidOptionsError` for a filter or options that are not objects or have an unknown field, a
`lane` that is neither a definition nor a valid lane name, an unknown status, an empty list or a list with
duplicates, a `limit` that is not an integer from 1 to 1000, an `includePayload` that is not a boolean, a malformed
cursor, and a cursor of another filter.

```js
let cursor = null;

do {
    const page = await sqlane.jobs.list({ lane: buildReport, status: 'failed' }, { cursor });

    for (const job of page.jobs) {
        console.log(job.id, job.attempts, job.lastError?.message);
    }

    cursor = page.nextCursor;
} while (cursor);
```

### `JobRecord`

A `JobRecord` is a job as the database has it. Every field is always present, except `payload`.

| Field                     | Type                                                                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | `string`                                                                  | The full job id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lane`                    | `string`                                                                  | The lane.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `status`                  | `JobStatus`                                                               | `'pending'`, `'blocked'`, `'running'`, `'completed'` or `'failed'`, when read. `pending` does not include `blocked`, as in `lanes.stats()`.                                                                                                                                                                                                                                                                                                                                                         |
| `attempts`                | `number`                                                                  | The finished attempts: each completion, retry or failure adds one, whatever the error. A stall, a release and a wait on a rate limit add none, nor does the claim that fails a job past its `maxStalls`: such a job has `attempts` below its last `FailedJobPayload.job.attempt`. A `reset` retry sets it to 0.                                                                                                                                                                                     |
| `maxAttempts`             | `number`                                                                  | The most attempts of the job, set at enqueue; a `one_more` retry changes it.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `stalls`                  | `number`                                                                  | The times its lease ended while it ran. A `reset` retry sets it to 0.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `maxStalls`               | `number`                                                                  | The stalls that it survives, set at enqueue; a `one_more` retry changes it.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `runAt`                   | `Date`                                                                    | When the job is due, or was. A pending job runs from then. A blocked job has been in line since then and runs when its key frees; after a `RateLimitedError` on a global rate key, it keeps the due time of the run that was rate limited. A running or finished job: the due time of its last run. `drain({ includeDelayed })` sets it to now for the pending jobs not due yet of the lanes that it runs; `jobs.retry` sets it as a rerun does. A cancelled job that never ran keeps its due time. |
| `enqueuedAt`              | `Date`                                                                    | The time of the insert, not of the commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `startedAt`               | `Date` or `null`                                                          | The start of its last run, an attempt or not. `null`: it never ran.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `finishedAt`              | `Date` or `null`                                                          | When it completed or failed for good. `null` otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `expiresAt`               | `Date` or `null`                                                          | From when cleanup may delete the finished job. A row can still be read after it. `null` for an unfinished job.                                                                                                                                                                                                                                                                                                                                                                                      |
| `scheduledAt`             | `Date` or `null`                                                          | The slot of a job of a [schedule](#schedules), from its id. `null` for other jobs.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `stuck`                   | `boolean`                                                                 | Running and timed out, by the last state written. Its handler may still run, or its process may be gone; stall recovery settles the latter.                                                                                                                                                                                                                                                                                                                                                         |
| `lastError`               | `JobError` or `null`                                                      | The last error written to the job, kept when it later completes: of a failed attempt, of a stall (`StalledError`), of a `RateLimitedError` on a global rate key of the job, or of `jobs.cancel` (`JobCancelledError`). Not by a block when it is claimed, nor by a wait on a local rate limit.                                                                                                                                                                                                      |
| `globalConcurrencyLimits` | `readonly { key, max }[]`                                                 | Its keys, sorted, with their maxes, as in `JobInfo`. `key` is the full key: `<limit>` or `<limit>:<value>`.                                                                                                                                                                                                                                                                                                                                                                                         |
| `globalRateLimits`        | `readonly { limit, key, max, per, burst, cost }[]`                        | Its rate limits: the limit name and its key value, `null` for the limit itself, as in the `rate_limited` event. `per` is in milliseconds. Sorted by the full rate key, in byte order.                                                                                                                                                                                                                                                                                                               |
| `blockedOn`               | `{ type: 'concurrency', key }`, `{ type: 'rate', limit, key }`, or `null` | What a blocked job waits for: a concurrency key, the full key, or a rate limit and its key value. `null` when the job is not blocked. Its `type` may gain members in a minor: a `switch` needs a `default`.                                                                                                                                                                                                                                                                                         |
| `payload`                 | `P`, optional                                                             | As JSON gives it back. A JSON `null` payload is present, as `null`. Absent when not asked for, or when the database holds no payload for the job: after its completion, briefly while its enqueue writes it, or after a failure with `MissingPayloadError`.                                                                                                                                                                                                                                         |

A `JobError` is `{ name: string, message: string, stack?: string, code?: string }`: `name` as a string, not always an
exported class; `stack` cut to 8,192 UTF-16 code units; `code` the string `code` of the thrown error.

**Times.** `runAt` comes from your app when the job was enqueued with the `runAt` option, until its first rerun (a
retry, a release or a stall) or a `drain({ includeDelayed })`; otherwise from the database clock. On PostgreSQL, a
`runAt` from the clock is truncated to the millisecond, so an immediate job may have a `runAt` up to 1 ms before its
`enqueuedAt`. `scheduledAt` comes from the id. The other times come from the database clock, to the millisecond.
PostgreSQL rounds them to the millisecond, so a time is within 0.5 ms of the clock.

`JobStatus` gains members only in a major. A cancelled job is `failed`.

The types `SqlaneJobs`, `JobRecord`, `JobStatus`, `JobError`, `JobFilter`, `ListJobsOptions`, `JobPage` and
`HandlerPayload` are exported from `@sqlane/core`.

## Retry, cancel and remove

`sqlane.jobs.retry`, `jobs.cancel` and `jobs.remove` change jobs in bulk: a list of job ids, or the jobs of a filter.
They work without a runner, before `runner.start()` and after `close()`; a filter takes a lane definition or a name.

| Method   | Changes jobs in                             | Default of a filter | Effect                                                                                                                                                 |
| -------- | ------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `retry`  | `failed`                                    | `failed`            | The job is pending again, with the same id, enqueue time, keys and failure job. A job without a payload is not retried.                                |
| `cancel` | `pending`, `blocked`                        | both                | The job fails at once, with a `JobCancelledError` as `lastError`, `finishedAt` now and `expiresAt` from its failed retention. No failure job is added. |
| `remove` | `pending`, `blocked`, `completed`, `failed` | all four            | The job and its payload are deleted. Its dedupe key is free again.                                                                                     |

A running job is never changed. Its id is ignored with the reason `status`, and `running` in a filter rejects.

### The selector

```ts
type JobSelector =
    | { jobIds: readonly string[], lane?: undefined, status?: undefined }
    | (JobFilter & { jobIds?: undefined });
```

- `jobIds`: 1 to 1000 distinct full job ids; duplicates count once. A string that cannot be a job id is ignored as
  `not_found`, as `jobs.get` returns `null` for it.
- A filter, `{ lane, status? }`, as `jobs.list` takes it. `status` names only statuses that the method changes:
  another one rejects. Without `status`: the default of the method.
- Both kinds, or neither, reject.

### Options

| Option                  | Type                      | Default    | Description                                                                                                                                                  |
| ----------------------- | ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connection`            | `C`                       | None       | Atomic only. A connection or a client in a transaction: the call runs in it. A pool: a transaction of sqlane's own on it. See [Transactions](#transactions). |
| `mode`                  | `'atomic'` or `'batches'` | `'atomic'` | `'atomic'`: one transaction. `'batches'`: short transactions of up to 1000 jobs, for a large filter.                                                         |
| `strict`                | `boolean`                 | `false`    | Atomic, with `jobIds` only: if any id would be ignored, the call rejects with an `IgnoredJobsError` and changes nothing.                                     |
| `includeAffectedJobIds` | `boolean`                 | `false`    | The result lists the ids of the changed jobs.                                                                                                                |
| `budget`                | `'reset'` or `'one_more'` | `'reset'`  | `retry` only. `'reset'`: `attempts` and `stalls` back to 0. `'one_more'`: the job gets exactly one more attempt.                                             |

An option set to `undefined` counts as absent. `jobIds`, a defined `connection` and `strict: true` reject with
`'batches'`, and `strict: true` rejects with a filter: a filter reports no ignored job (a `retry` filter skips the
jobs without a payload, and `affectedCount` leaves them out).

### The result

```ts
interface BulkResult {
    affectedCount: number;
    affectedJobIds?: string[]; // with includeAffectedJobIds; in no order
    ignoredJobs: { jobId: string, reason: 'not_found' | 'status' | 'no_payload', status?: JobStatus }[];
}
```

`ignoredJobs` has one entry per distinct id that the call did not change, in the order of their first appearance, with
the status of the job for `status` and `no_payload`. A job that left an accepted status and came back to it during the
call is reported with `status` and that status. It is empty for a filter. New reasons may come in a minor version:
handle unknown ones.

### `jobs.retry`

- The job is due now, or at the end of the lingering slots of its earlier runs, so that it does not start beside a
  handler that may still run after a stall or a release on close. On PostgreSQL, `runAt` is truncated to the
  millisecond. A handler that ignored its abort may still run beyond that.
- What changes: `status`, `runAt`, `attempts` and `stalls` (`reset`), the maxes (`one_more`), `finishedAt`,
  `expiresAt` and `blockedOn` (`null`). What stays: the id, `enqueuedAt`, `startedAt`, `lastError` until the next error,
  the keys, the failure job and the payload. The order of `jobs.list` holds.
- `one_more`: `maxAttempts` becomes `attempts + 1`, and `maxStalls` becomes `max(maxStalls, stalls)`. So a job that its
  stalls failed fails at the claim after its next stall, and another keeps its stall tolerance. The new maxes are stored in the job: a
  later `reset` restores these, not the ones of the enqueue. A job that never finished an attempt gets `maxAttempts` 1.
- `FailedJobPayload.job.attempt` restarts from 1 after a `reset`. The failure job that the job added when it failed
  stays; if the retried job fails again, it adds another.
- A completed job is not retried today: its payload is deleted at the completion. Its id is ignored with `status`, and
  `completed` in a filter rejects.

### `jobs.cancel`

- The job's `lastError` is `{ name: 'JobCancelledError', message: 'Cancelled by jobs.cancel()', code: 'JOB_CANCELLED' }`,
  and `blockedOn` becomes `null`. `attempts` does not change, and the payload is kept, as for any failed job.
- A cancelled job is `failed`: `lanes.stats()` counts it in `failed`, and a `retry` of the failed jobs retries it. `drain()`
  does not count cancels.
- `JobCancelledError` is exported. A handler that throws it throws an ordinary error. So `lastError` alone does not
  mark a cancel.

### `jobs.remove`

- The row and its payload are deleted. A later `enqueue` with the same dedupe key adds a new job.

### Slots, keys and schedules

- None of the methods touch the slots of global limits. A slot that lingers after a stall or a release on close stays
  until its time, because the old handler may still run.
- When a cancel or a remove changes pending jobs, sqlane unblocks the concurrency keys of those jobs, as when a job of
  the key ends, so the jobs blocked behind them do not wait for the next sweep: after the commit of sqlane's own
  transaction; with your connection, at the adapter's after-commit hook, else right after the call. A failure of that
  unblock is an `error` event (operation `unblock`), never a rejection of the call. A rate key may start its next job a
  little later than it could, until its next start.
- `overlap: 'skip'` skips while the last job of a schedule is pending or running. So removing or cancelling it lets the
  next slot run, and retrying it makes the skip apply again. A slot never adds a job again; after a remove,
  `schedules.runSlot` adds a new job. Retrying an older job of a schedule may overlap a new slot. The skip ignores a
  blocked last job, so cancelling one changes nothing for the skip.

### Transactions

- **Without `connection`**: a transaction of sqlane's own on the queue's pool, at READ COMMITTED. All the selected jobs
  change, or none does when the call rejects. A deadlock is retried, up to 3 times.
- **A pool as `connection`**: the same, on that pool. Prisma limits sqlane's own transaction to 60 s.
- **A connection or a client in a transaction**: the call runs in it, as `enqueue` does, and its owner commits. When
  the call rejects, roll the transaction back: on MySQL and MariaDB, a part of the call may be in it. Outside a
  transaction, the call is neither atomic nor strict, and `affectedJobIds` may list a job that changed meanwhile; a
  running job is still never changed. In a REPEATABLE READ or SERIALIZABLE transaction, the call reads your snapshot,
  so a job changed after it may be reported `not_found` or `status`, and it may reject with a serialization error. On
  MySQL and MariaDB, it may hold gap locks, and the locks of running jobs among the ids, until the commit: their
  workers then miss lease renewals. Prisma limits your transaction to its own timeout (5 s by default).
- Each job's status is checked under its row lock, and each write checks it again. The jobs are locked in id order. A
  large atomic filter holds the locks of all its jobs until the commit.
- **`batches`**: each batch is a transaction of its own, in the order of `jobs.list`, so each job is considered at most
  once and the call always ends. A call that rejects may have committed some batches, whose count is lost: run it
  again to finish. It needs the migration `0008_job_list`.
- A database error rejects with the driver's error. An atomic call that sqlane owns then changed nothing, unless the
  error came at the commit itself (a lost connection): then the outcome is unknown, and running the call again without
  `strict` finishes it; a retried job that failed again in between is retried again.

### Events and wakes

- `cancelled`, for each cancelled job, after the commit of a transaction that sqlane owns (without `connection`, or
  with a pool). Not in your transaction: sqlane cannot know for sure that you committed.
- A retried job wakes the runners as an enqueued one does: this process at once, the others by the hint (not after
  `sqlane.close()`, which stops publishing hints; with the `notify` option, the NOTIFY is part of the transaction), and
  by their next poll.
- `retry` and `remove` emit no event.

The types `JobSelector`, `BulkOptions`, `RetryOptions` and `BulkResult` are exported from `@sqlane/core`.

## Key stats

`jobs.keyStats` lists the keys of the global limits that have blocked jobs, or held or lingering slots, worst first. It
answers two alerts: a blocked chain (jobs that wait on a key for too long), and a key held too long.

```ts
sqlane.jobs.keyStats(options?: KeyStatsOptions): Promise<KeyStatsPage>
```

| Option    | Type                        | Default     | Description                                                                                    |
| --------- | --------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `limit`   | integer                     | `100`       | The most keys of the page: 1 to 1000.                                                          |
| `type`    | `'concurrency'` or `'rate'` | All types   | Only the keys of this type.                                                                    |
| `orderBy` | `'blocked'` or `'held'`     | `'blocked'` | The order of the keys (below). `'held'` rejects with `type: 'rate'`: a rate key holds no slot. |

It resolves to `{ keys, truncated }`: at most `limit` keys, and `truncated` when more keys matched. There is no cursor:
it is a view of the worst keys, not a full list.

A key of the page is one of two types. `type` may gain members in a minor, for example for the keys of a later feature:
a `switch` on it needs a `default`.

| Field (`type: 'concurrency'`) | Type             | Description                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                         | `string`         | The full key, as in `JobRecord.globalConcurrencyLimits`.                                                                                                                                                                                                                                                                                                 |
| `max`                         | `number \| null` | The max of the oldest blocked job, which the unblock uses; else the max of the job of the newest slot (by the time it was taken, then job id). `null` when neither exists, or when that job no longer carries the key (a lingering slot's job may be gone, and its id reused). Jobs of one key may carry different maxes after a deploy that changed it. |
| `held`                        | `number`         | The slots of runs: also of a run whose process died, until stall recovery frees or lingers it, and orphan slots, until the recovery sweep deletes them.                                                                                                                                                                                                  |
| `lingering`                   | `number`         | The slots that linger after a stall or a release on close, and whose linger has not ended. An ended linger counts nowhere.                                                                                                                                                                                                                               |
| `blocked`                     | `number`         | The jobs blocked on the key, up to 1000.                                                                                                                                                                                                                                                                                                                 |
| `blockedTruncated`            | `boolean`        | More than 1000 jobs are blocked on the key.                                                                                                                                                                                                                                                                                                              |
| `oldestBlockedAgeMs`          | `number \| null` | `now − runAt` of the oldest blocked job. `null`: no job is blocked.                                                                                                                                                                                                                                                                                      |
| `oldestHeldAgeMs`             | `number \| null` | The age of the oldest held or lingering slot, from the time it was taken: for a held slot, the `startedAt` of its run (the claim writes both from one time). `null`: no slot.                                                                                                                                                                            |

| Field (`type: 'rate'`) | Type                       | Description                                                                                                  |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `limit`, `key`         | `string`, `string \| null` | The rate limit, and its key value (`null` for the limit itself), as in `JobRecord.globalRateLimits`.         |
| `blocked`              | `number`                   | The jobs blocked on the key, up to 1000.                                                                     |
| `blockedTruncated`     | `boolean`                  | More than 1000 jobs are blocked on the key.                                                                  |
| `oldestBlockedAgeMs`   | `number`                   | `now − runAt` of the oldest blocked job.                                                                     |
| `nextStartInMs`        | `number`                   | When the oldest blocked job may start, by its own settings and the debt of the key: 0 when it may start now. |

**Which keys.** A concurrency key is listed while it has a blocked job, or a held or lingering slot. A rate key is listed
only while jobs are blocked on it: its settings live in each job, so a key without a blocked job has none to compute a
next start from.

**Order.** `orderBy: 'blocked'` orders by `oldestBlockedAgeMs` descending, nulls last: for a blocked chain.
`orderBy: 'held'` has three tiers: the concurrency keys with held or lingering slots, by `oldestHeldAgeMs` descending;
then the other concurrency keys, by `oldestBlockedAgeMs` descending; then the rate keys, and any later type, by
`oldestBlockedAgeMs` descending: for a key held too long. Ties go by the stored key in byte order, `@<limit>[:<key>]`
for a rate key.

**Times.** All the ages come from one database time, at the start of the statement, in integer milliseconds (±1 between
databases).

**Alerts.**

- A blocked chain: a key whose `oldestBlockedAgeMs` grows.
- A key held too long: a key whose `oldestHeldAgeMs` grows, with `orderBy: 'held'`; `lingering` slots point to a
  stalled or released run.
- A missed unblock: free room (`max − held − lingering > 0`) on a key with blocked jobs, for longer than the recovery
  interval (30 s) plus a margin, while the lanes of the key have no due pending jobs (`lanes.stats()` gives `oldestDueAgeMs` null
  or small). Shorter, it is normal (an ended linger, a race), and the recovery sweep repairs it. With due pending jobs,
  it means that no worker claims them.
- A missed timer of a rate key: blocked jobs with `nextStartInMs` 0 for longer than the recovery interval plus a margin,
  on the same condition. The sweep repairs it too.

**What it does not show.**

- The due jobs that no claim has seen yet: a job becomes blocked only when a claim finds its key full, so a lane that no
  process runs shows nothing here. See `oldestDueAgeMs` in `lanes.stats()`.
- A job that waits on several keys counts only on the key it is blocked on.
- The local limits, and the timers and floors that each process keeps in memory.

**Cost.** Ranking the keys reads the head of each blocked key and the slot rows: its cost grows with the number of
distinct blocked keys, whatever `limit` is. The details read at most about `limit × 2001` index entries (the probe of the cap and the count), plus a few lookups per key (its head job, the job of its newest slot, its rate row). Poll it at the pace of
an alert, not of every metrics scrape.

`keyStats` is one plain read on the queue's pool, without locks. It works before `start()` and after `close()`, and
needs the migrations up to `0007_rate_limits`. It rejects with an `InvalidOptionsError` for an unknown option (also set
to `undefined`), or a bad `limit`, `type` or `orderBy`; a known option set to `undefined` counts as absent. The types
`KeyStats`, `KeyStatsOptions` and `KeyStatsPage` are exported from `@sqlane/core`.

## Errors

All the errors of sqlane extend `SqlaneError`. Each error has a stable `code` that you can check. All the classes are
exported from `@sqlane/core`.

| Class                          | `code`                      | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigError`                  | `CONFIG`                    | The options of `createSqlane`, `createRunner`, `defineLane`, `defineHandler`, `defineSchedule`, `runner.mount()` or an adapter are bad (see [`runner.mount`](#runnermount)). `runner.start()` throws it for a missing table of the schedules; with `schema.migrate()`, for a wrong server. `schema.rollback()` and `schema.drop()` throw it while the runner is started or draining, or when a migration unknown to this version is recorded; `schema.drop()`, for tables that sqlane did not create. |
| `InvalidOptionsError`          | `INVALID_OPTIONS`           | The arguments of `enqueue`, `enqueueMany`, `schedules.runSlot`, a method of `sqlane.jobs` or of `sqlane.schema` are bad, for example a lane that is not a definition, a bad `dedupeKey`, a `dedupeKey` with the reserved prefix `schedule:`, the `jobId` of 7.x, `delay` with `runAt`, a payload that is not JSON, a slot off the spec, or a `targetVersion` out of range.                                                                                                                            |
| `PayloadTooLargeError`         | `PAYLOAD_TOO_LARGE`         | The payload is larger than `maxPayloadBytes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `InvalidConcurrencyLimitError` | `INVALID_CONCURRENCY_LIMIT` | A job has more than 10 global keys, a key breaks the rules, a key has two maxes, or a global limit is not from `defineConcurrencyLimit`.                                                                                                                                                                                                                                                                                                                                                              |
| `InvalidRateLimitError`        | `INVALID_RATE_LIMIT`        | A job has more than 10 global keys of concurrency and rate limits together, a rate key breaks the rules, a rate key has two settings, or a global rate limit is not from `defineRateLimit`. `limit.key()` or `limit.cost()` got a bad value or cost, or `new RateLimitedError()` got bad options.                                                                                                                                                                                                     |
| `ClosedError`                  | `CLOSED`                    | `runner.start`, `runner.mount`, `runner.drain` was called after `close()`; `createRunner`, `schema.migrate`, `schema.rollback` or `schema.drop` after `sqlane.close()`.                                                                                                                                                                                                                                                                                                                               |
| `DrainTimeoutError`            | `DRAIN_TIMEOUT`             | `drain()` did not finish within its `timeout`.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `JobTimeoutError`              | `JOB_TIMEOUT`               | The handler's `signal` aborted because the timeout passed. It is also the error of the attempt.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ShutdownError`                | `SHUTDOWN`                  | The handler's `signal` aborted because `close()` reached its deadline.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `LeaseLostError`               | `LEASE_LOST`                | The handler's `signal` aborted because the process could not renew the lease until 30 s before it ends, for example because the database is unreachable.                                                                                                                                                                                                                                                                                                                                              |
| `MissingPayloadError`          | `MISSING_PAYLOAD`           | sqlane did not find the payload of a job. The job fails for good with this error.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MigrationLockTimeoutError`    | `MIGRATION_LOCK_TIMEOUT`    | `schema.migrate()`, `schema.rollback()` or `schema.drop()` did not get the migration lock within its `lockTimeout`; for `schema.rollback()` and `schema.drop()`, also the lock of a table.                                                                                                                                                                                                                                                                                                            |
| `IgnoredJobsError`             | `IGNORED_JOBS`              | A bulk method of `sqlane.jobs` with `strict: true` would have ignored some of its ids: it changed nothing. `ignoredJobs` lists them.                                                                                                                                                                                                                                                                                                                                                                  |
| `JobCancelledError`            | `JOB_CANCELLED`             | The `lastError` of a job that `jobs.cancel` cancelled. `new JobCancelledError(message?, options?)`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `FatalJobError`                | `FATAL_JOB`                 | A handler threw it to fail the job at once. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `RetryJobError`                | `RETRY_JOB`                 | A handler threw it to retry the job after a given delay. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `RateLimitedError`             | `RATE_LIMITED`              | A handler threw it because the other side limits the rate: the job waits for its rate limit. See below.                                                                                                                                                                                                                                                                                                                                                                                               |

```js
import { SqlaneError } from '@sqlane/core';

try {
    await sqlane.enqueue(connection, buildReport, payload);
} catch (error) {
    if (error instanceof SqlaneError && error.code === 'PAYLOAD_TOO_LARGE') {
        // ...
    }
    throw error;
}
```

### Errors that handlers throw

A handler can throw three special errors to control what happens next.

`FatalJobError` fails the job at once, without retries. If the job has a failure job, sqlane adds it.

```ts
new FatalJobError(message: string, options?: { cause?: unknown })
```

`RetryJobError` retries the job after `delay`, instead of after the backoff. The retry still uses an attempt, so the
job fails for good if no attempts are left. If `delay` is not a valid duration, sqlane uses the backoff. For an answer
such as HTTP 429, a `RateLimitedError` on a rate limit of the job uses no attempt.

```ts
new RetryJobError(message: string, options: { delay: Duration, cause?: unknown })
```

```js
import { FatalJobError, RetryJobError } from '@sqlane/core';

defineHandler(buildReport, async ({ payload, signal }) => {
    const response = await fetch(`https://reports.example.com/${payload.reportId}`, { signal });

    if (response.status === 404) {
        throw new FatalJobError(`Report ${payload.reportId} does not exist`);
    }

    if (response.status === 503) {
        throw new RetryJobError('Reports are down', { delay: '1m' });
    }
});
```

`RateLimitedError` tells sqlane that the other side limits the rate, for example with an HTTP 429. The job waits
without using an attempt, and so do the other jobs of the rate limit.

```ts
new RateLimitedError(options: { limit?: RateLimit | RateLimitKey, retryAfter: Duration, cause?: unknown })
```

`retryAfter` is a duration from 0 to 7 days. `limit` is a [rate limit](#defineratelimit) of the job, or one of its
keys, as the definition returns it: `perToken.key(id)` for a job with that key, not `perToken`. The constructor throws
an `InvalidRateLimitError` for bad options.

| `limit`                                                    | What happens                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A global rate key of the job                               | The key starts nothing for `retryAfter`, in the whole cluster. Its next start is at `retryAfter` from now, then one per `per / max`. The job is blocked on the key, without using an attempt, and its concurrency slots are freed. Newer jobs of the key wait behind it. |
| A local rate limit of the job                              | The limit starts nothing in this process for `retryAfter`. The job is pending again at once, without using an attempt, so another process may run it now.                                                                                                                |
| Not given                                                  | All the rate limits of the job, global and local, as above.                                                                                                                                                                                                              |
| Not a rate limit of the job, or the job has no rate limits | The job is retried after `retryAfter`, as with a `RetryJobError`: it uses an attempt, and sqlane emits `retried`.                                                                                                                                                        |

A pause only extends the wait of a key: a shorter `retryAfter` never brings its next start closer. sqlane emits a
`rate_limited` event for each wait. There is no cap: a job that always gets a 429 waits again and again, and never
fails.

```js
import { RateLimitedError } from '@sqlane/core';

defineHandler(syncRepo, async ({ payload, signal }) => {
    const response = await fetch(`https://api.github.com/repos/${payload.repo}`, { signal });

    if (response.status === 429) {
        // Retry-After in seconds
        const seconds = Number(response.headers.get('retry-after')) || 60;

        throw new RateLimitedError({ limit: perToken.key(payload.tokenId), retryAfter: `${seconds}s` });
    }
});
```

If a handler throws a value that is not an `Error`, sqlane records it as an error with the name `Error` and the value
as a string.

## Events

The `onEvent` option of `createSqlane` receives an event object for each step of the job lifecycle: those of the runner
of the sqlane, and those of the sqlane itself (`cancelled`, `error`), with or without a runner. Use the events to feed
your metrics. The `type` field tells the kind of event.

Every event except `error` and `schedule_fired` has these fields:

| Field     | Type     | Description                                                                                                 |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `jobId`   | `string` | The job id.                                                                                                 |
| `lane`    | `string` | The lane.                                                                                                   |
| `attempt` | `number` | The attempt, starting at 1. When stall recovery emits the event, it is the attempt of the run that stalled. |

The events of a runner (all but `cancelled`) also have `fairGroup` (`string | null`): the job's
[fair group](#fair-groups), as `JobInfo` has it.

| `type`                  | Extra fields                                              | When                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimed`               | `runAt`, `enqueuedAt`, `startedAt`                        | This process claimed the job and starts its handler (a job past its `maxStalls`: it fails it, without a run). The fields are those of [`JobInfo`](#the-handler-context): the start delay is `startedAt − runAt`.                                                                                                                                      |
| `completed`             | `durationMs`                                              | The job completed.                                                                                                                                                                                                                                                                                                                                    |
| `retried`               | `durationMs`, `delayMs`, `error`                          | The attempt failed, and the job will run again after `delayMs`.                                                                                                                                                                                                                                                                                       |
| `failed`                | `durationMs`, `error`                                     | The job failed for good. A job past its `maxStalls` fails at its claim, without a run: `claimed`, then `failed` with a `StalledError` and a `durationMs` of 0.                                                                                                                                                                                        |
| `timed_out`             | `durationMs`                                              | The handler ran longer than its timeout, and its `signal` aborted.                                                                                                                                                                                                                                                                                    |
| `stalled`               | None                                                      | Stall recovery found a job whose lease had ended, and put it back in the queue.                                                                                                                                                                                                                                                                       |
| `released`              | None                                                      | `close()` released an unfinished job in `'release'` mode.                                                                                                                                                                                                                                                                                             |
| `lease_lost`            | None                                                      | This process could not renew the lease of the job until 30 s before it ends, and aborted its `signal`.                                                                                                                                                                                                                                                |
| `rate_limited`          | `durationMs`, `limit`, `key`, `scope`, `retryAt`, `error` | The handler threw a [`RateLimitedError`](#errors-that-handlers-throw) on a rate limit of the job. The job waits, without using an attempt, until about `retryAt`. `limit` is the name of the limit it waits on, `key` its key (`null` for a limit without keys, and for a local limit), `scope` `'global'` or `'local'`. `drain()` does not count it. |
| `failure_job_not_added` | `failureLane`, `error`                                    | The job failed for good, but the database refused to add its failure job.                                                                                                                                                                                                                                                                             |
| `cancelled`             | None                                                      | `jobs.cancel` cancelled the job, after the commit of a transaction of sqlane's own. `attempt` is the attempt that would have run next.                                                                                                                                                                                                                |
| `error`                 | `operation`, `error`                                      | An internal operation failed, for example a poll or a hint. `operation` names it. sqlane also logs it. A deadlock, serialization failure or `ER_CHECKREAD` (1020) of the dispatcher is retried at once, up to 3 times, before it is reported; a lock wait timeout is reported at once.                                                                |
| `schedule_fired`        | `scheduleId`, `lane`, `scheduledAt`, `late`, `jobId`      | A slot of a [schedule](#schedules) was decided. Only the process that decided it emits it, so the cluster gets one event per slot. `late` is true for a catch-up. `jobId` is `null` when `overlap: 'skip'` skipped the slot. It has no `attempt`. A slot of a globally paused schedule emits none.                                                    |

`durationMs` is the run time of the handler in milliseconds. `error` is the thrown value, of type `unknown`.

New event types may be added in minor versions. Handle unknown types in a `default` branch.

```js
const sqlane = createSqlane({
    adapter,
    onEvent: (event) => {
        if (event.type === 'failed') {
            metrics.increment('jobs.failed', { lane: event.lane });
        }
    },
});
```

## `FailedJobPayload`

`FailedJobPayload` is the type of the payload of a failure job.

```ts
interface FailedJobPayload {
    job: { id: string, lane: string, payload: any, attempt: number, maxAttempts: number };
    error: JobError; // { name: string, message: string, stack?: string, code?: string }
}
```

The `job` field describes the job that failed, with its original payload. Its `maxAttempts` is set at enqueue; a
`one_more` retry changes it. The `error` field describes the last error,
as a [`JobError`](#jobrecord). sqlane cuts `error.stack` to 8,192 UTF-16 code units. When the error has a string
`code` property, `error` also has a `code` field. The payload of a failure job is exempt from `maxPayloadBytes`.

The failure job is an ordinary job, so it gets its options from the definition of the failure lane. It never has a
failure job of its own.

```js
/** @type {import('@sqlane/core').LaneDefinition<import('@sqlane/core').FailedJobPayload>} */
export const reportFailed = defineLane({ name: 'report_failed' });

export const reportFailedHandler = defineHandler(reportFailed, async ({ payload }) => {
    await alert(`${payload.job.lane} ${payload.job.id} failed: ${payload.error.message}`);
});
```

## `Hint`

A `Hint` is a publish/subscribe service that tells other processes that new jobs are ready. You pass it as the `hint` option of
`createSqlane`.

```ts
interface Hint {
    publish(channel: string, message: string): Promise<void>;
    subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>>;
}
```

`subscribe` resolves to a function that ends the subscription. The channel is `<tablePrefix>ready`, and the message is
a lane, or `*` for all lanes. sqlane does not wait for `publish`. If `publish` fails, sqlane emits an `error` event,
and `enqueue` still succeeds.

Hints only make jobs start sooner. Without a hint, other processes find new jobs at their next poll. On PostgreSQL, the
`notify` option of some adapters gives the same result with LISTEN/NOTIFY, so you do not need a `hint` there. See
[Hints](design.md#hints) in the design for the details.

This example uses [ioredis](https://www.npmjs.com/package/ioredis). A subscribed Redis connection cannot send other
commands, so it uses two connections.

```js
import Redis from 'ioredis';

const publisher = new Redis();
const subscriber = new Redis();

const hint = {
    publish: async (channel, message) => {
        await publisher.publish(channel, message);
    },
    subscribe: async (channel, onMessage) => {
        const listener = (from, message) => {
            if (from === channel) {
                onMessage(message);
            }
        };

        subscriber.on('message', listener);
        await subscriber.subscribe(channel);

        return async () => {
            subscriber.off('message', listener);
            await subscriber.unsubscribe(channel);
        };
    },
};

const sqlane = createSqlane({ adapter, jobs, hint });
```

## Adapters

An adapter connects sqlane to your driver or ORM. You create it over the queue's own pool and pass it to
`createSqlane`. The `connection` argument of `enqueue` then takes the connections, transactions or clients of the same
library. Each adapter is a subpath of `@sqlane/core`, so you install no extra package. [Adapters](adapters.md) explains
each adapter in detail.

| Import                             | Function                                             | Library                                                                   |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `@sqlane/core/adapter-mysql2`      | `mysql2Adapter(pool, { dialect })`                   | [mysql2](adapters.md#mysql2)                                              |
| `@sqlane/core/adapter-pg`          | `pgAdapter(pool, { dialect, notify?, prepare? })`    | [pg](adapters.md#pg) (node-postgres)                                      |
| `@sqlane/core/adapter-postgres-js` | `postgresJsAdapter(sql, { dialect, notify? })`       | [postgres.js](adapters.md#postgresjs)                                     |
| `@sqlane/core/adapter-knex`        | `knexAdapter(knex, { dialect, prepare? })`           | [Knex](adapters.md#knex), with mysql2, mariadb or pg                      |
| `@sqlane/core/adapter-kysely`      | `kyselyAdapter(db, { dialect })`                     | [Kysely](adapters.md#kysely)                                              |
| `@sqlane/core/adapter-drizzle`     | `drizzleAdapter(db, { dialect, notify? })`           | [Drizzle](adapters.md#drizzle), with mysql2, node-postgres or postgres.js |
| `@sqlane/core/adapter-prisma`      | `prismaAdapter(prisma, { dialect })`                 | [Prisma](adapters.md#prisma)                                              |
| `@sqlane/core/adapter-sequelize`   | `sequelizeAdapter(sequelize, { dialect, prepare? })` | [Sequelize](adapters.md#sequelize)                                        |
| `@sqlane/core/adapter-typeorm`     | `typeOrmAdapter(dataSource, { dialect })`            | [TypeORM](adapters.md#typeorm)                                            |
| `@sqlane/core/adapter-mikro-orm`   | `mikroOrmAdapter(em, { dialect, prepare? })`         | [MikroORM](adapters.md#mikroorm)                                          |

Every adapter requires `dialect`: `'mysql'`, `'mariadb'` or `'postgres'`. pg and postgres.js take `'postgres'`, mysql2
`'mysql'` or `'mariadb'`. Knex, Drizzle, Sequelize, TypeORM and MikroORM check it against the database of the library.
Every adapter also takes `allowUnsupportedDbVersion` (default `false`): `true` runs on a server below the supported
version, with a warning. On MySQL and MariaDB, `allowUnsupportedDbConfiguration` (default `false`) does the same for a
`sql_mode` that lacks a required flag ([server check](adapters.md#the-dialect-and-the-server-check)). The `notify`
option is for PostgreSQL only. When it is `true`, sqlane sends hints with LISTEN/NOTIFY, and you
must not set the `hint` option. An adapter throws a `ConfigError` if it gets an object or a version that it does not
support.
