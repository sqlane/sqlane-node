# API reference

This page describes the public API of `@sqlane/core`. sqlane is a job queue that stores its jobs as rows in your own
MySQL, MariaDB or PostgreSQL database. You add a job inside your business transaction, so the job exists only if that
transaction commits.

sqlane follows semantic versioning since 1.0, so only a major version breaks this API. The [design](design.md)
explains how sqlane works and why.

## Contents

- [Terms](#terms)
- [Durations](#durations)
- [`defineJob`](#definejob)
- [`createSqlane`](#createsqlane)
- [`defineConcurrencyLimit`](#defineconcurrencylimit)
- [`defineRateLimit`](#defineratelimit)
- [Where job options come from](#where-job-options-come-from)
- [`enqueue`](#enqueue)
- [`enqueueMany`](#enqueuemany)
- [`handle`](#handle)
- [How free slots are shared](#how-free-slots-are-shared)
- [`schedule`](#schedule)
- [`getSchedules`](#getschedules)
- [`start`](#start)
- [`drain`](#drain)
- [`close`](#close)
- [`migrate`](#migrate)
- [`getMigrations`](#getmigrations)
- [`getStats`](#getstats)
- [`jobs`](#jobs)
- [Retry, cancel and remove](#retry-cancel-and-remove)
- [Key stats](#key-stats)
- [`wake`](#wake)
- [Errors](#errors)
- [Events](#events)
- [`FailedJobPayload`](#failedjobpayload)
- [`Hint`](#hint)
- [Adapters](#adapters)

## Terms

| Term              | Meaning                                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job               | One unit of work. It is one row in the database, with a payload, a state and a number of attempts.                                                                                                                           |
| Job name          | The kind of a job, for example `build_report`. The job name is also the queue, because sqlane has no separate queue object.                                                                                                  |
| Job definition    | The name and the options of a job name. You create it with `defineJob`. Producers and workers import the same definition.                                                                                                    |
| Handler           | The function that runs a job. Only workers register handlers.                                                                                                                                                                |
| Concurrency limit | The most jobs that run at once. A definition lists it as a local limit, which each instance counts, or as a global limit, which the whole cluster counts per key. You create it with `defineConcurrencyLimit`.               |
| Rate limit        | The most job starts in a period. A definition lists it as a local limit, which each instance counts, or as a global limit, which the whole cluster counts per key. You create it with `defineRateLimit`.                     |
| Fair share weight | The share of the free slots that a job name gets, against the other due names: `fairShareWeight`, default 1.                                                                                                                 |
| Lease             | The time for which a process owns a running job. The process renews the lease while the handler runs. If the process stops, the lease ends and another process can take the job.                                             |
| Stall             | A stall happens when the lease of a running job ends because its process stopped or blocked. sqlane then puts the job back in the queue.                                                                                     |
| Key               | A string such as `order:42`: a global limit counts the jobs of each of its keys. Two jobs with one key of a limit of 1 never run at the same time in the whole cluster, as long as handlers stop when their `signal` aborts. |
| Blocked job       | A due job with a full key, or with a rate key that has no quota left. It waits out of the due jobs until a job of the key ends, or until the next start of the rate key.                                                     |
| Failure job       | A job that sqlane adds when another job fails for good. It lets you react to the failure, for example by sending an alert.                                                                                                   |
| Adapter           | The object that connects sqlane to your database driver or ORM.                                                                                                                                                              |
| Hint              | A message that tells other processes that jobs of a name are ready. Hints only make jobs start sooner. If a hint is lost, the job still runs at the next poll.                                                               |
| Schedule          | A cron or an interval that adds a job of a name at each of its times. You add it with `schedule()`.                                                                                                                          |
| Slot              | One time of a schedule. Each slot adds at most one job, whose id is `<job name>:schedule:[<key>:]<ISO time>`.                                                                                                                |

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

## `defineJob`

`defineJob` creates a job definition, which holds the name and the options of a job name.

```ts
defineJob<P = any>(options: JobOptions<P>): JobDefinition<P>
```

The definition is a frozen object. Keep it in a small module that both producers and workers import. A producer then
does not need to import the handler and its dependencies.

| Option                    | Type                                                                    | Default                                                             | Description                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                    | `string`                                                                | Required                                                            | The job name. It must match `^[a-z][a-z0-9_.-]{0,127}$`, so it cannot contain `:`. It is case-sensitive.                                                                                                                                                                                                                                                         |
| `maxAttempts`             | integer, at least 1                                                     | `3`                                                                 | The number of times a job runs before it fails for good. Set at enqueue; a `one_more` retry changes it.                                                                                                                                                                                                                                                          |
| `maxStalls`               | integer, at least 0                                                     | `2`                                                                 | The number of stalls that a job survives. The next stall after this number fails the job for good. Set at enqueue; a `one_more` retry changes it.                                                                                                                                                                                                                |
| `backoff`                 | [`Backoff`](#backoff)                                                   | `{ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 }` | The wait before the next attempt after a failed attempt.                                                                                                                                                                                                                                                                                                         |
| `retention`               | `{ completed?: Duration, failed?: Duration }`                           | `{ completed: '1h', failed: '30d' }`                                | How long sqlane keeps a completed or a failed job before it deletes the row. A `jobId` blocks duplicates while the row exists. That is while the job is pending or running, then during this retention, until the next cleanup. A started process runs the cleanup every 5 minutes. If every process sets `cleanup: false`, the rows stay until you delete them. |
| `timeout`                 | positive duration                                                       | None                                                                | The time after which sqlane aborts the handler. A definition with `globalConcurrencyLimits` needs a timeout, here or in the instance `defaults`.                                                                                                                                                                                                                 |
| `globalConcurrencyLimits` | `({ payload }) => readonly (ConcurrencyLimit \| ConcurrencyLimitKey)[]` | None                                                                | A function that returns the global limits of a job: [limits and their keys](#defineconcurrencylimit). It must be synchronous and use only its argument. sqlane calls it at enqueue, with the payload as JSON gives it back, and stores the keys with their maxes in the job.                                                                                     |
| `localConcurrencyLimits`  | `readonly ConcurrencyLimit[]`                                           | None                                                                | Limits that each instance counts for its own jobs. A job starts while each of them has room.                                                                                                                                                                                                                                                                     |
| `globalRateLimits`        | `({ payload }) => readonly (RateLimit \| RateLimitKey)[]`               | None                                                                | A function that returns the global rate limits of a job: [limits, their keys and costs](#defineratelimit). It follows the rules of `globalConcurrencyLimits`: synchronous, called at enqueue, and the keys are stored with their settings in the job.                                                                                                            |
| `localRateLimits`         | `readonly RateLimit[]`                                                  | None                                                                | Rate limits that each instance counts for its own starts. A job starts while each of them has quota.                                                                                                                                                                                                                                                             |
| `fairShareWeight`         | integer, 1 to 1000                                                      | `1`                                                                 | The name's share of the free slots of an instance, against the other due names. See [How free slots are shared](#how-free-slots-are-shared).                                                                                                                                                                                                                     |
| `failureJob`              | `string` or `JobDefinition`                                             | None                                                                | The job name that sqlane adds when a job of this name fails for good. A job cannot be its own failure job. The failure job cannot have a `failureJob` of its own. Its payload is a [`FailedJobPayload`](#failedjobpayload).                                                                                                                                      |

`defineJob` throws a `ConfigError` if an option is unknown or has a bad value. It does not check whether a
definition with global limits has a timeout, because `handle()` checks that.

The options of a definition apply at two times. `maxAttempts`, `maxStalls`, `retention`, `failureJob` and the global
limits, of concurrency and of rate, are stored in the job at enqueue: a change applies to the jobs enqueued after it.
`backoff`, `timeout`, `fairShareWeight` and the local limits are read by the worker that runs the job.

```js
import { defineConcurrencyLimit, defineJob } from '@sqlane/core';

export const order = defineConcurrencyLimit({ name: 'order', max: 1 });

export const syncOrder = defineJob({
    name: 'sync_order',
    maxAttempts: 5,
    globalConcurrencyLimits: ({ payload }) => [order.key(payload.orderId)],
    timeout: '2m',
    failureJob: 'sync_order_failed',
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
type. The handler's `payload` and the `payload` of `globalConcurrencyLimits` and `globalRateLimits` also get this
type.

In TypeScript, pass the type to `defineJob`:

```ts
export const buildReport = defineJob<{ reportId: string }>({ name: 'build_report' });
```

In JavaScript with JSDoc, put the type on the constant:

```js
/** @type {import('@sqlane/core').JobDefinition<{ reportId: string }>} */
export const buildReport = defineJob({ name: 'build_report' });
```

Without a declared type, `enqueue` only checks that the payload is JSON, and the handler gets `any`. sqlane does not
validate payloads at runtime, so your app must validate its own payloads if it needs to.

## `createSqlane`

`createSqlane` creates a sqlane instance.

```ts
createSqlane<C>(options: SqlaneOptions<C>): Sqlane<C>
```

The type `C` is the connection type that `enqueue` accepts, and it comes from the adapter. `createSqlane` does not
connect, migrate or start anything. It throws a `ConfigError` if an option is unknown or has a bad value. The options
of 4.x and 5.x throw a `ConfigError` that names the new one: `concurrency` and `maxConcurrency` are now
`localMaxConcurrency`, and `lanes` became [local limits](#defineconcurrencylimit).

| Option                | Type                           | Default     | Description                                                                                                                                                                                           |
| --------------------- | ------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter`             | `Adapter<C>`                   | Required    | The adapter of your driver or ORM, created over the queue's own pool. sqlane uses this pool to claim jobs, renew leases and write results. See [Adapters](#adapters).                                 |
| `jobs`                | `readonly JobDefinition[]`     | `[]`        | The definitions that this instance knows by name. List every definition here, so that an enqueue by name finds its options. Two different definitions with one name throw a `ConfigError`.            |
| `localMaxConcurrency` | integer, at least 1            | `10`        | The highest number of handlers that run at the same time in this instance. The free slots are [shared by weight](#how-free-slots-are-shared).                                                         |
| `defaults`            | `JobDefaults`                  | See below   | Defaults for `maxAttempts`, `maxStalls`, `backoff`, `retention` and `timeout`. A definition overrides them.                                                                                           |
| `unknownJobs`         | `'allow'` or `'reject'`        | `'allow'`   | With `'reject'`, `enqueue` rejects with an `UnknownJobError` for a job name that is neither in `jobs` nor handled.                                                                                    |
| `hint`                | [`Hint`](#hint) or `null`      | `null`      | A publish/subscribe service that wakes other processes after an enqueue. With `null`, other processes find new jobs at their next poll. You cannot combine it with the `notify` option of an adapter. |
| `logger`              | `Logger`                       | None        | A pino-compatible logger with `debug`, `info`, `warn` and `error` methods. Each method takes an object and an optional message. Without a logger, sqlane writes no logs.                              |
| `onEvent`             | `(event: SqlaneEvent) => void` | None        | A function that receives the [events](#events) of the job lifecycle. If it throws, sqlane logs the error and goes on.                                                                                 |
| `tablePrefix`         | `string`                       | `'sqlane_'` | The prefix of the table names. It must match `^[a-z][a-z0-9_]{0,31}$`.                                                                                                                                |
| `pollInterval`        | positive duration              | `'5s'`      | How often a started process checks the database for due jobs when nothing wakes it.                                                                                                                   |
| `maxPayloadBytes`     | integer, at least 1            | `262144`    | The largest payload, in bytes of JSON. The default is 256 KiB.                                                                                                                                        |
| `cleanup`             | `boolean`                      | `true`      | When it is `true`, a started process deletes the completed and failed jobs after their retention.                                                                                                     |

The built-in job defaults are `maxAttempts: 3`, `maxStalls: 2`, the default [backoff](#backoff),
`retention: { completed: '1h', failed: '30d' }` and no timeout.

```js
import { createSqlane } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';

const sqlane = createSqlane({
    adapter: mysql2Adapter(queuePool, { dialect: 'mysql' }),
    jobs: [buildReport, syncOrder],
    localMaxConcurrency: 10,
    defaults: { timeout: '10m' },
    unknownJobs: 'reject',
});
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

Define a limit once, at module level, like a job definition. The limit is a frozen object. A definition uses it in
one of two ways:

- **Local**, in `localConcurrencyLimits`: each instance counts its own jobs of all the names that list the limit, in
  memory. It costs no database work. A local limit above the instance's `localMaxConcurrency` is allowed: the lower
  one applies, so one definition fits large and small machines.
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
`InvalidConcurrencyLimitError` at enqueue; in the local limits of one instance, `handle()` throws a `ConfigError`.

`defineConcurrencyLimit` throws a `ConfigError` for an unknown option, a bad name or a bad `max`.

```js
import { defineConcurrencyLimit, defineJob } from '@sqlane/core';

export const heavy = defineConcurrencyLimit({ name: 'heavy', max: 2 });
export const perClient = defineConcurrencyLimit({ name: 'client', max: 2 });
export const allMessages = defineConcurrencyLimit({ name: 'messages', max: 100 });

export const transcode = defineJob({ name: 'transcode', timeout: '5m', localConcurrencyLimits: [heavy] });
export const sendMessage = defineJob({
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
milliseconds. A definition uses it in one of two ways:

- **Local**, in `localRateLimits`: each instance counts the starts of all the names that list the limit, in memory. It
  costs no database work, and N instances start up to N times the rate. A local limit has no keys, and each start
  costs 1. A name over one of its local rate limits takes no slot: its jobs stay pending until the limit allows a
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
one instance make `handle()` throw a `ConfigError`. A global rate limit needs no `timeout`: a rate key holds nothing
while the job runs.

`defineRateLimit` throws a `ConfigError` for an unknown option, a bad name, or a bad `max`, `per` or `burst`.
`limit.key()` and `limit.cost()` throw an `InvalidRateLimitError` for a bad value or cost.

```js
import { defineJob, defineRateLimit } from '@sqlane/core';

export const perToken = defineRateLimit({ name: 'github', max: 5000, per: '1h' });
export const allSms = defineRateLimit({ name: 'sms', max: 10, per: '1s', burst: 10 });
export const diskIo = defineRateLimit({ name: 'disk_io', max: 50, per: '1s' });

export const syncRepo = defineJob({
    name: 'sync_repo',
    // 5000 starts an hour per GitHub token in the cluster, and 50 a second in each process
    globalRateLimits: ({ payload }) => [perToken.key(payload.tokenId)],
    localRateLimits: [diskIo],
});
export const sendSms = defineJob({
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
2. The job definition. For an enqueue by name, sqlane uses the definition in `jobs`, or the definition that `handle()`
   registered.
3. The `defaults` of `createSqlane`.
4. The built-in defaults.

`retention` is merged field by field, so you can override only `completed` or only `failed`. `backoff`, `timeout`,
`fairShareWeight` and the local limits are not enqueue options: the worker reads them from the definition of the
handler, else from `defaults`.

sqlane fixes the other options of a job, the global limits with their maxes and settings included, when you enqueue
it. A later change to a definition does not change the jobs that already exist.

## `enqueue`

`enqueue` adds one job, with your connection, in your transaction.

```ts
sqlane.enqueue(connection: C, job: JobDefinition | string, payload: P, options?: EnqueueOptions): Promise<EnqueueResult>
```

The `connection` is the raw connection of your driver or ORM, as the [adapter](#adapters) defines it. If it is a
connection or a transaction client, it must be in a transaction, because sqlane cannot always detect one. If it is a
pool, sqlane runs the insert in a transaction of its own, outside of any transaction of yours.

The `job` is a definition or a job name. If you pass a name, sqlane looks for its definition in `jobs` and in the
handled names. If it finds none, the job gets the defaults, and `globalConcurrencyLimits`, `globalRateLimits` and
`failureJob` come only from the enqueue options.

The `payload` must be JSON. sqlane rejects a payload that `JSON.stringify` cannot write, a string that is not
well-formed UTF-16, and a NUL character (`\u0000`), because PostgreSQL refuses it. The handler gets the payload as
JSON gives it back, so a `Date` would arrive as a string. The TypeScript types reject a `Date`, a `Map`, a `Set`, a
function, a `bigint` and a class instance with methods.

| Option                    | Type                                                   | Default                        | Description                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobId`                   | `string`                                               | None                           | An id that prevents duplicates. It has 1 to 120 printable ASCII characters, without spaces at the ends. While a job with this id and name exists, a second enqueue adds nothing: a job cancelled by `jobs.cancel` keeps blocking it until cleanup deletes it, and `jobs.remove` frees it. It cannot start with `schedule:`, which is reserved for the slots of schedules. |
| `slot`                    | `{ at: Date, key?: string }`                           | None                           | Runs a slot of a [schedule](#schedule) by hand: the job gets the id that the scheduler gives the slot. `at` is in the years 1970 to 9999, and `key` is the key of the schedule. You cannot combine it with `jobId`. The job is due now, unless you give `delay` or `runAt`.                                                                                               |
| `delay`                   | `Duration`                                             | `0`                            | The wait before the job becomes due. You cannot combine it with `runAt`.                                                                                                                                                                                                                                                                                                  |
| `runAt`                   | `Date`                                                 | None                           | The time at which the job becomes due. You cannot combine it with `delay`.                                                                                                                                                                                                                                                                                                |
| `maxAttempts`             | integer, at least 1                                    | From the definition            | Overrides `maxAttempts` for this job. A `one_more` retry changes it.                                                                                                                                                                                                                                                                                                      |
| `maxStalls`               | integer, at least 0                                    | From the definition            | Overrides `maxStalls` for this job. A `one_more` retry changes it.                                                                                                                                                                                                                                                                                                        |
| `retention`               | `{ completed?: Duration, failed?: Duration }`          | From the definition            | Overrides the retention for this job, field by field.                                                                                                                                                                                                                                                                                                                     |
| `failureJob`              | `string` or `JobDefinition`                            | From the definition            | Overrides the failure job for this job.                                                                                                                                                                                                                                                                                                                                   |
| `globalConcurrencyLimits` | `readonly (ConcurrencyLimit \| ConcurrencyLimitKey)[]` | From the definition's function | Replaces the global limits that the definition computes. An empty array removes them all.                                                                                                                                                                                                                                                                                 |
| `globalRateLimits`        | `readonly (RateLimit \| RateLimitKey)[]`               | From the definition's function | Replaces the global rate limits that the definition computes. An empty array removes them all.                                                                                                                                                                                                                                                                            |

The global limits follow the rules of [`defineConcurrencyLimit`](#defineconcurrencylimit) and
[`defineRateLimit`](#defineratelimit). Keys are global, so jobs of different names can share a key.

`enqueue` resolves to an `EnqueueResult`:

| Field     | Type      | Description                                                                                                                                        |
| --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | `string`  | The job id. It is `<job name>:<jobId>` when you give a `jobId`, `<job name>:schedule:[<key>:]<ISO time>` with `slot`, and a new ULID with neither. |
| `created` | `boolean` | It is `false` when a job with this `jobId` (or of this `slot`) exists already. In that case sqlane added nothing.                                  |

`enqueue` checks everything before it writes, and it rejects with these errors:

- `InvalidOptionsError` for a bad job, a bad option, `delay` together with `runAt`, `slot` together with `jobId`, a
  `jobId` that starts with `schedule:`, or a payload that is not JSON, or a `jobId` of `jobs.get` that is not a string.
- `PayloadTooLargeError` if the payload is larger than `maxPayloadBytes`.
- `InvalidConcurrencyLimitError` if a global limit breaks the rules of `defineConcurrencyLimit`.
- `InvalidRateLimitError` if a global rate limit breaks the rules of `defineRateLimit`, or the job has more than 10
  global keys of both kinds.
- `UnknownJobError` for an unknown name when `unknownJobs` is `'reject'`.

`enqueue` and `enqueueMany` still work after `close()`, because they use only your connection.

```js
await connection.beginTransaction();
await connection.query('INSERT INTO reports (id) VALUES (?)', [reportId]);
const { id, created } = await sqlane.enqueue(connection, buildReport, { reportId }, { jobId: String(reportId), delay: '10s' });
await connection.commit();
```

## `enqueueMany`

`enqueueMany` adds several jobs of one name in one call.

```ts
sqlane.enqueueMany(
    connection: C,
    job: JobDefinition | string,
    items: readonly { payload: P, options?: EnqueueOptions }[],
): Promise<EnqueueResult[]>
```

Each item has a `payload` and optional [enqueue options](#enqueue). The results are in the order of the items. sqlane
checks all the items before it writes, so one bad item adds no job at all. If two items in one call have the same
`jobId`, the first item adds the job and the next items get `created: false`.

```js
const results = await sqlane.enqueueMany(connection, sendEmail, [
    { payload: { to: 'a@example.com' } },
    { payload: { to: 'b@example.com' }, options: { delay: '1m' } },
]);
```

## `handle`

`handle` registers the handler of a job name in this process.

```ts
sqlane.handle(job: JobDefinition | string, handler: (context: HandlerContext<P>) => unknown): void
```

Register all the handlers before you call `start()`. The return value of the handler is ignored. sqlane does not wrap
the handler in a transaction, so a handler that needs one opens it with its own connection. All the options of a job
name are in its definition: `handle()` takes none.

A handler runs in the async context of the `start()` or `drain()` call, never in the context of the code that woke the
worker: an enqueue, the commit of a transaction or a hint. So the `AsyncLocalStorage` stores of a request, and its CLS
transaction, do not reach the handlers. To give the handlers a context, such as a logger, call `start()` inside it.

`handle` throws a `ConfigError` in these cases:

- It gets options: those of 5.x moved to the definition, and the error says where.
- The job name already has a handler.
- `jobs` holds a different definition with the same name.
- Two local limits with one name have different maxes in this instance.
- Two local rate limits with one name have different settings in this instance.
- The definition has `globalConcurrencyLimits`, but no timeout is set in the definition or `defaults`.
- `start()` was called before, or `drain()` runs.

`handle` throws a `ClosedError` after `close()`.

### The handler context

The handler receives one object with three fields:

| Field     | Type          | Description                                                                                               |
| --------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `payload` | `P`           | The payload, as JSON gives it back. Its type is the declared payload type, or `any` without one.          |
| `job`     | `JobInfo`     | Information about the job (see below).                                                                    |
| `signal`  | `AbortSignal` | A signal that aborts when the handler must stop. Pass it to `fetch` and other APIs, or check it in loops. |

The `job` object has these fields:

| Field                     | Type                                      | Description                                                                                  |
| ------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                      | `string`                                  | The job id.                                                                                  |
| `name`                    | `string`                                  | The job name.                                                                                |
| `attempt`                 | `number`                                  | The current attempt. It is 1 for the first run.                                              |
| `maxAttempts`             | `number`                                  | The highest number of attempts for this job. Set at enqueue; a `one_more` retry changes it.  |
| `enqueuedAt`              | `Date`                                    | The time of the enqueue.                                                                     |
| `globalConcurrencyLimits` | `readonly { key: string, max: number }[]` | The keys of the global limits of the job, sorted, with their maxes.                          |
| `scheduledAt`             | `Date` or `null`                          | The slot of a job of a [schedule](#schedule), also when it runs late. `null` for other jobs. |
| `runAt`                   | `Date`                                    | The job's due time, as stored: its place in line (below).                                    |
| `startedAt`               | `Date`                                    | The start of this run, by the database clock, as `JobRecord.startedAt` shows it.             |

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
sqlane.handle(buildReport, async ({ payload, job, signal }) => {
    await generateReport(payload.reportId, { signal });
});
```

## How free slots are shared

A process runs at most `localMaxConcurrency` handlers at once. When slots are free and several job names have due
jobs, a free slot goes to the due name with the lowest `running / fairShareWeight`. `running` counts the jobs of the
name that run in this instance, retries included. The name must be under each of its local limits and the instance's
cap. Ties go round-robin.

- **Within a name**, jobs start in FIFO order: `run_at`, then the id. Jobs of a key of a global limit start in FIFO
  order among those that can start.
- **A name is not in the race, and banks nothing,** while it has no due job, its due jobs have full keys, or it is at
  one of its local limits or over one of its local rate limits. The rule keeps no history: only the running counts of
  the moment.
- **The shares are per instance.** Each process shares its own slots.
- **Not oldest first across names.** In 4.x, the oldest due job across names started first. Now a busy name cannot
  crowd out the others.
- **A name woken by the end of a job of a key** competes by its share, like any other name. The jobs blocked on the key
  are due again before the slot of the ended job is free, so they compete for it too.

With weights 3 and 1 on 8 slots, and both names busy, 6 jobs of the first name and 2 of the second run. When a job
ends, its slot goes back to its own name.

**The rule equalizes the running counts, not the order of the starts.** Take A's 10 jobs, then B's 3, with equal
weights and `localMaxConcurrency: 4`. A1 to A4 start first.

- When the 4 jobs end together, the next claims take `{A5, B1, A6, B2}`, then `{B3, A7, A8, A9}`.
- When the slots free one at a time, B first catches up to its share: `B1 B2 A5 A6 B3 …`.

**The odd remainder.** When a share is not a whole number of slots, the extra slot goes to a name at each tie, not by
time. So a name with long jobs keeps it longer. With jobs of 10 s against 1 s, equal weights and 3 slots, the long
jobs take 63.5 % of the slot time and the short ones 36.5 %: 1.9 and 1.1 slots, against 1.5 each. The error stays
below one slot. With 4 or 8 slots, each name gets exactly half.

**Very short jobs.** Shares count running handlers. A name whose jobs take a few milliseconds loses the short gap
between a completion and the next claim, so its measured slot time is a little below its share.

**Local limits.** Take T (weight 2, with a local limit of 1 of its own) and R (weight 1), which share a local limit
`heavy` of 2, and E (weight 3), on 10 slots. T and R each run 1 job, and E runs 8. With `heavy` at 4, R and E share
the 9 slots that T leaves by 1:3. A name can have several local limits: it takes a slot while each of them has room.

**The slots of names with global limits.** A claim first finds the jobs of names with global limits whose keys have
room, and leaves them their share of the free slots, of the instance and of their local limits. If another process
takes those jobs first, the slots stay free until the next turn, which comes at once.

## `schedule`

`schedule` adds a job at each time of a cron in a time zone, or at a fixed interval.

```ts
sqlane.schedule(job: JobDefinition | string, options: ScheduleOptions): void
```

Each time of a schedule is a **slot**. At each slot, every started process that has the schedule tries to add the
job. A row per schedule in the table `sqlane_schedules` lets one of them add it. So each slot adds at most one job in
the whole cluster, with no leader. A scheduled job is an ordinary job: its definition gives its retries, backoff,
timeout, global limits, failure job and retention.

| Option     | Type                  | Default   | Description                                                                                                                                                                                      |
| ---------- | --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cron`     | `string`              | None      | A cron expression with 5 fields (see below). Set either `cron` or `every`.                                                                                                                       |
| `timezone` | `string`              | `'UTC'`   | An IANA time zone, such as `'Europe/Berlin'`, in any case: `'europe/berlin'` is the same zone. Only with `cron`.                                                                                 |
| `every`    | `Duration`            | None      | A fixed interval from `'1s'` to `'1d'`, counted from 1970-01-01 00:00 UTC. An interval over 1 hour must divide 1 day: `'2h'`, `'3h'`, `'4h'`, `'6h'`, `'8h'`, `'12h'` or `'1d'`.                 |
| `key`      | `string`              | None      | Tells several schedules of one job name apart. It has 1 to 64 printable ASCII characters, without spaces at the ends.                                                                            |
| `payload`  | `P`                   | `{}`      | The payload of each job. It is fixed: the handler gets the slot from `job.scheduledAt`. When the definition declares a payload type, `payload` is required and checked.                          |
| `missed`   | `'once'` or `'skip'`  | `'once'`  | What happens to a slot that no process enqueued within 1 minute, for example during a downtime. `'once'` runs the latest missed slot once, within the catch-up reach (below). `'skip'` drops it. |
| `overlap`  | `'allow'` or `'skip'` | `'allow'` | With `'skip'`, a slot adds no job while the previous job of this schedule is pending or running, including its retries.                                                                          |
| `jitter`   | `Duration`            | None      | Spreads the runs of many schedules. Each slot runs at a fixed offset after its time, below `jitter` and below the next slot. At most `'1d'`, and below `every`.                                  |

Call `schedule()` in your worker code, before `start()`, as with `handle()`. Every started process that called
`schedule()` runs the schedule. The process does not need to handle the job name, so a dedicated scheduler process
works. A process that never calls `start()`, such as a web process, never adds scheduled jobs.

```js
export const nightlyReport = defineJob({ name: 'nightly_report', timeout: '10m' });

sqlane.handle(nightlyReport, async ({ job, signal }) => {
    await buildReport({ day: job.scheduledAt, signal }); // the slot, also when the run is late
});
sqlane.schedule(nightlyReport, { cron: '0 3 * * *', timezone: 'Europe/Berlin' });
sqlane.schedule(syncTenant, { every: '15m', key: 'tenant-42', payload: { tenantId: 42 }, overlap: 'skip' });
await sqlane.start();
```

The **schedule id** is the job name, or `<job name>:<key>` with a key. An id names one schedule in the whole cluster:
two services must not use one id for two different schedules.

`schedule` throws a `ConfigError` for bad options, for a second schedule with the same id, and for a cron that never
fires within 50 years. It throws a `ConfigError` after `start()`, and a `ClosedError` after `close()`.

`start()` checks each schedule further: an unknown name with `unknownJobs: 'reject'`, a payload that is not JSON or is
above `maxPayloadBytes`, and bad global limits of the definition throw a `ConfigError`. So a bad payload fails at deploy
time, not at 03:00. With schedules, `start()` also needs the table of migration `0004_schedules`: run `migrate()`.

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
A manual run with `slot` has no jitter. A change of `jitter` alone keeps the catch-up.

### Deploys and removed schedules

- Each slot adds at most one job, whatever the spec. During a rolling deploy, old and new processes both run their
  on-time slots until the old ones stop. For a clean break, change `key`: that makes a new schedule.
- A late catch-up needs the stored spec to equal the spec of the process. So moving `0 3 * * *` to `0 5 * * *` does
  not run the 05:00 slot of today at once. The specs are normalized, so `MON-FRI` and `1-5` are the same spec.
- A change of `payload`, `overlap` or `missed` applies from the next slot.
- A schedule that you remove from code stops. Its row stays, and sqlane never deletes it. `getSchedules()` lists it
  with `registered: false`. Delete it with `DELETE FROM sqlane_schedules WHERE id = '…'`.

### The clock

Each process computes its slots, but the **database clock** decides them. If the clock of a process differs from the
database clock by more than 5 seconds, sqlane logs a warning, at most once per 10 minutes. A process with a wrong
clock still adds each job at its slot by the database time.

### The `schedule:` prefix and a manual run

The job id of a slot is `<job name>:schedule:[<key>:]<ISO time>`, for example
`nightly_report:schedule:2026-11-11T02:00:00.000Z`. The `jobId` prefix `schedule:` is reserved: `enqueue` rejects it.

To run a slot by hand, use the `slot` option of [`enqueue`](#enqueue). It builds the same job id as the scheduler,
so the scheduler adds no second job for that slot.

```js
await sqlane.enqueue(db, nightlyReport, {}, { slot: { at: new Date('2026-11-11T02:00:00.000Z') } });
```

sqlane does not check that `at` is a slot of a schedule. The manual run does not move the schedule. While the job of
the slot exists, within its retention, the enqueue returns `created: false` and runs nothing.

### Guarantees

- Each slot adds **at most one job, ever**. The cursor row of the schedule only moves forward, and it outlives the
  retention of the job.
- A slot adds a job if a started process with the schedule is up within 1 minute after it, or, with `missed: 'once'`,
  at the next start within the catch-up reach. One exception: if a fire of a slot rolls back, and a later slot of the
  schedule is decided first, the earlier slot is skipped.
- The job itself runs at least once, as any job does.

## `getSchedules`

`getSchedules` lists the schedules of the table and of this process.

```ts
sqlane.getSchedules(): Promise<ScheduleInfo[]>
```

| Field        | Type               | Description                                                                    |
| ------------ | ------------------ | ------------------------------------------------------------------------------ |
| `id`         | `string`           | `<job name>` or `<job name>:<key>`.                                            |
| `name`       | `string`           | The job name.                                                                  |
| `spec`       | `string`           | The stored spec, for example `cron 0 3 * * * Europe/Berlin` or `every 900000`. |
| `registered` | `boolean`          | `schedule()` was called in this process.                                       |
| `nextAt`     | `Date` or `null`   | The next slot. It is `null` for a schedule that this process does not have.    |
| `nextRunAt`  | `Date` or `null`   | The time the job of the next slot will be due: `nextAt` plus its jitter.       |
| `lastSlotAt` | `Date` or `null`   | The last decided slot. It is `null` before the first one.                      |
| `lastJobId`  | `string` or `null` | The job that the last enqueued slot added.                                     |

It reads the whole table, sorted by id, and adds the registered schedules that have no row yet. Rows with
`registered: false` belong to another service, or to schedules removed from code. After a deploy that changes a spec,
`spec` shows the old one until the first slot of the new spec. It works before `start()`. Without schedules and without
the table, it resolves to `[]`.

## `start`

`start` starts the worker of this process.

```ts
sqlane.start(): Promise<void>
```

After `start()`, the process claims and runs the due jobs of the names it handles. It also renews leases, recovers
stalled jobs and, if `cleanup` is on, deletes expired jobs. It starts the [schedules](#schedule) of this process. A
second call does nothing, and concurrent calls share one start.

With schedules, `start` registers them first. It rejects with a `ConfigError` for a bad schedule (see
[`schedule`](#schedule)), and if the table of the schedules is missing: run `migrate()`. If the database is down,
`start` resolves anyway, emits an `error` event, and registers the schedules when the database is back. A rejected
`start` can be called again.

The first `start()` or `migrate()` of an instance checks the server: it rejects with a `ConfigError` if the server is
not the database of the adapter's `dialect`, is below the supported version, or has a `sql_mode` that sqlane does not
support ([server check](adapters.md#the-dialect-and-the-server-check)). If the database is down, `start` resolves
anyway and emits an `error` event.

`start` rejects with a `ConfigError` if a handled definition has a `failureJob` that is neither in `jobs` nor handled.
It also rejects with one if a failure job has a `failureJob` of its own. It checks all the handlers together, so the
order of the `handle()` calls does not matter. `start` rejects with a `ClosedError` after `close()`.

## `drain`

`drain` runs the due jobs of the handled names until none is left, without `start()`. It is meant for tests.

```ts
sqlane.drain(options?: DrainOptions): Promise<DrainResult>
```

`drain` only runs the names that this instance handles, and only the jobs that are due. It does not wait for jobs of
other names. It does not fire schedules: in tests, enqueue a slot with the `slot` option.

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

`drain` also waits for the jobs that a rate limit holds back in this instance, when their next start comes before
the `timeout`. A `RateLimitedError` that sends a job back to wait is not counted.

`drain` checks the failure jobs as `start()` does. It rejects with a `ConfigError` after `start()` or while another
`drain()` runs. It rejects with an `InvalidOptionsError` for a bad `timeout`, and with a `ClosedError` after `close()`.

```js
await orderReport('report-1');
const { completed, failed } = await sqlane.drain({ includeDelayed: true });
```

## `close`

`close` stops the worker of this process and waits for the running handlers.

```ts
sqlane.close(options?: CloseOptions): Promise<void>
```

`close` stops claiming new jobs. Then it waits for the running handlers until the deadline. At the deadline, it aborts
the `signal` of each unfinished handler with a `ShutdownError`.

| Option     | Type                       | Default                                                           | Description                                                                                                                                                                                                    |
| ---------- | -------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deadline` | `Duration`                 | `'30s'`                                                           | How long `close` waits for the running handlers, counted from the call.                                                                                                                                        |
| `mode`     | `'release'` or `'abandon'` | `'release'`                                                       | What happens to an unfinished job at the deadline. With `'release'`, the job goes back to the queue without using an attempt. With `'abandon'`, sqlane writes nothing, and the job stalls when its lease ends. |
| `exitsBy`  | `Duration`                 | The deadline plus one lease (`'4m30s'` with the default deadline) | The latest time at which the process exits, counted from the call. A released job whose handler still runs waits until this time plus 2 seconds before it runs again, and its keys stay held until then.       |

Set `exitsBy` lower if your process exits sooner, so released jobs can run again sooner. `close` never rejects
because of its options, so a shutdown always releases its jobs. Instead, each invalid option logs a warning, and sqlane
uses its default. This includes an unknown option, and an `exitsBy` that is earlier than the deadline.

`close` resolves when the handlers have settled or the deadline has passed, and the releases are written. With
schedules, it also waits for a fire or a registration in flight. A second call returns the same promise. `close` ends
only what sqlane opened, such as the LISTEN connection and the hint subscription. It never ends your pools.

```js
process.once('SIGTERM', () => sqlane.close({ deadline: '30s', exitsBy: '35s' }));
```

## `migrate`

`migrate` creates or updates the tables of sqlane in the database.

```ts
sqlane.migrate(options?: { lockTimeout?: Duration }): Promise<{ applied: string[] }>
```

`migrate` applies the missing migrations and resolves to the ids of the migrations it applied. It holds a database
lock, so several processes can call it at the same time. It uses a connection of the adapter's pool.

| Option        | Type       | Default | Description                                                                                            |
| ------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `lockTimeout` | `Duration` | `'10m'` | How long `migrate` waits for the lock. After it, `migrate` rejects with a `MigrationLockTimeoutError`. |

`migrate` rejects with an `InvalidOptionsError` for a bad `lockTimeout`. It rejects with a `ConfigError` if the server
is not the database of the adapter's `dialect`, is below the supported version, or has a `sql_mode` that sqlane does
not support: the first `migrate()` or `start()` of an instance checks it
([server check](adapters.md#the-dialect-and-the-server-check)). If you prefer your own migration tool, use
[`getMigrations`](#getmigrations) instead.

`get`, `list` and the batches of [`sqlane.jobs`](#jobs) require the migration `0008_job_list`, an index of the jobs;
`keyStats` requires `0007_rate_limits`. The build of the index waits for the writes of
the jobs, and they wait for it: on a large PostgreSQL table, build the index `CONCURRENTLY` first, as the
[design](design.md#migrations) describes.

```js
const { applied } = await sqlane.migrate();
```

## `getMigrations`

`getMigrations` returns the schema of sqlane as SQL, for your own migration tool.

```ts
getMigrations(options: { dialect: 'mysql' | 'mariadb' | 'postgres', tablePrefix?: string }): Migration[]
```

Each migration has an `id` and a list of SQL `statements`. Apply them in order, and record the ids that you applied.

| Option        | Type                                   | Default     | Description                                                           |
| ------------- | -------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `dialect`     | `'mysql'`, `'mariadb'` or `'postgres'` | Required    | The database.                                                         |
| `tablePrefix` | `string`                               | `'sqlane_'` | The prefix of the table names. Use the same one as in `createSqlane`. |

`getMigrations` throws a `ConfigError` for a bad `dialect` or `tablePrefix`.

```js
import { getMigrations } from '@sqlane/core';

for (const { id, statements } of getMigrations({ dialect: 'postgres' })) {
    // Run the statements with your tool, then record the id.
}
```

## `getStats`

`getStats` returns counts of jobs per job name, for monitoring and alerts.

```ts
sqlane.getStats(): Promise<JobStats[]>
```

The list has one entry for each job name that has pending, running or failed jobs, sorted by name.

| Field            | Type             | Description                                                                               |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `name`           | `string`         | The job name.                                                                             |
| `pending`        | `number`         | The jobs that wait to run, including the ones that are not due yet.                       |
| `due`            | `number`         | The pending jobs that are due now.                                                        |
| `running`        | `number`         | The jobs that run now.                                                                    |
| `stuck`          | `number`         | The running jobs that have timed out but whose handler has not settled yet.               |
| `failed`         | `number`         | The failed jobs that sqlane still keeps.                                                  |
| `oldestDueAgeMs` | `number \| null` | How long the oldest due job has waited, in milliseconds. It is `null` when no job is due. |

Blocked jobs, on a full key or on a rate key without quota, count in `pending`, not in `due`. A job held back by a
local rate limit stays pending and due. A growing `oldestDueAgeMs` usually means that no process handles the name, or
that the workers cannot keep up. A growing `pending` with few `due` jobs can mean that a rate limit is below the rate
of the enqueues.

## `jobs`

`sqlane.jobs` acts on the jobs in the database. It reads them, one job by its id or the jobs of a name a page at a time,
it retries, cancels and removes them in bulk, and it shows the keys of the global limits. It is a frozen object of the
instance.

```ts
sqlane.jobs.get<P = any>(jobId: string): Promise<JobRecord<P> | null>
sqlane.jobs.list<J extends JobDefinition | string>(filter: JobFilter<J>, options?: ListJobsOptions): Promise<JobPage<HandlerPayload<J>>>
sqlane.jobs.retry(selector: JobSelector, options?: RetryOptions<C>): Promise<BulkResult>
sqlane.jobs.cancel(selector: JobSelector, options?: BulkOptions<C>): Promise<BulkResult>
sqlane.jobs.remove(selector: JobSelector, options?: BulkOptions<C>): Promise<BulkResult>
sqlane.jobs.keyStats(options?: KeyStatsOptions): Promise<KeyStatsPage>
```

The bulk methods are described in [Retry, cancel and remove](#retry-cancel-and-remove), and `keyStats` in
[Key stats](#key-stats). The rest of this section is about the reads.

- The reads are plain reads on the queue's pool, without locks. They never take a connection of your app.
- They work before `start()`, after `close()`, and in a process that handles no job. `unknownJobs` does not apply to
  them: any valid job name may be read.
- They require the migration `0008_job_list`. Without it, their behavior is not specified: `list` rejects on MySQL and
  MariaDB. Before `migrate()`, or when the database fails, they reject with the error of the driver.
- A known field of the filter or the options that is `undefined` counts as absent. An unknown field rejects, also when
  its value is `undefined`.

### `jobs.get`

`jobs.get` reads one job, with its payload.

The `jobId` is the full id, as `enqueue` returns it and as the events carry it: `<job name>:<jobId>`,
`<job name>:schedule:[<key>:]<ISO time>`, or a ULID. `get` resolves to `null` when no job has this id: it was never
added, or cleanup deleted it. A string that cannot be a job id also resolves to `null`, on every database, without a
query: an empty string, more than 255 characters, a character outside printable ASCII, or a space at an end. `get`
rejects with an `InvalidOptionsError` only when `jobId` is not a string.

`P` names the type of the payload. sqlane does not check it.

### `jobs.list`

`jobs.list` lists the jobs of one name, newest first, a page at a time.

| Filter    | Type                                  | Default      | Description                                         |
| --------- | ------------------------------------- | ------------ | --------------------------------------------------- |
| `jobName` | `string` or `JobDefinition`           | Required     | The job name, or a definition: its name.            |
| `status`  | `JobStatus` or `readonly JobStatus[]` | All statuses | One status, or a non-empty list without duplicates. |

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

With a definition as `jobName`, the jobs get the payload type of the definition, as the handler does. With a name, the
payload is `any`.

**Order and pages.**

- The jobs come by `enqueuedAt`, newest first, then by id, descending, in ASCII byte order. The order is total, and a
  job never moves in it: neither its enqueue time nor its id changes.
- `nextCursor` continues after the last job of its page. The pages list each row at most once, and a job that exists
  and matches the filter for the whole paging exactly once. A page may be empty, and a page with a `nextCursor` may be
  followed by an empty last page.
- A job becomes visible when its transaction commits, but `enqueuedAt` is the time of its insert. A job that commits
  after a page was read is listed by the later pages if its `enqueuedAt` comes after the cursor in the order, and
  missed if it comes before. A job enqueued again with the same `jobId` after its deletion is a new row, newer than the
  old one: the later pages do not list it.
- Each page filters by the status of a job when the page is read. A job that changes status between pages is listed by
  the page that reaches its place, if its status matches then.

**Cursors.**

- A cursor is opaque and bound to its filter, the name and the set of statuses: a cursor used with another filter
  rejects. `status: 'failed'` and `status: ['failed']` are the same filter, and the order of a list does not matter. An
  absent `status` and a list of every status are different filters: absent means every status, also those of a later
  major.
- `limit` and `includePayload` may change between pages.
- A cursor is not bound to an instance, a process or a version within a major: any instance with the same table prefix
  can continue it, also an older one during a rolling deploy.
- A cursor is not a security token. sqlane rejects a malformed cursor, not a well-formed one that someone built.

`list` rejects with an `InvalidOptionsError` for a filter or options that are not objects or have an unknown field, a
`jobName` that is neither a definition nor a valid job name, an unknown status, an empty list or a list with
duplicates, a `limit` that is not an integer from 1 to 1000, an `includePayload` that is not a boolean, a malformed
cursor, and a cursor of another filter.

```js
let cursor = null;

do {
    const page = await sqlane.jobs.list({ jobName: buildReport, status: 'failed' }, { cursor });

    for (const job of page.jobs) {
        console.log(job.id, job.attempts, job.lastError?.message);
    }

    cursor = page.nextCursor;
} while (cursor);
```

### `JobRecord`

A `JobRecord` is a job as the database has it. Every field is always present, except `payload`.

| Field                     | Type                                                                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                      | `string`                                                                  | The full job id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `name`                    | `string`                                                                  | The job name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `status`                  | `JobStatus`                                                               | `'pending'`, `'blocked'`, `'running'`, `'completed'` or `'failed'`, when read. `pending` does not include `blocked`; `getStats()` counts both in its `pending` (until the major splits them).                                                                                                                                                                                                                                                                                                          |
| `attempts`                | `number`                                                                  | The finished attempts: each completion, retry or failure adds one, whatever the error. A stall, a release and a wait on a rate limit add none, also a stall that fails the job: such a job has `attempts` below its last `FailedJobPayload.job.attempt`. A `reset` retry sets it to 0.                                                                                                                                                                                                                 |
| `maxAttempts`             | `number`                                                                  | The most attempts of the job, set at enqueue; a `one_more` retry changes it.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `stalls`                  | `number`                                                                  | The times its lease ended while it ran. A `reset` retry sets it to 0.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `maxStalls`               | `number`                                                                  | The stalls that it survives, set at enqueue; a `one_more` retry changes it.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `runAt`                   | `Date`                                                                    | When the job is due, or was. A pending job runs from then. A blocked job has been in line since then and runs when its key frees; after a `RateLimitedError` on a global rate key, it keeps the due time of the run that was rate limited. A running or finished job: the due time of its last run. `drain({ includeDelayed })` sets it to now for the pending jobs not due yet of the names that it handles; `jobs.retry` sets it as a rerun does. A cancelled job that never ran keeps its due time. |
| `enqueuedAt`              | `Date`                                                                    | The time of the insert, not of the commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `startedAt`               | `Date` or `null`                                                          | The start of its last run, an attempt or not. `null`: it never ran.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `finishedAt`              | `Date` or `null`                                                          | When it completed or failed for good. `null` otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `expiresAt`               | `Date` or `null`                                                          | From when cleanup may delete the finished job. A row can still be read after it. `null` for an unfinished job.                                                                                                                                                                                                                                                                                                                                                                                         |
| `scheduledAt`             | `Date` or `null`                                                          | The slot of a job of a [schedule](#schedule), from its id. `null` for other jobs.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `stuck`                   | `boolean`                                                                 | Running and timed out, by the last state written. Its handler may still run, or its process may be gone; stall recovery settles the latter.                                                                                                                                                                                                                                                                                                                                                            |
| `lastError`               | `JobError` or `null`                                                      | The last error written to the job, kept when it later completes: of a failed attempt, of a stall (`StalledError`), of a `RateLimitedError` on a global rate key of the job, or of `jobs.cancel` (`JobCancelledError`). Not by a block when it is claimed, nor by a wait on a local rate limit.                                                                                                                                                                                                         |
| `globalConcurrencyLimits` | `readonly { key, max }[]`                                                 | Its keys, sorted, with their maxes, as in `JobInfo`. `key` is the full key: `<limit>` or `<limit>:<value>`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `globalRateLimits`        | `readonly { limit, key, max, per, burst, cost }[]`                        | Its rate limits: the limit name and its key value, `null` for the limit itself, as in the `rate_limited` event. `per` is in milliseconds. Sorted by the full rate key, in byte order.                                                                                                                                                                                                                                                                                                                  |
| `blockedOn`               | `{ type: 'concurrency', key }`, `{ type: 'rate', limit, key }`, or `null` | What a blocked job waits for: a concurrency key, the full key, or a rate limit and its key value. `null` when the job is not blocked. Its `type` may gain members in a minor: a `switch` needs a `default`.                                                                                                                                                                                                                                                                                            |
| `failureJob`              | `string` or `null`                                                        | The name of its failure job, fixed at enqueue.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `payload`                 | `P`, optional                                                             | As JSON gives it back. A JSON `null` payload is present, as `null`. Absent when not asked for, or when the database holds no payload for the job: after its completion, briefly while its enqueue writes it, or after a failure with `MissingPayloadError`.                                                                                                                                                                                                                                            |

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
They work before `start()`, after `close()`, and in a process that handles no job. `unknownJobs` does not apply.

| Method   | Changes jobs in                             | Default of a filter | Effect                                                                                                                                                 |
| -------- | ------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `retry`  | `failed`                                    | `failed`            | The job is pending again, with the same id, enqueue time, keys and failure job. A job without a payload is not retried.                                |
| `cancel` | `pending`, `blocked`                        | both                | The job fails at once, with a `JobCancelledError` as `lastError`, `finishedAt` now and `expiresAt` from its failed retention. No failure job is added. |
| `remove` | `pending`, `blocked`, `completed`, `failed` | all four            | The job and its payload are deleted. Its dedupe key is free again.                                                                                     |

A running job is never changed. Its id is ignored with the reason `status`, and `running` in a filter rejects.

### The selector

```ts
type JobSelector =
    | { jobIds: readonly string[], jobName?: undefined, status?: undefined }
    | (JobFilter & { jobIds?: undefined });
```

- `jobIds`: 1 to 1000 distinct full job ids; duplicates count once. A string that cannot be a job id is ignored as
  `not_found`, as `jobs.get` returns `null` for it.
- A filter, `{ jobName, status? }`, as `jobs.list` takes it. `status` names only statuses that the method changes:
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
  stalls failed fails at its next stall, and another keeps its stall tolerance. The new maxes are stored in the job: a
  later `reset` restores these, not the ones of the enqueue. A job that never finished an attempt gets `maxAttempts` 1.
- `FailedJobPayload.job.attempt` restarts from 1 after a `reset`. The failure job that the job added when it failed
  stays; if the retried job fails again, it adds another.
- A completed job is not retried today: its payload is deleted at the completion. Its id is ignored with `status`, and
  `completed` in a filter rejects.

### `jobs.cancel`

- The job's `lastError` is `{ name: 'JobCancelledError', message: 'Cancelled by jobs.cancel()', code: 'JOB_CANCELLED' }`,
  and `blockedOn` becomes `null`. `attempts` does not change, and the payload is kept, as for any failed job.
- A cancelled job is `failed`: `getStats().failed` counts it, and a `retry` of the failed jobs retries it. `drain()`
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
  next slot run, and retrying it makes the skip apply again. The scheduler never adds a slot again; after a remove, a
  manual `enqueue({ slot })` adds a new job. Retrying an older job of a schedule may overlap a new slot. The skip ignores a
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
- A retried job wakes the workers as an enqueued one does: this process at once, the others by the hint (not after
  `close()`, which stops the hint channel; with the `notify` option, the NOTIFY is part of the transaction), and by
  their next poll.
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
  interval (30 s) plus a margin, while the names of the key have no due pending jobs (`getStats().oldestDueAgeMs` null
  or small). Shorter, it is normal (an ended linger, a race), and the recovery sweep repairs it. With due pending jobs,
  it means that no worker claims them.
- A missed timer of a rate key: blocked jobs with `nextStartInMs` 0 for longer than the recovery interval plus a margin,
  on the same condition. The sweep repairs it too.

**What it does not show.**

- The due jobs that no claim has seen yet: a job becomes blocked only when a claim finds its key full, so a name that no
  process handles shows nothing here. See `getStats().oldestDueAgeMs`.
- A job that waits on several keys counts only on the key it is blocked on.
- The local limits, and the timers and floors that each process keeps in memory.

**Cost.** Ranking the keys reads the head of each blocked key and the slot rows: its cost grows with the number of
distinct blocked keys, whatever `limit` is. The details read at most about `limit × 2001` index entries (the probe of the cap and the count), plus a few lookups per key (its head job, the job of its newest slot, its rate row). Poll it at the pace of
an alert, not of every metrics scrape.

`keyStats` is one plain read on the queue's pool, without locks. It works before `start()` and after `close()`, and
needs the migrations up to `0007_rate_limits`. It rejects with an `InvalidOptionsError` for an unknown option (also set
to `undefined`), or a bad `limit`, `type` or `orderBy`; a known option set to `undefined` counts as absent. The types
`KeyStats`, `KeyStatsOptions` and `KeyStatsPage` are exported from `@sqlane/core`.

## `wake`

`wake` makes this process check for due jobs now, instead of at the next poll.

```ts
sqlane.wake(): void
```

This is a low-level method, and most apps do not need it. sqlane already wakes the process after an enqueue in the same
process, and after a hint. The process checks all the names it handles, in one query. Before `start()`, `wake` does
nothing.

## Errors

All the errors of sqlane extend `SqlaneError`. Each error has a stable `code` that you can check. All the classes are
exported from `@sqlane/core`.

| Class                          | `code`                      | When                                                                                                                                                                                                                                                                                              |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigError`                  | `CONFIG`                    | The options of `createSqlane`, `defineJob`, `handle()`, `schedule()`, an adapter or `getMigrations` are bad. `start()` and `drain()` also throw it for a bad failure job. `start()` throws it for a bad schedule or a missing table of the schedules; with `migrate()`, for a wrong server.       |
| `InvalidOptionsError`          | `INVALID_OPTIONS`           | The arguments of `enqueue`, `enqueueMany` or a method of `sqlane.jobs` are bad, for example a bad name or `jobId`, a `jobId` with the reserved prefix `schedule:`, `slot` with `jobId`, `delay` with `runAt`, or a payload that is not JSON.                                                      |
| `PayloadTooLargeError`         | `PAYLOAD_TOO_LARGE`         | The payload is larger than `maxPayloadBytes`.                                                                                                                                                                                                                                                     |
| `InvalidConcurrencyLimitError` | `INVALID_CONCURRENCY_LIMIT` | A job has more than 10 global keys, a key breaks the rules, a key has two maxes, or a global limit is not from `defineConcurrencyLimit`.                                                                                                                                                          |
| `InvalidRateLimitError`        | `INVALID_RATE_LIMIT`        | A job has more than 10 global keys of concurrency and rate limits together, a rate key breaks the rules, a rate key has two settings, or a global rate limit is not from `defineRateLimit`. `limit.key()` or `limit.cost()` got a bad value or cost, or `new RateLimitedError()` got bad options. |
| `UnknownJobError`              | `UNKNOWN_JOB`               | `enqueue` got an unknown job name, and `unknownJobs` is `'reject'`.                                                                                                                                                                                                                               |
| `ClosedError`                  | `CLOSED`                    | `start`, `handle`, `schedule` or `drain` was called after `close()`.                                                                                                                                                                                                                              |
| `DrainTimeoutError`            | `DRAIN_TIMEOUT`             | `drain()` did not finish within its `timeout`.                                                                                                                                                                                                                                                    |
| `JobTimeoutError`              | `JOB_TIMEOUT`               | The handler's `signal` aborted because the timeout passed. It is also the error of the attempt.                                                                                                                                                                                                   |
| `ShutdownError`                | `SHUTDOWN`                  | The handler's `signal` aborted because `close()` reached its deadline.                                                                                                                                                                                                                            |
| `LeaseLostError`               | `LEASE_LOST`                | The handler's `signal` aborted because the process could not renew the lease until 30 s before it ends, for example because the database is unreachable.                                                                                                                                          |
| `MissingPayloadError`          | `MISSING_PAYLOAD`           | sqlane did not find the payload of a job. The job fails for good with this error.                                                                                                                                                                                                                 |
| `MigrationLockTimeoutError`    | `MIGRATION_LOCK_TIMEOUT`    | `migrate()` did not get the migration lock within its `lockTimeout`.                                                                                                                                                                                                                              |
| `IgnoredJobsError`             | `IGNORED_JOBS`              | A bulk method of `sqlane.jobs` with `strict: true` would have ignored some of its ids: it changed nothing. `ignoredJobs` lists them.                                                                                                                                                              |
| `JobCancelledError`            | `JOB_CANCELLED`             | The `lastError` of a job that `jobs.cancel` cancelled. `new JobCancelledError(message?, options?)`.                                                                                                                                                                                               |
| `FatalJobError`                | `FATAL_JOB`                 | A handler threw it to fail the job at once. See below.                                                                                                                                                                                                                                            |
| `RetryJobError`                | `RETRY_JOB`                 | A handler threw it to retry the job after a given delay. See below.                                                                                                                                                                                                                               |
| `RateLimitedError`             | `RATE_LIMITED`              | A handler threw it because the other side limits the rate: the job waits for its rate limit. See below.                                                                                                                                                                                           |

```js
import { SqlaneError } from '@sqlane/core';

try {
    await sqlane.enqueue(connection, 'build_report', payload);
} catch (error) {
    if (error instanceof SqlaneError && error.code === 'UNKNOWN_JOB') {
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

sqlane.handle(buildReport, async ({ payload, signal }) => {
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

sqlane.handle(syncRepo, async ({ payload, signal }) => {
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

The `onEvent` option of `createSqlane` receives an event object for each step of the job lifecycle. Use the events to
feed your metrics. The `type` field tells the kind of event.

Every event except `error` and `schedule_fired` has these fields:

| Field     | Type     | Description                                                                                                 |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `jobId`   | `string` | The job id.                                                                                                 |
| `jobName` | `string` | The job name.                                                                                               |
| `attempt` | `number` | The attempt, starting at 1. When stall recovery emits the event, it is the attempt of the run that stalled. |

| `type`                  | Extra fields                                              | When                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimed`               | `runAt`, `enqueuedAt`, `startedAt`                        | This process claimed the job and starts its handler. The fields are those of [`JobInfo`](#the-handler-context): the start delay is `startedAt − runAt`.                                                                                                                                                                                               |
| `completed`             | `durationMs`                                              | The job completed.                                                                                                                                                                                                                                                                                                                                    |
| `retried`               | `durationMs`, `delayMs`, `error`                          | The attempt failed, and the job will run again after `delayMs`.                                                                                                                                                                                                                                                                                       |
| `failed`                | `durationMs`, `error`                                     | The job failed for good. Stall recovery also emits it when a job stalls too often. `durationMs` is then the time from the start of the run that stalled until its recovery.                                                                                                                                                                           |
| `timed_out`             | `durationMs`                                              | The handler ran longer than its timeout, and its `signal` aborted.                                                                                                                                                                                                                                                                                    |
| `stalled`               | None                                                      | Stall recovery found a job whose lease had ended, and put it back in the queue.                                                                                                                                                                                                                                                                       |
| `released`              | None                                                      | `close()` released an unfinished job in `'release'` mode.                                                                                                                                                                                                                                                                                             |
| `lease_lost`            | None                                                      | This process could not renew the lease of the job until 30 s before it ends, and aborted its `signal`.                                                                                                                                                                                                                                                |
| `rate_limited`          | `durationMs`, `limit`, `key`, `scope`, `retryAt`, `error` | The handler threw a [`RateLimitedError`](#errors-that-handlers-throw) on a rate limit of the job. The job waits, without using an attempt, until about `retryAt`. `limit` is the name of the limit it waits on, `key` its key (`null` for a limit without keys, and for a local limit), `scope` `'global'` or `'local'`. `drain()` does not count it. |
| `failure_job_not_added` | `failureJob`, `error`                                     | The job failed for good, but the database refused to add its failure job.                                                                                                                                                                                                                                                                             |
| `cancelled`             | None                                                      | `jobs.cancel` cancelled the job, after the commit of a transaction of sqlane's own. `attempt` is the attempt that would have run next.                                                                                                                                                                                                                |
| `error`                 | `operation`, `error`                                      | An internal operation failed, for example a poll or a hint. `operation` names it. sqlane also logs it. A deadlock, serialization failure or `ER_CHECKREAD` (1020) of the dispatcher is retried at once, up to 3 times, before it is reported; a lock wait timeout is reported at once.                                                                |
| `schedule_fired`        | `scheduleId`, `jobName`, `scheduledAt`, `late`, `jobId`   | A slot of a [schedule](#schedule) was decided. Only the process that decided it emits it, so the cluster gets one event per slot. `late` is true for a catch-up. `jobId` is `null` when `overlap: 'skip'` skipped the slot. It has no `attempt`.                                                                                                      |

`durationMs` is the run time of the handler in milliseconds. `error` is the thrown value, of type `unknown`.

New event types may be added in minor versions. Handle unknown types in a `default` branch.

```js
const sqlane = createSqlane({
    adapter,
    onEvent: (event) => {
        if (event.type === 'failed') {
            metrics.increment('jobs.failed', { name: event.jobName });
        }
    },
});
```

## `FailedJobPayload`

`FailedJobPayload` is the type of the payload of a failure job.

```ts
interface FailedJobPayload {
    job: { id: string, name: string, payload: any, attempt: number, maxAttempts: number };
    error: JobError; // { name: string, message: string, stack?: string, code?: string }
}
```

The `job` field describes the job that failed, with its original payload. Its `maxAttempts` is set at enqueue; a
`one_more` retry changes it. The `error` field describes the last error,
as a [`JobError`](#jobrecord). sqlane cuts `error.stack` to 8,192 UTF-16 code units. When the error has a string
`code` property, `error` also has a `code` field. The payload of a failure job is exempt from `maxPayloadBytes`.

The failure job is an ordinary job, so it gets its options from its own definition. It never has a failure job of its
own, and `unknownJobs: 'reject'` does not apply to it.

```js
/** @type {import('@sqlane/core').JobDefinition<import('@sqlane/core').FailedJobPayload>} */
export const reportFailed = defineJob({ name: 'report_failed' });

sqlane.handle(reportFailed, async ({ payload }) => {
    await alert(`${payload.job.name} ${payload.job.id} failed: ${payload.error.message}`);
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
a job name, or `*` for all names. sqlane does not wait for `publish`. If `publish` fails, sqlane emits an `error` event,
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
