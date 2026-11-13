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
- [`defineConcurrencyGroup`](#defineconcurrencygroup)
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
- [`wake`](#wake)
- [Errors](#errors)
- [Events](#events)
- [`FailedJobPayload`](#failedjobpayload)
- [`Hint`](#hint)
- [Adapters](#adapters)

## Terms

| Term              | Meaning                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job               | One unit of work. It is one row in the database, with a payload, a state and a number of attempts.                                                                               |
| Job name          | The kind of a job, for example `build_report`. The job name is also the queue, because sqlane has no separate queue object.                                                      |
| Job definition    | The name and the options of a job name. You create it with `defineJob`. Producers and workers import the same definition.                                                        |
| Handler           | The function that runs a job. Only workers register handlers.                                                                                                                    |
| Concurrency group | A limit on the handlers of several job names that run at the same time in one instance. You create it with `defineConcurrencyGroup`.                                             |
| Fair share weight | The share of the free slots that a job name gets, against the other due names: `fairShareWeight`, default 1.                                                                     |
| Lease             | The time for which a process owns a running job. The process renews the lease while the handler runs. If the process stops, the lease ends and another process can take the job. |
| Stall             | A stall happens when the lease of a running job ends because its process stopped or blocked. sqlane then puts the job back in the queue.                                         |
| Mutex key         | A string such as `order:42`. Two jobs that share a mutex key never run at the same time in the whole cluster, as long as handlers stop when their `signal` aborts.               |
| Failure job       | A job that sqlane adds when another job fails for good. It lets you react to the failure, for example by sending an alert.                                                       |
| Adapter           | The object that connects sqlane to your database driver or ORM.                                                                                                                  |
| Hint              | A message that tells other processes that jobs of a name are ready. Hints only make jobs start sooner. If a hint is lost, the job still runs at the next poll.                   |
| Schedule          | A cron or an interval that adds a job of a name at each of its times. You add it with `schedule()`.                                                                              |
| Slot              | One time of a schedule. Each slot adds at most one job, whose id is `<job name>:schedule:[<key>:]<ISO time>`.                                                                    |

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

| Option        | Type                                          | Default                                                             | Description                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | `string`                                      | Required                                                            | The job name. It must match `^[a-z][a-z0-9_.-]{0,127}$`, so it cannot contain `:`. It is case-sensitive.                                                                                                                                                                                                                                                         |
| `maxAttempts` | integer, at least 1                           | `3`                                                                 | The number of times a job runs before it fails for good.                                                                                                                                                                                                                                                                                                         |
| `maxStalls`   | integer, at least 0                           | `2`                                                                 | The number of stalls that a job survives. The next stall after this number fails the job for good.                                                                                                                                                                                                                                                               |
| `backoff`     | [`Backoff`](#backoff)                         | `{ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 }` | The wait before the next attempt after a failed attempt.                                                                                                                                                                                                                                                                                                         |
| `retention`   | `{ completed?: Duration, failed?: Duration }` | `{ completed: '1h', failed: '30d' }`                                | How long sqlane keeps a completed or a failed job before it deletes the row. A `jobId` blocks duplicates while the row exists. That is while the job is pending or running, then during this retention, until the next cleanup. A started process runs the cleanup every 5 minutes. If every process sets `cleanup: false`, the rows stay until you delete them. |
| `timeout`     | positive duration                             | None                                                                | The time after which sqlane aborts the handler. A definition with `mutexKeys` needs a timeout, either here, in the `handle()` options or in the instance `defaults`.                                                                                                                                                                                             |
| `mutexKeys`   | `(payload: P) => readonly string[]`           | None                                                                | A function that returns the mutex keys of a job. It must be synchronous and use only the payload. sqlane calls it at enqueue, with the payload as JSON gives it back.                                                                                                                                                                                            |
| `failureJob`  | `string` or `JobDefinition`                   | None                                                                | The job name that sqlane adds when a job of this name fails for good. A job cannot be its own failure job. The failure job cannot have a `failureJob` of its own. Its payload is a [`FailedJobPayload`](#failedjobpayload).                                                                                                                                      |

`defineJob` throws a `ConfigError` if an option is unknown or has a bad value. It does not check whether a
definition with mutex keys has a timeout, because `handle()` checks that.

```js
import { defineJob } from '@sqlane/core';

export const syncOrder = defineJob({
    name: 'sync_order',
    maxAttempts: 5,
    mutexKeys: (payload) => [`order:${payload.orderId}`],
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
type. The handler's `payload` and the argument of `mutexKeys` also get this type.

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
of 4.x throw a `ConfigError` that names the new one: `concurrency` is now `maxConcurrency`, and `lanes` became
[concurrency groups](#defineconcurrencygroup).

| Option            | Type                           | Default     | Description                                                                                                                                                                                           |
| ----------------- | ------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter`         | `Adapter<C>`                   | Required    | The adapter of your driver or ORM, created over the queue's own pool. sqlane uses this pool to claim jobs, renew leases and write results. See [Adapters](#adapters).                                 |
| `jobs`            | `readonly JobDefinition[]`     | `[]`        | The definitions that this instance knows by name. List every definition here, so that an enqueue by name finds its options. Two different definitions with one name throw a `ConfigError`.            |
| `maxConcurrency`  | integer, at least 1            | `10`        | The highest number of handlers that run at the same time in this instance. The free slots are [shared by weight](#how-free-slots-are-shared).                                                         |
| `defaults`        | `JobDefaults`                  | See below   | Defaults for `maxAttempts`, `maxStalls`, `backoff`, `retention` and `timeout`. A definition overrides them.                                                                                           |
| `unknownJobs`     | `'allow'` or `'reject'`        | `'allow'`   | With `'reject'`, `enqueue` rejects with an `UnknownJobError` for a job name that is neither in `jobs` nor handled.                                                                                    |
| `hint`            | [`Hint`](#hint) or `null`      | `null`      | A publish/subscribe service that wakes other processes after an enqueue. With `null`, other processes find new jobs at their next poll. You cannot combine it with the `notify` option of an adapter. |
| `logger`          | `Logger`                       | None        | A pino-compatible logger with `debug`, `info`, `warn` and `error` methods. Each method takes an object and an optional message. Without a logger, sqlane writes no logs.                              |
| `onEvent`         | `(event: SqlaneEvent) => void` | None        | A function that receives the [events](#events) of the job lifecycle. If it throws, sqlane logs the error and goes on.                                                                                 |
| `tablePrefix`     | `string`                       | `'sqlane_'` | The prefix of the table names. It must match `^[a-z][a-z0-9_]{0,31}$`.                                                                                                                                |
| `pollInterval`    | positive duration              | `'5s'`      | How often a started process checks the database for due jobs when nothing wakes it.                                                                                                                   |
| `maxPayloadBytes` | integer, at least 1            | `262144`    | The largest payload, in bytes of JSON. The default is 256 KiB.                                                                                                                                        |
| `cleanup`         | `boolean`                      | `true`      | When it is `true`, a started process deletes the completed and failed jobs after their retention.                                                                                                     |

The built-in job defaults are `maxAttempts: 3`, `maxStalls: 2`, the default [backoff](#backoff),
`retention: { completed: '1h', failed: '30d' }` and no timeout.

```js
import { createSqlane } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';

const sqlane = createSqlane({
    adapter: mysql2Adapter(queuePool),
    jobs: [buildReport, syncOrder],
    maxConcurrency: 10,
    defaults: { timeout: '10m' },
    unknownJobs: 'reject',
});
```

## `defineConcurrencyGroup`

`defineConcurrencyGroup` defines a cap shared by the handlers of several job names.

```ts
defineConcurrencyGroup(options: { name: string, maxConcurrency: number }): ConcurrencyGroup
```

Pass the group to `handle()` as `concurrencyGroup`. The jobs of all its names that run at the same time in one instance
stay at or below its `maxConcurrency`. Each instance counts its own handlers: a group is not a limit in the whole
cluster. Define the group at module level, like a job definition, and use the same object in every `handle()` call.
The group is a frozen object.

| Option           | Type                | Description                                               |
| ---------------- | ------------------- | --------------------------------------------------------- |
| `name`           | `string`            | It must match `^[a-z][a-z0-9_.-]{0,127}$`.                |
| `maxConcurrency` | integer, at least 1 | The most jobs of the names of the group that run at once. |

`defineConcurrencyGroup` throws a `ConfigError` for an unknown option, a bad name or a bad `maxConcurrency`.
`handle()` throws a `ConfigError` for two different groups with one name in one instance. `start()` and `drain()`
throw one for a group whose `maxConcurrency` is above the instance's.

```js
import { defineConcurrencyGroup } from '@sqlane/core';

export const heavy = defineConcurrencyGroup({ name: 'heavy', maxConcurrency: 2 });

sqlane.handle(transcode, work, { concurrencyGroup: heavy, maxConcurrency: 1, fairShareWeight: 2 });
sqlane.handle(render, work, { concurrencyGroup: heavy });
```

## Where job options come from

A job gets each option from the first place that sets it, in this order:

1. The options of the `enqueue` call.
2. The job definition. For an enqueue by name, sqlane uses the definition in `jobs`, or the definition that `handle()`
   registered.
3. The `defaults` of `createSqlane`.
4. The built-in defaults.

`retention` is merged field by field, so you can override only `completed` or only `failed`. `backoff` and `timeout`
are not enqueue options. The backoff comes from the definition of the handler, else from `defaults`. The timeout
comes from the `handle()` options, else from the definition, else from `defaults`.

sqlane fixes the options of a job when you enqueue it. A later change to a definition does not change the jobs that
already exist.

## `enqueue`

`enqueue` adds one job, with your connection, in your transaction.

```ts
sqlane.enqueue(connection: C, job: JobDefinition | string, payload: P, options?: EnqueueOptions): Promise<EnqueueResult>
```

The `connection` is the raw connection of your driver or ORM, as the [adapter](#adapters) defines it. If it is a
connection or a transaction client, it must be in a transaction, because sqlane cannot always detect one. If it is a
pool, sqlane runs the insert in a transaction of its own, outside of any transaction of yours.

The `job` is a definition or a job name. If you pass a name, sqlane looks for its definition in `jobs` and in the
handled names. If it finds none, the job gets the defaults, and `mutexKeys` and `failureJob` come only from the
enqueue options.

The `payload` must be JSON. sqlane rejects a payload that `JSON.stringify` cannot write, a string that is not
well-formed UTF-16, and a NUL character (`\u0000`), because PostgreSQL refuses it. The handler gets the payload as
JSON gives it back, so a `Date` would arrive as a string. The TypeScript types reject a `Date`, a `Map`, a `Set`, a
function, a `bigint` and a class instance with methods.

| Option        | Type                                          | Default                        | Description                                                                                                                                                                                                                                                                 |
| ------------- | --------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobId`       | `string`                                      | None                           | An id that prevents duplicates. It has 1 to 120 printable ASCII characters, without spaces at the ends. While a job with this id and name exists, a second enqueue adds nothing. It cannot start with `schedule:`, which is reserved for the slots of schedules.            |
| `slot`        | `{ at: Date, key?: string }`                  | None                           | Runs a slot of a [schedule](#schedule) by hand: the job gets the id that the scheduler gives the slot. `at` is in the years 1970 to 9999, and `key` is the key of the schedule. You cannot combine it with `jobId`. The job is due now, unless you give `delay` or `runAt`. |
| `delay`       | `Duration`                                    | `0`                            | The wait before the job becomes due. You cannot combine it with `runAt`.                                                                                                                                                                                                    |
| `runAt`       | `Date`                                        | None                           | The time at which the job becomes due. You cannot combine it with `delay`.                                                                                                                                                                                                  |
| `maxAttempts` | integer, at least 1                           | From the definition            | Overrides `maxAttempts` for this job.                                                                                                                                                                                                                                       |
| `maxStalls`   | integer, at least 0                           | From the definition            | Overrides `maxStalls` for this job.                                                                                                                                                                                                                                         |
| `retention`   | `{ completed?: Duration, failed?: Duration }` | From the definition            | Overrides the retention for this job, field by field.                                                                                                                                                                                                                       |
| `failureJob`  | `string` or `JobDefinition`                   | From the definition            | Overrides the failure job for this job.                                                                                                                                                                                                                                     |
| `mutexKeys`   | `readonly string[]`                           | From the definition's function | Replaces the keys that the definition computes. An empty array removes all keys.                                                                                                                                                                                            |

A job can have at most 10 mutex keys. Each key has 1 to 255 printable ASCII characters, without spaces at the ends.
sqlane removes duplicate keys before it counts them. Keys are global, so jobs of different names can share a key.

`enqueue` resolves to an `EnqueueResult`:

| Field     | Type      | Description                                                                                                                                        |
| --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | `string`  | The job id. It is `<job name>:<jobId>` when you give a `jobId`, `<job name>:schedule:[<key>:]<ISO time>` with `slot`, and a new ULID with neither. |
| `created` | `boolean` | It is `false` when a job with this `jobId` (or of this `slot`) exists already. In that case sqlane added nothing.                                  |

`enqueue` checks everything before it writes, and it rejects with these errors:

- `InvalidOptionsError` for a bad job, a bad option, `delay` together with `runAt`, `slot` together with `jobId`, a
  `jobId` that starts with `schedule:`, or a payload that is not JSON.
- `PayloadTooLargeError` if the payload is larger than `maxPayloadBytes`.
- `InvalidMutexKeyError` if a mutex key breaks the rules above.
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
sqlane.handle(job: JobDefinition | string, handler: (context: HandlerContext<P>) => unknown, options?: HandleOptions): void
```

Register all the handlers before you call `start()`. The return value of the handler is ignored. sqlane does not wrap
the handler in a transaction, so a handler that needs one opens it with its own connection.

| Option             | Type                                          | Default                    | Description                                                                                                                     |
| ------------------ | --------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrency`   | integer, at least 1                           | None                       | The most jobs of this name that run at once in this instance. Without it, only the caps of its group and of the instance apply. |
| `concurrencyGroup` | [`ConcurrencyGroup`](#defineconcurrencygroup) | None                       | A cap shared with the other names of the group. One group per handler. It combines with `maxConcurrency`.                       |
| `fairShareWeight`  | integer, 1 to 1000                            | `1`                        | The name's share of the free slots, against the other due names. See [How free slots are shared](#how-free-slots-are-shared).   |
| `timeout`          | positive duration                             | The definition's `timeout` | The time after which sqlane aborts the handler. It overrides the timeout of the definition and of `defaults`.                   |

`handle` throws a `ConfigError` in these cases:

- The options are unknown or bad, or the group is not from `defineConcurrencyGroup()`. The options of 4.x name the new
  ones: `concurrency` is now `maxConcurrency`, and `lane` is now `concurrencyGroup`.
- Another concurrency group has the same name in this instance.
- The job name already has a handler.
- `jobs` holds a different definition with the same name.
- The definition has `mutexKeys`, but no timeout is set in the `handle()` options, the definition or `defaults`.
- `start()` was called before, or `drain()` runs.

`start()` and `drain()` throw a `ConfigError` for a handler whose `maxConcurrency` is above the instance's, for
example `start(): the maxConcurrency of handle("transcode") (16) is above the instance's maxConcurrency (10)`. They
check all the handlers together, so the order of the `handle()` calls does not matter.

`handle` throws a `ClosedError` after `close()`.

### The handler context

The handler receives one object with three fields:

| Field     | Type          | Description                                                                                               |
| --------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `payload` | `P`           | The payload, as JSON gives it back. Its type is the declared payload type, or `any` without one.          |
| `job`     | `JobInfo`     | Information about the job (see below).                                                                    |
| `signal`  | `AbortSignal` | A signal that aborts when the handler must stop. Pass it to `fetch` and other APIs, or check it in loops. |

The `job` object has these fields:

| Field         | Type                | Description                                                                                  |
| ------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `id`          | `string`            | The job id.                                                                                  |
| `name`        | `string`            | The job name.                                                                                |
| `attempt`     | `number`            | The current attempt. It is 1 for the first run.                                              |
| `maxAttempts` | `number`            | The highest number of attempts for this job.                                                 |
| `enqueuedAt`  | `Date`              | The time of the enqueue.                                                                     |
| `mutexKeys`   | `readonly string[]` | The mutex keys of the job, sorted.                                                           |
| `scheduledAt` | `Date` or `null`    | The slot of a job of a [schedule](#schedule), also when it runs late. `null` for other jobs. |

The `signal.reason` tells you why the signal aborted:

- A `JobTimeoutError` means that the timeout has passed. The attempt fails with this error, even if the handler
  finishes later.
- A `LeaseLostError` means that the process could not renew the lease until 30 s before it ends, for example because
  the database is unreachable. The process then also emits `lease_lost`. Another process may now run the job.
- A `ShutdownError` means that `close()` reached its deadline.

JavaScript cannot stop a running function. After a timeout, the job keeps its mutex keys and its slot until the
handler settles, but for at most one more lease (4 minutes). Your handler should therefore stop soon after the signal
aborts.

A handler finishes in one of these ways:

- If it returns or resolves, the job completes.
- If it throws, sqlane retries the job after the backoff. When no attempts are left, the job fails for good, and its
  failure job is added.
- If it throws a [`RetryJobError`](#errors-that-handlers-throw), sqlane retries the job after the delay of the error.
- If it throws a [`FatalJobError`](#errors-that-handlers-throw), the job fails for good at once.

```js
sqlane.handle(buildReport, async ({ payload, job, signal }) => {
    await generateReport(payload.reportId, { signal });
}, { concurrencyGroup: heavy, timeout: '5m' });
```

## How free slots are shared

A process runs at most `maxConcurrency` handlers at once. When slots are free and several job names have due jobs, a
free slot goes to the due name with the lowest `running / fairShareWeight`. `running` counts the jobs of the name that
run in this instance, retries included. The name must be under its own `maxConcurrency`, its group's and the
instance's. Ties go round-robin.

- **Within a name**, jobs start in FIFO order: `run_at`, then the id. The FIFO per mutex key stays as before.
- **A name is not in the race, and banks nothing,** while it has no due job, its due jobs wait for mutex keys, or it is
  at one of its caps. The rule keeps no history: only the running counts of the moment.
- **The shares are per instance.** Each process shares its own slots.
- **Not oldest first across names.** In 4.x, the oldest due job across names started first. Now a busy name cannot
  crowd out the others.
- **A name woken by the release of a mutex key** competes by its share, like any other name. If it loses the slot, its
  job keeps its place in the FIFO of the key.

With weights 3 and 1 on 8 slots, and both names busy, 6 jobs of the first name and 2 of the second run. When a job
ends, its slot goes back to its own name.

**The rule equalizes the running counts, not the order of the starts.** Take A's 10 jobs, then B's 3, with equal
weights and `maxConcurrency: 4`. A1 to A4 start first.

- When the 4 jobs end together, the next claims take `{A5, B1, A6, B2}`, then `{B3, A7, A8, A9}`.
- When the slots free one at a time, B first catches up to its share: `B1 B2 A5 A6 B3 …`.

**The odd remainder.** When a share is not a whole number of slots, the extra slot goes to a name at each tie, not by
time. So a name with long jobs keeps it longer. With jobs of 10 s against 1 s, equal weights and 3 slots, the long
jobs take 63.5 % of the slot time and the short ones 36.5 %: 1.9 and 1.1 slots, against 1.5 each. The error stays
below one slot. With 4 or 8 slots, each name gets exactly half.

**Very short jobs.** Shares count running handlers. A name whose jobs take a few milliseconds loses the short gap
between a completion and the next claim, so its measured slot time is a little below its share.

**Groups.** Take T (weight 2, `maxConcurrency: 1`) and R (weight 1) in a group `heavy` of 2, and E (weight 3), on 10
slots. T and R each run 1 job, and E runs 8. With `heavy` at 4, R and E share the 9 slots that T leaves by 1:3.

**The slots of names with mutex keys.** A claim first finds the jobs of names with mutex keys whose keys are free, and
leaves them their share of the free slots, of the instance and of their groups. If another process takes those jobs
first, the slots stay free until the next turn, which comes at once.

## `schedule`

`schedule` adds a job at each time of a cron in a time zone, or at a fixed interval.

```ts
sqlane.schedule(job: JobDefinition | string, options: ScheduleOptions): void
```

Each time of a schedule is a **slot**. At each slot, every started process that has the schedule tries to add the
job. A row per schedule in the table `sqlane_schedules` lets one of them add it. So each slot adds at most one job in
the whole cluster, with no leader. A scheduled job is an ordinary job: its definition gives its retries, backoff,
timeout, mutex keys, failure job and retention.

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
above `maxPayloadBytes`, and bad mutex keys of the definition throw a `ConfigError`. So a bad payload fails at deploy
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

| Need                                             | How                                                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs may overlap                                 | The default, `overlap: 'allow'`.                                                                                                                                                       |
| Skip a slot while the previous run is not done   | `overlap: 'skip'`. "Not done" means that the last job of the schedule is pending or running, retries included.                                                                         |
| Queue the slot and run it after the previous one | A constant mutex key in the definition, such as `mutexKeys: () => ['nightly_report']`, with a `timeout`. The runs wait in line. They pile up if every run is slower than the interval. |

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
| `exitsBy`  | `Duration`                 | The deadline plus one lease (`'4m30s'` with the default deadline) | The latest time at which the process exits, counted from the call. A released job whose handler still runs waits until this time plus 2 seconds before it runs again, and its mutex keys stay held until then. |

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

`migrate` rejects with an `InvalidOptionsError` for a bad `lockTimeout`. If you prefer your own migration tool, use
[`getMigrations`](#getmigrations) instead.

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

A growing `oldestDueAgeMs` usually means that no process handles the name, or that the workers cannot keep up.

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

| Class                       | `code`                   | When                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ConfigError`               | `CONFIG`                 | The options of `createSqlane`, `defineJob`, `handle()`, `schedule()`, an adapter or `getMigrations` are bad. `start()` and `drain()` also throw it for a bad failure job. `start()` throws it for a bad schedule, or a missing table of the schedules. |
| `InvalidOptionsError`       | `INVALID_OPTIONS`        | The arguments of `enqueue` or `enqueueMany` are bad, for example a bad name or `jobId`, a `jobId` with the reserved prefix `schedule:`, `slot` with `jobId`, `delay` with `runAt`, or a payload that is not JSON.                                      |
| `PayloadTooLargeError`      | `PAYLOAD_TOO_LARGE`      | The payload is larger than `maxPayloadBytes`.                                                                                                                                                                                                          |
| `InvalidMutexKeyError`      | `INVALID_MUTEX_KEY`      | A job has more than 10 mutex keys, or a key breaks the rules.                                                                                                                                                                                          |
| `UnknownJobError`           | `UNKNOWN_JOB`            | `enqueue` got an unknown job name, and `unknownJobs` is `'reject'`.                                                                                                                                                                                    |
| `ClosedError`               | `CLOSED`                 | `start`, `handle`, `schedule` or `drain` was called after `close()`.                                                                                                                                                                                   |
| `DrainTimeoutError`         | `DRAIN_TIMEOUT`          | `drain()` did not finish within its `timeout`.                                                                                                                                                                                                         |
| `JobTimeoutError`           | `JOB_TIMEOUT`            | The handler's `signal` aborted because the timeout passed. It is also the error of the attempt.                                                                                                                                                        |
| `ShutdownError`             | `SHUTDOWN`               | The handler's `signal` aborted because `close()` reached its deadline.                                                                                                                                                                                 |
| `LeaseLostError`            | `LEASE_LOST`             | The handler's `signal` aborted because the process could not renew the lease until 30 s before it ends, for example because the database is unreachable.                                                                                               |
| `MissingPayloadError`       | `MISSING_PAYLOAD`        | sqlane did not find the payload of a job. The job fails for good with this error.                                                                                                                                                                      |
| `MigrationLockTimeoutError` | `MIGRATION_LOCK_TIMEOUT` | `migrate()` did not get the migration lock within its `lockTimeout`.                                                                                                                                                                                   |
| `FatalJobError`             | `FATAL_JOB`              | A handler threw it to fail the job at once. See below.                                                                                                                                                                                                 |
| `RetryJobError`             | `RETRY_JOB`              | A handler threw it to retry the job after a given delay. See below.                                                                                                                                                                                    |

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

A handler can throw two special errors to control what happens next.

`FatalJobError` fails the job at once, without retries. If the job has a failure job, sqlane adds it.

```ts
new FatalJobError(message: string, options?: { cause?: unknown })
```

`RetryJobError` retries the job after `delay`, instead of after the backoff. This is useful for a rate limit. The retry
still uses an attempt, so the job fails for good if no attempts are left. If `delay` is not a valid duration, sqlane
uses the backoff.

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

    if (response.status === 429) {
        throw new RetryJobError('Rate limited', { delay: '1m' });
    }
}, { timeout: '5m' });
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

| `type`                  | Extra fields                                            | When                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimed`               | None                                                    | This process claimed the job and starts its handler.                                                                                                                                                                                                                                   |
| `completed`             | `durationMs`                                            | The job completed.                                                                                                                                                                                                                                                                     |
| `retried`               | `durationMs`, `delayMs`, `error`                        | The attempt failed, and the job will run again after `delayMs`.                                                                                                                                                                                                                        |
| `failed`                | `durationMs`, `error`                                   | The job failed for good. Stall recovery also emits it when a job stalls too often. `durationMs` is then the time from the start of the run that stalled until its recovery.                                                                                                            |
| `timed_out`             | `durationMs`                                            | The handler ran longer than its timeout, and its `signal` aborted.                                                                                                                                                                                                                     |
| `stalled`               | None                                                    | Stall recovery found a job whose lease had ended, and put it back in the queue.                                                                                                                                                                                                        |
| `released`              | None                                                    | `close()` released an unfinished job in `'release'` mode.                                                                                                                                                                                                                              |
| `lease_lost`            | None                                                    | This process could not renew the lease of the job until 30 s before it ends, and aborted its `signal`.                                                                                                                                                                                 |
| `failure_job_not_added` | `failureJob`, `error`                                   | The job failed for good, but the database refused to add its failure job.                                                                                                                                                                                                              |
| `error`                 | `operation`, `error`                                    | An internal operation failed, for example a poll or a hint. `operation` names it. sqlane also logs it. A deadlock, serialization failure or `ER_CHECKREAD` (1020) of the dispatcher is retried at once, up to 3 times, before it is reported; a lock wait timeout is reported at once. |
| `schedule_fired`        | `scheduleId`, `jobName`, `scheduledAt`, `late`, `jobId` | A slot of a [schedule](#schedule) was decided. Only the process that decided it emits it, so the cluster gets one event per slot. `late` is true for a catch-up. `jobId` is `null` when `overlap: 'skip'` skipped the slot. It has no `attempt`.                                       |

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
    error: { name: string, message: string, stack?: string, code?: string };
}
```

The `job` field describes the job that failed, with its original payload. The `error` field describes the last error.
sqlane cuts `error.stack` to 8 KiB. When the error has a string `code` property, `error` also has a `code` field. The payload of a failure job is exempt from `maxPayloadBytes`.

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

| Import                             | Function                                    | Library                                                                   |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `@sqlane/core/adapter-mysql2`      | `mysql2Adapter(pool, { dialect? })`         | [mysql2](adapters.md#mysql2)                                              |
| `@sqlane/core/adapter-pg`          | `pgAdapter(pool, { notify? })`              | [pg](adapters.md#pg) (node-postgres)                                      |
| `@sqlane/core/adapter-postgres-js` | `postgresJsAdapter(sql, { notify? })`       | [postgres.js](adapters.md#postgresjs)                                     |
| `@sqlane/core/adapter-knex`        | `knexAdapter(knex, { dialect? })`           | [Knex](adapters.md#knex), with mysql2, mariadb or pg                      |
| `@sqlane/core/adapter-kysely`      | `kyselyAdapter(db, { dialect })`            | [Kysely](adapters.md#kysely)                                              |
| `@sqlane/core/adapter-drizzle`     | `drizzleAdapter(db, { notify?, dialect? })` | [Drizzle](adapters.md#drizzle), with mysql2, node-postgres or postgres.js |
| `@sqlane/core/adapter-prisma`      | `prismaAdapter(prisma, { dialect })`        | [Prisma](adapters.md#prisma)                                              |
| `@sqlane/core/adapter-sequelize`   | `sequelizeAdapter(sequelize, { dialect? })` | [Sequelize](adapters.md#sequelize)                                        |
| `@sqlane/core/adapter-typeorm`     | `typeOrmAdapter(dataSource)`                | [TypeORM](adapters.md#typeorm)                                            |
| `@sqlane/core/adapter-mikro-orm`   | `mikroOrmAdapter(em, { dialect })`          | [MikroORM](adapters.md#mikroorm)                                          |

The `dialect` option is `'mysql'`, `'mariadb'` or `'postgres'`. Kysely, Prisma and MikroORM need it because they do not
expose the database. The adapters over mysql2 (mysql2, Knex, Drizzle and Sequelize) take an optional `dialect`:
`'mysql'` (the default) or `'mariadb'`. Over the mariadb driver (Knex and Sequelize), the database is MariaDB. TypeORM
reads it from the `type` of the DataSource. See [MariaDB](adapters.md#mariadb). The `notify` option is for PostgreSQL only. When it is `true`, sqlane sends hints with LISTEN/NOTIFY, and you
must not set the `hint` option. An adapter throws a `ConfigError` if it gets an object or a version that it does not
support.
