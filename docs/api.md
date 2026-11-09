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
- [Where job options come from](#where-job-options-come-from)
- [`enqueue`](#enqueue)
- [`enqueueMany`](#enqueuemany)
- [`handle`](#handle)
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

| Term           | Meaning                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job            | One unit of work. It is one row in the database, with a payload, a state and a number of attempts.                                                                               |
| Job name       | The kind of a job, for example `build_report`. The job name is also the queue, because sqlane has no separate queue object.                                                      |
| Job definition | The name and the options of a job name. You create it with `defineJob`. Producers and workers import the same definition.                                                        |
| Handler        | The function that runs a job. Only workers register handlers.                                                                                                                    |
| Lane           | A limit on the number of handlers that run at the same time in one process. Several job names can share one lane.                                                                |
| Lease          | The time for which a process owns a running job. The process renews the lease while the handler runs. If the process stops, the lease ends and another process can take the job. |
| Stall          | A stall happens when the lease of a running job ends because its process stopped or blocked. sqlane then puts the job back in the queue.                                         |
| Mutex key      | A string such as `order:42`. Two jobs that share a mutex key never run at the same time in the whole cluster, as long as handlers stop when their `signal` aborts.               |
| Failure job    | A job that sqlane adds when another job fails for good. It lets you react to the failure, for example by sending an alert.                                                       |
| Adapter        | The object that connects sqlane to your database driver or ORM.                                                                                                                  |
| Hint           | A message that tells other processes that jobs of a name are ready. Hints only make jobs start sooner. If a hint is lost, the job still runs at the next poll.                   |

## Durations

Many options take a duration. A duration is either a number of milliseconds or a string such as `'500ms'`, `'5s'`,
`'4m30s'`, `'1h'` or `'2 days'`. sqlane reads the strings with the
[parse-duration](https://www.npmjs.com/package/parse-duration) package. A number must be a non-negative integer.

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

`defineJob` throws a `ConfigError` if an option is unknown or has a bad value. It does not check whether a keyed
definition has a timeout, because `handle()` checks that.

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
createSqlane<C, L extends string = never>(options: SqlaneOptions<C, L>): Sqlane<C, L>
```

The type `C` is the connection type that `enqueue` accepts, and it comes from the adapter. The type `L` is the union
of the lane names in `lanes`. `createSqlane` does not connect, migrate or start anything. It throws a `ConfigError` if
an option is unknown or has a bad value.

| Option            | Type                                 | Default     | Description                                                                                                                                                                                           |
| ----------------- | ------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter`         | `Adapter<C>`                         | Required    | The adapter of your driver or ORM, created over the queue's own pool. sqlane uses this pool to claim jobs, renew leases and write results. See [Adapters](#adapters).                                 |
| `jobs`            | `readonly JobDefinition[]`           | `[]`        | The definitions that this instance knows by name. List every definition here, so that an enqueue by name finds its options. Two different definitions with one name throw a `ConfigError`.            |
| `concurrency`     | integer, at least 1                  | `10`        | The highest number of handlers that run at the same time in this process.                                                                                                                             |
| `lanes`           | `Record<L, { concurrency: number }>` | `{}`        | Named lanes. Each lane limits the handlers that use it. A lane's concurrency is capped by the process `concurrency`.                                                                                  |
| `defaults`        | `JobDefaults`                        | See below   | Defaults for `maxAttempts`, `maxStalls`, `backoff`, `retention` and `timeout`. A definition overrides them.                                                                                           |
| `unknownJobs`     | `'allow'` or `'reject'`              | `'allow'`   | With `'reject'`, `enqueue` rejects with an `UnknownJobError` for a job name that is neither in `jobs` nor handled.                                                                                    |
| `hint`            | [`Hint`](#hint) or `null`            | `null`      | A publish/subscribe service that wakes other processes after an enqueue. With `null`, other processes find new jobs at their next poll. You cannot combine it with the `notify` option of an adapter. |
| `logger`          | `Logger`                             | None        | A pino-compatible logger with `debug`, `info`, `warn` and `error` methods. Each method takes an object and an optional message. Without a logger, sqlane writes no logs.                              |
| `onEvent`         | `(event: SqlaneEvent) => void`       | None        | A function that receives the [events](#events) of the job lifecycle. If it throws, sqlane logs the error and goes on.                                                                                 |
| `tablePrefix`     | `string`                             | `'sqlane_'` | The prefix of the table names. It must match `^[a-z][a-z0-9_]{0,31}$`.                                                                                                                                |
| `pollInterval`    | positive duration                    | `'5s'`      | How often a started process checks the database for due jobs when nothing wakes it.                                                                                                                   |
| `maxPayloadBytes` | integer, at least 1                  | `262144`    | The largest payload, in bytes of JSON. The default is 256 KiB.                                                                                                                                        |
| `cleanup`         | `boolean`                            | `true`      | When it is `true`, a started process deletes the completed and failed jobs after their retention.                                                                                                     |

The built-in job defaults are `maxAttempts: 3`, `maxStalls: 2`, the default [backoff](#backoff),
`retention: { completed: '1h', failed: '30d' }` and no timeout.

```js
import { createSqlane } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';

const sqlane = createSqlane({
    adapter: mysql2Adapter(queuePool),
    jobs: [buildReport, syncOrder],
    concurrency: 10,
    lanes: { heavy: { concurrency: 2 } },
    defaults: { timeout: '10m' },
    unknownJobs: 'reject',
});
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

| Option        | Type                                          | Default                        | Description                                                                                                                                                                      |
| ------------- | --------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobId`       | `string`                                      | None                           | An id that prevents duplicates. It has 1 to 120 printable ASCII characters, without spaces at the ends. While a job with this id and name exists, a second enqueue adds nothing. |
| `delay`       | `Duration`                                    | `0`                            | The wait before the job becomes due. You cannot combine it with `runAt`.                                                                                                         |
| `runAt`       | `Date`                                        | None                           | The time at which the job becomes due. You cannot combine it with `delay`.                                                                                                       |
| `maxAttempts` | integer, at least 1                           | From the definition            | Overrides `maxAttempts` for this job.                                                                                                                                            |
| `maxStalls`   | integer, at least 0                           | From the definition            | Overrides `maxStalls` for this job.                                                                                                                                              |
| `retention`   | `{ completed?: Duration, failed?: Duration }` | From the definition            | Overrides the retention for this job, field by field.                                                                                                                            |
| `failureJob`  | `string` or `JobDefinition`                   | From the definition            | Overrides the failure job for this job.                                                                                                                                          |
| `mutexKeys`   | `readonly string[]`                           | From the definition's function | Replaces the keys that the definition computes. An empty array removes all keys.                                                                                                 |

A job can have at most 10 mutex keys. Each key has 1 to 255 printable ASCII characters, without spaces at the ends.
sqlane removes duplicate keys before it counts them. Keys are global, so jobs of different names can share a key.

`enqueue` resolves to an `EnqueueResult`:

| Field     | Type      | Description                                                                                     |
| --------- | --------- | ----------------------------------------------------------------------------------------------- |
| `id`      | `string`  | The job id. It is `<job name>:<jobId>` when you give a `jobId`, and a new ULID when you do not. |
| `created` | `boolean` | It is `false` when a job with this `jobId` exists already. In that case sqlane added nothing.   |

`enqueue` checks everything before it writes, and it rejects with these errors:

- `InvalidOptionsError` for a bad job, a bad option, `delay` together with `runAt`, or a payload that is not JSON.
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

| Option        | Type                | Default                    | Description                                                                                                             |
| ------------- | ------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `concurrency` | integer, at least 1 | None                       | Gives the handler a private lane with this limit. The process `concurrency` caps it. You cannot combine it with `lane`. |
| `lane`        | a name in `lanes`   | None                       | Makes the handler share this lane with other handlers. You cannot combine it with `concurrency`.                        |
| `timeout`     | positive duration   | The definition's `timeout` | The time after which sqlane aborts the handler. It overrides the timeout of the definition and of `defaults`.           |

Without `concurrency` or `lane`, only the process `concurrency` limits the handler.

`handle` throws a `ConfigError` in these cases:

- The options are unknown or bad, the lane is unknown, or both `lane` and `concurrency` are set.
- The job name already has a handler.
- `jobs` holds a different definition with the same name.
- The definition has `mutexKeys`, but no timeout is set in the `handle()` options, the definition or `defaults`.
- `start()` was called before.

`handle` throws a `ClosedError` after `close()`.

### The handler context

The handler receives one object with three fields:

| Field     | Type          | Description                                                                                               |
| --------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `payload` | `P`           | The payload, as JSON gives it back. Its type is the declared payload type, or `any` without one.          |
| `job`     | `JobInfo`     | Information about the job (see below).                                                                    |
| `signal`  | `AbortSignal` | A signal that aborts when the handler must stop. Pass it to `fetch` and other APIs, or check it in loops. |

The `job` object has these fields:

| Field         | Type                | Description                                     |
| ------------- | ------------------- | ----------------------------------------------- |
| `id`          | `string`            | The job id.                                     |
| `name`        | `string`            | The job name.                                   |
| `attempt`     | `number`            | The current attempt. It is 1 for the first run. |
| `maxAttempts` | `number`            | The highest number of attempts for this job.    |
| `enqueuedAt`  | `Date`              | The time of the enqueue.                        |
| `mutexKeys`   | `readonly string[]` | The mutex keys of the job, sorted.              |

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
}, { lane: 'heavy', timeout: '5m' });
```

## `start`

`start` starts the worker of this process.

```ts
sqlane.start(): Promise<void>
```

After `start()`, the process claims and runs the due jobs of the names it handles. It also renews leases, recovers
stalled jobs and, if `cleanup` is on, deletes expired jobs. A second call does nothing.

`start` rejects with a `ConfigError` if a handled definition has a `failureJob` that is neither in `jobs` nor handled.
It also rejects with one if a failure job has a `failureJob` of its own. It checks all the handlers together, so the
order of the `handle()` calls does not matter. `start` rejects with a `ClosedError` after `close()`.

## `drain`

`drain` runs the due jobs of the handled names until none is left, without `start()`. It is meant for tests.

```ts
sqlane.drain(options?: DrainOptions): Promise<DrainResult>
```

`drain` only runs the names that this instance handles, and only the jobs that are due. It does not wait for jobs of
other names.

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

`close` resolves when the handlers have settled or the deadline has passed, and the releases are written. A second
call returns the same promise. `close` ends only what sqlane opened, such as the LISTEN connection and the hint
subscription. It never ends your pools.

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

| Class                       | `code`                   | When                                                                                                                                                        |
| --------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigError`               | `CONFIG`                 | The options of `createSqlane`, `defineJob`, `handle()`, an adapter or `getMigrations` are bad. `start()` and `drain()` also throw it for a bad failure job. |
| `InvalidOptionsError`       | `INVALID_OPTIONS`        | The arguments of `enqueue` or `enqueueMany` are bad, for example a bad name or `jobId`, `delay` with `runAt`, or a payload that is not JSON.                |
| `PayloadTooLargeError`      | `PAYLOAD_TOO_LARGE`      | The payload is larger than `maxPayloadBytes`.                                                                                                               |
| `InvalidMutexKeyError`      | `INVALID_MUTEX_KEY`      | A job has more than 10 mutex keys, or a key breaks the rules.                                                                                               |
| `UnknownJobError`           | `UNKNOWN_JOB`            | `enqueue` got an unknown job name, and `unknownJobs` is `'reject'`.                                                                                         |
| `ClosedError`               | `CLOSED`                 | `start`, `handle` or `drain` was called after `close()`.                                                                                                    |
| `DrainTimeoutError`         | `DRAIN_TIMEOUT`          | `drain()` did not finish within its `timeout`.                                                                                                              |
| `JobTimeoutError`           | `JOB_TIMEOUT`            | The handler's `signal` aborted because the timeout passed. It is also the error of the attempt.                                                             |
| `ShutdownError`             | `SHUTDOWN`               | The handler's `signal` aborted because `close()` reached its deadline.                                                                                      |
| `LeaseLostError`            | `LEASE_LOST`             | The handler's `signal` aborted because the process could not renew the lease until 30 s before it ends, for example because the database is unreachable.    |
| `MissingPayloadError`       | `MISSING_PAYLOAD`        | sqlane did not find the payload of a job. The job fails for good with this error.                                                                           |
| `MigrationLockTimeoutError` | `MIGRATION_LOCK_TIMEOUT` | `migrate()` did not get the migration lock within its `lockTimeout`.                                                                                        |
| `FatalJobError`             | `FATAL_JOB`              | A handler threw it to fail the job at once. See below.                                                                                                      |
| `RetryJobError`             | `RETRY_JOB`              | A handler threw it to retry the job after a given delay. See below.                                                                                         |

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

Every event except `error` has these fields:

| Field     | Type     | Description                                                                                                 |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `jobId`   | `string` | The job id.                                                                                                 |
| `jobName` | `string` | The job name.                                                                                               |
| `attempt` | `number` | The attempt, starting at 1. When stall recovery emits the event, it is the attempt of the run that stalled. |

| `type`                  | Extra fields                     | When                                                                                                                                                                        |
| ----------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimed`               | None                             | This process claimed the job and starts its handler.                                                                                                                        |
| `completed`             | `durationMs`                     | The job completed.                                                                                                                                                          |
| `retried`               | `durationMs`, `delayMs`, `error` | The attempt failed, and the job will run again after `delayMs`.                                                                                                             |
| `failed`                | `durationMs`, `error`            | The job failed for good. Stall recovery also emits it when a job stalls too often. `durationMs` is then the time from the start of the run that stalled until its recovery. |
| `timed_out`             | `durationMs`                     | The handler ran longer than its timeout, and its `signal` aborted.                                                                                                          |
| `stalled`               | None                             | Stall recovery found a job whose lease had ended, and put it back in the queue.                                                                                             |
| `released`              | None                             | `close()` released an unfinished job in `'release'` mode.                                                                                                                   |
| `lease_lost`            | None                             | This process could not renew the lease of the job until 30 s before it ends, and aborted its `signal`.                                                                      |
| `failure_job_not_added` | `failureJob`, `error`            | The job failed for good, but the database refused to add its failure job.                                                                                                   |
| `error`                 | `operation`, `error`             | An internal operation failed, for example a poll or a hint. `operation` names it. sqlane also logs it.                                                                      |

`durationMs` is the run time of the handler in milliseconds. `error` is the thrown value, of type `unknown`.

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
