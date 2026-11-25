<!--
Writers follow docs/for_agents/guide_for_writing_user_faced_api_docs.md, with these rules:
- Only this file changes: internals, history and upgrade notes are left out, not moved elsewhere.
- Words: "slot" means only a schedule slot. Never a bare "key": limit key, dedupe key or schedule key. local: in one
  runner, in memory; global: by all processes, in the database. `hint` names only the option and its type: prose says
  "sqlane wakes the other processes". claim: a runner takes a due job to run it.
- Templates: a method follows guide rule 4; a type: summary → fields table → notes; a concept: summary → rules →
  example. Inside a section, use bold labels, not headings.
-->

# API reference

`@sqlane/core` is a job queue that lives in your own MySQL, MariaDB or PostgreSQL database, with no broker to run.
You enqueue a job in the same transaction as your business change, so the job exists only if that change commits.
This page lists every function, option, type, error and event; [design.md](design.md) explains how sqlane works inside.

```ts
import { Pool } from 'pg';
import { createRunner, createSqlane, defineHandler, defineLane } from '@sqlane/core';
import { pgAdapter } from '@sqlane/core/adapter-pg';

const appPool = new Pool({ connectionString: process.env.DATABASE_URL });
const queuePool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 }); // sqlane's own
const sqlane = createSqlane({ adapter: pgAdapter(queuePool, { dialect: 'postgres' }) });
const sendReceipt = defineLane<{ orderId: number }>({ name: 'send_receipt' });

await sqlane.schema.migrate(); // once, at deploy: creates the sqlane tables

// Producer: the job commits with the order, or not at all
const client = await appPool.connect();
await client.query('BEGIN');
const { rows } = await client.query('INSERT INTO orders (total) VALUES ($1) RETURNING id', [42]);
await sqlane.enqueue(client, sendReceipt, { orderId: rows[0].id });
await client.query('COMMIT');
client.release();

// Worker: runs the job after the commit, in this process or another
const runner = createRunner(sqlane);
runner.mount([
    defineHandler(sendReceipt, async ({ payload }) => {
        await sendReceiptEmail(payload.orderId); // your code
    }),
]);
await runner.start();
```

## Contents

- [Glossary](#glossary)
- [Durations](#durations)
- [Definitions](#definitions)
    - [`defineLane`](#definelane)
        - [Backoff](#backoff)
        - [Typed payloads](#typed-payloads)
    - [`defineHandler`](#definehandler)
        - [The handler context](#the-handler-context)
        - [How a handler ends](#how-a-handler-ends)
    - [`defineConcurrencyLimit`](#defineconcurrencylimit)
    - [`defineRateLimit`](#defineratelimit)
    - [`defineSchedule`](#defineschedule)
- [sqlane instance](#sqlane-instance)
    - [`createSqlane`](#createsqlane)
    - [`sqlane.enqueue`](#sqlaneenqueue)
    - [`sqlane.enqueueMany`](#sqlaneenqueuemany)
    - [`sqlane.jobs.get`](#sqlanejobsget)
    - [`sqlane.jobs.list`](#sqlanejobslist)
    - [`sqlane.jobs.retry`, `cancel` and `remove`](#sqlanejobsretry-cancel-and-remove)
        - [`sqlane.jobs.retry`](#sqlanejobsretry)
        - [`sqlane.jobs.cancel`](#sqlanejobscancel)
        - [`sqlane.jobs.remove`](#sqlanejobsremove)
    - [`sqlane.jobs.keyStats`](#sqlanejobskeystats)
    - [`sqlane.lanes.stats`](#sqlanelanesstats)
    - [`sqlane.lanes.groupStats`](#sqlanelanesgroupstats)
    - [`sqlane.lanes.pauseGlobally` and `resumeGlobally`](#sqlanelanespauseglobally-and-resumeglobally)
    - [`sqlane.schedules.list`](#sqlanescheduleslist)
    - [`sqlane.schedules.runSlot`](#sqlaneschedulesrunslot)
    - [`sqlane.schedules.pauseGlobally` and `resumeGlobally`](#sqlaneschedulespauseglobally-and-resumeglobally)
    - [`sqlane.schedules.remove`](#sqlaneschedulesremove)
    - [`sqlane.schema.migrate`](#sqlaneschemamigrate)
    - [`sqlane.schema.rollback`](#sqlaneschemarollback)
    - [`sqlane.schema.drop`](#sqlaneschemadrop)
    - [`sqlane.schema.getMigrationStatus`](#sqlaneschemagetmigrationstatus)
    - [`sqlane.schema.findSchemaProblems`](#sqlaneschemafindschemaproblems)
    - [`sqlane.close`](#sqlaneclose)
- [sqlane runner](#sqlane-runner)
    - [`createRunner`](#createrunner)
    - [`runner.mount`](#runnermount)
        - [`Mount.unmount`](#mountunmount)
    - [`runner.start`](#runnerstart)
    - [`runner.drain`](#runnerdrain)
    - [`runner.close`](#runnerclose)
    - [`runner.pauseLocally` and `resumeLocally`](#runnerpauselocally-and-resumelocally)
    - [`runner.getStatus`](#runnergetstatus)
- [Behavior](#behavior)
    - [Job lifecycle](#job-lifecycle)
    - [Where job options come from](#where-job-options-come-from)
    - [Concurrency and rate limits](#concurrency-and-rate-limits)
    - [How a runner shares `localMaxConcurrency`](#how-a-runner-shares-localmaxconcurrency)
    - [Fair groups](#fair-groups)
    - [Schedules](#schedules)
- [Types](#types)
    - [`JobRecord` and `JobError`](#jobrecord-and-joberror)
    - [`FailedJobPayload`](#failedjobpayload)
    - [`Hint`](#hint)
- [Errors](#errors)
- [Events](#events)
- [Adapters](#adapters)

## Glossary

sqlane's own words. Other terms are explained where they first appear.

| Term   | Meaning                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| sqlane | The library. The object that `createSqlane` returns is the sqlane instance.                                                                 |
| lane   | A named kind of job, such as `send_email`. All lanes share the same tables and the same workers.                                            |
| local  | Counted or applied in one runner only, in memory: `localConcurrencyLimits`, `pauseLocally`.                                                 |
| global | Counted or applied by all processes, in the database: `globalConcurrencyLimits`, `pauseGlobally`.                                           |
| stall  | A running job's process stops renewing its [lease](#stalls) (it exited or hung). The job becomes pending again, or fails after `maxStalls`. |

## Durations

A `Duration` is a length of time, such as `timeout`: a number of milliseconds or a string.

```ts
type Duration = string | number;
```

**Number.** A non-negative safe integer of milliseconds: `1500`, not `1.5` or `-1`.

**String.** One or more parts, each a quantity followed directly by a unit:

| Unit | Meaning      |
| ---- | ------------ |
| `w`  | weeks (7 d)  |
| `d`  | days (24 h)  |
| `h`  | hours        |
| `m`  | minutes      |
| `s`  | seconds      |
| `ms` | milliseconds |

**Rules**

- Units are lowercase, from the largest to the smallest, each at most once.
- A quantity is a decimal number, such as `2`, `1.5` or `.5`, without a sign or an exponent.
- No space between a quantity and its unit. Spaces (not tabs or newlines) may separate the parts and surround the
  string.
- sqlane adds the parts and rounds to the nearest millisecond. `0` is valid, except where an option needs a positive
  length, such as `timeout`.
- An invalid duration throws the error of the option that holds it, such as `ConfigError` in a definition.

| Valid         | Milliseconds | Invalid    | Why                        |
| ------------- | ------------ | ---------- | -------------------------- |
| `'30s'`       | 30000        | `'5'`      | No unit.                   |
| `'1.5h'`      | 5400000      | `'1h30'`   | The last part has no unit. |
| `'.5s'`       | 500          | `'1 h'`    | A space before the unit.   |
| `'4m30s'`     | 270000       | `'1ms 1d'` | Units in the wrong order.  |
| `'1d 1h 1ms'` | 90000001     | `'1h1h'`   | A unit twice.              |
| `'2w'`        | 1209600000   | `'1H'`     | An uppercase unit.         |
| `1500`        | 1500         | `'1 days'` | Not a unit.                |

## Definitions

Each `define…` function is synchronous, needs no database, and returns a frozen value. Create definitions once at
module load: producers import the lane, and the worker mounts the handler with [`runner.mount`](#runnermount).

### `defineLane`

Defines a lane and the options of its jobs.

```ts
defineLane<P = any>(options: LaneOptions<P>): LaneDefinition<P>
```

| Option                    | Type                                                                    | Default                 | Description                                            |
| ------------------------- | ----------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------ |
| `name`                    | `string`                                                                | required                | The lane's name, matching `^[a-z][a-z0-9_.-]{0,127}$`. |
| `maxAttempts`             | integer ≥ 1                                                             | `3`                     | How many times a job may run.                          |
| `maxStalls`               | integer ≥ 0                                                             | `2`                     | How many stalls a job survives.                        |
| `backoff`                 | [`Backoff`](#backoff)                                                   | see [Backoff](#backoff) | The wait between a failed attempt and the next one.    |
| `retention`               | `{ completed?: Duration, failed?: Duration }`                           | `'1h'` / `'30d'`        | How long sqlane keeps a finished job.                  |
| `timeout`                 | [`Duration`](#durations) > 0                                            | none                    | How long one attempt may run.                          |
| `failureLane`             | `LaneDefinition<FailedJobPayload>`                                      | none                    | A lane that gets a job when a job fails for good.      |
| `globalConcurrencyLimits` | `({ payload }) => readonly (ConcurrencyLimit \| ConcurrencyLimitKey)[]` | none                    | The job's global concurrency limits.                   |
| `globalRateLimits`        | `({ payload }) => readonly (RateLimit \| RateLimitKey)[]`               | none                    | The job's global rate limits.                          |
| `fairGroup`               | `({ payload }) => string \| null \| undefined`                          | none                    | The job's fair group, or `null`/`undefined`.           |

**Returns** a frozen copy of `options`, a `LaneDefinition<P>`.

**Errors.** `defineLane` throws `ConfigError` (message prefix `defineLane("<name>")`) when an option is invalid or
unknown, such as `localConcurrencyLimits`; when `fairGroup` comes with global limits; or when `failureLane` is not a
lane definition, is the lane itself, or has a `failureLane` of its own.

**Notes**

- **When sqlane reads an option.** `maxAttempts`, `maxStalls`, `retention`, the global limits and `fairGroup` are
  copied into the job at enqueue, from the producer's definition. `backoff`, `timeout` and `failureLane` are read when
  the job runs or fails, from the runner's definition. See [Where job options come from](#where-job-options-come-from).
- **`retention`.** `0` deletes the job at the next cleanup. An omitted field keeps its default.
- **`timeout`** aborts the `signal` with `JobTimeoutError`; see [Timeout](#timeout). A lane with
  `globalConcurrencyLimits` needs one, here or in `createSqlane({ defaults })`, or `runner.mount()` throws
  `ConfigError`.
- **Limit and group functions** are synchronous and run at enqueue; an enqueue option of the same name replaces their
  result. An invalid fair group name rejects the enqueue with `InvalidOptionsError`. See
  [Concurrency and rate limits](#concurrency-and-rate-limits) and [Fair groups](#fair-groups).
- **`failureLane`** gets a job with a [`FailedJobPayload`](#failedjobpayload).

**Example**

```ts
export const sendEmailFailed = defineLane<FailedJobPayload>({ name: 'send_email_failed' });

export const sendEmail = defineLane<{ to: string }>({
    name: 'send_email',
    maxAttempts: 5,
    timeout: '1m',
    backoff: { type: 'exponential', delay: '10s', maxDelay: '10m' },
    failureLane: sendEmailFailed,
});
```

#### Backoff

The `backoff` option sets the wait after a failed attempt.

| Field      | Type                       | Default  | Description                                                    |
| ---------- | -------------------------- | -------- | -------------------------------------------------------------- |
| `type`     | `'exponential' \| 'fixed'` | required | Whether the wait doubles after each attempt or stays the same. |
| `delay`    | [`Duration`](#durations)   | required | The wait after the first failed attempt; `0` is allowed.       |
| `maxDelay` | [`Duration`](#durations)   | no cap   | The longest wait, at least `delay`; only for `'exponential'`.  |
| `jitter`   | number, 0–1                | `0.2`    | The largest share of the wait that sqlane removes at random.   |

The default backoff is `{ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 }`.

**Notes**

- `'exponential'` waits `delay × 2^(n − 1)` after attempt _n_, capped at `maxDelay`; `'fixed'` always waits `delay`.
- Jitter only shortens the wait, to `wait × (1 − jitter × random)`.
- A `backoff` you set replaces the default as a whole: `{ type: 'exponential', delay: '5s' }` has no `maxDelay`.
- An unknown field throws `ConfigError`.

| Attempt that failed | Wait with `{ type: 'exponential', delay: '5s', maxDelay: '1m', jitter: 0 }` |
| ------------------- | --------------------------------------------------------------------------- |
| 1                   | 5 s                                                                         |
| 2                   | 10 s                                                                        |
| 3                   | 20 s                                                                        |
| 4                   | 40 s                                                                        |
| 5 and later         | 1 min                                                                       |

#### Typed payloads

`P` types the payload in `enqueue`, `enqueueMany`, `defineSchedule`, the lane's functions and the handler.

```ts
const buildReport = defineLane<{ reportId: string }>({ name: 'build_report' });
```

In JavaScript, use JSDoc:

```js
/** @type {import('@sqlane/core').LaneDefinition<{ reportId: string }>} */
export const buildReport = defineLane({ name: 'build_report' });
```

**Notes**

- The check is at compile time only. Without `P`, the payload is `any`; enqueue checks only JSON compatibility.
- `P` must be JSON-compatible: the types reject `Date`, `Map`, `Set`, functions and `bigint`.

### `defineHandler`

Defines how a process runs the jobs of a lane: the function to call, and the lane's settings in this process.

```ts
defineHandler<J extends LaneDefinition>(
    lane: J,
    fn: (context: HandlerContext<HandlerPayload<J>>) => unknown,
    options?: HandlerOptions,
): LaneHandler<HandlerPayload<J>>
```

| Parameter | Type              | Description                                                                         |
| --------- | ----------------- | ----------------------------------------------------------------------------------- |
| `lane`    | a lane definition | The lane whose jobs this handler runs, as [`defineLane`](#definelane) returns it.   |
| `fn`      | function          | Runs one attempt of a job; it receives [the handler context](#the-handler-context). |
| `options` | `HandlerOptions`  | The lane's settings in each process that mounts this handler, below.                |

| Option                   | Type                                                                | Default | Description                                                                                                       |
| ------------------------ | ------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `fairShareWeight`        | integer, 1–1000                                                     | `1`     | The lane's share of the runner's capacity; see [`localMaxConcurrency`](#how-a-runner-shares-localmaxconcurrency). |
| `localConcurrencyLimits` | array of [`defineConcurrencyLimit`](#defineconcurrencylimit) values | none    | A job starts only while each has room in this runner.                                                             |
| `localRateLimits`        | array of [`defineRateLimit`](#defineratelimit) values               | none    | Limits how often this runner starts the lane's jobs.                                                              |

**Returns** a frozen `LaneHandler`: `lane`, `handler` (your `fn`) and frozen copies of the options.

**Errors.** `defineHandler` throws `ConfigError` (message prefix `defineHandler("<lane name>")`) when `lane` is not a
lane definition, `fn` is not a function, an option is invalid or unknown, a local limit array names a limit twice, or
`localRateLimits` holds a `key()` or `cost()` result.

**Notes**

- **How `fn` ends** decides what happens to the job; see [How a handler ends](#how-a-handler-ends).
- **Local limits** count in one runner; see [Concurrency and rate limits](#concurrency-and-rate-limits).
- **Make `fn` idempotent.** A job runs at least once, and may run again after its work is done; see
  [Job lifecycle](#job-lifecycle).

**Example.** At most 4 ERP calls at once per worker process:

```ts
const erpCalls = defineConcurrencyLimit({ name: 'erp_calls', max: 4 });

export const syncOrderHandler = defineHandler(syncOrder, async ({ payload, signal }) => {
    await erp.pushOrder(payload.orderId, { signal });
}, { localConcurrencyLimits: [erpCalls] });
```

#### The handler context

The handler's argument, one per attempt.

| Field     | Type           | Description                                                |
| --------- | -------------- | ---------------------------------------------------------- |
| `payload` | the lane's `P` | The payload after a JSON round trip: a `Date` is a string. |
| `job`     | `JobInfo`      | The job and this attempt, below.                           |
| `signal`  | `AbortSignal`  | Aborts when the handler must stop.                         |

**`job`** is a `JobInfo`:

| Field                     | Type                                      | Description                                                |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `id`                      | `string`                                  | The job id.                                                |
| `lane`                    | `string`                                  | The lane name.                                             |
| `attempt`                 | `number`                                  | The current attempt, 1 for the first run.                  |
| `maxAttempts`             | `number`                                  | Fixed at enqueue; a `one_more` retry raises it.            |
| `enqueuedAt`              | `Date`                                    | When the job was enqueued.                                 |
| `globalConcurrencyLimits` | `readonly { key: string, max: number }[]` | Global concurrency limit keys and maxes, sorted by key.    |
| `scheduledAt`             | `Date \| null`                            | The slot of a schedule's job, even when late; else `null`. |
| `runAt`                   | `Date`                                    | When the job may start; jobs start in this order.          |
| `startedAt`               | `Date`                                    | When this attempt started, by the database clock.          |
| `fairGroup`               | `string \| null`                          | The job's [fair group](#fair-groups), or `null`.           |

**`signal`** aborts with one of these `reason`s:

| `signal.reason`   | When                                                     |
| ----------------- | -------------------------------------------------------- |
| `JobTimeoutError` | The attempt ran past `timeout`; see [Timeout](#timeout). |
| `LeaseLostError`  | The runner lost the job's [lease](#stalls).              |
| `ShutdownError`   | [`runner.close`](#runnerclose) reached its deadline.     |

**Notes**

- **Stop on abort.** Pass `signal` to `fetch`, your driver or SDK, or check `signal.aborted`.
- **After an abort,** sqlane ignores how the handler ends; after a timeout the attempt fails.
- **`runAt`.** Retries, stalls, releases, `runner.drain({ includeDelayed })` and `jobs.retry()` move it; waiting on a
  global limit key does not. `startedAt − runAt` is how late the job started.

**Example**

```ts
export const sendEmailHandler = defineHandler(sendEmail, async ({ payload, job, signal }) => {
    logger.info({ jobId: job.id, attempt: job.attempt });
    await fetch(mailApiUrl, { method: 'POST', body: JSON.stringify(payload), signal });
});
```

#### How a handler ends

How your handler returns or throws tells sqlane what to do with the job.

| The handler               | What happens                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| returns or resolves       | The job completes; sqlane ignores the returned value.                                     |
| throws `RetryJobError`    | The attempt fails; the retry waits the error's `delay`.                                   |
| throws `FatalJobError`    | The job fails for good at once, even with attempts left.                                  |
| throws `RateLimitedError` | The job waits for its rate limit, without using an attempt; see below.                    |
| throws any other error    | The attempt fails; the job retries after its [backoff](#backoff) while attempts are left. |

See [Job lifecycle](#job-lifecycle) for statuses and events.

**`FatalJobError`.** Throw it when a retry cannot help.

```ts
class FatalJobError extends SqlaneError {
    constructor(message: string, options?: ErrorOptions);
}
```

**`RetryJobError`.** Throw it when you know how long to wait. It uses an attempt; an invalid `delay` falls back to
the backoff.

```ts
class RetryJobError extends SqlaneError {
    readonly delay: Duration;
    constructor(message: string, options: ErrorOptions & { delay: Duration });
}
```

**`RateLimitedError`.** Throw it when the other side limits your rate, such as with an HTTP 429. On the job's rate
limits, it uses no attempt.

```ts
class RateLimitedError extends SqlaneError {
    readonly limit: RateLimit | RateLimitKey | undefined;
    readonly retryAfter: Duration;
    constructor(options: {
        limit?: RateLimit | RateLimitKey;
        retryAfter: Duration;
        cause?: unknown;
    });
}
```

| Option       | Type                                  | Description                                         |
| ------------ | ------------------------------------- | --------------------------------------------------- |
| `limit`      | a rate limit or a rate limit key      | The job's rate limit to pause; default all of them. |
| `retryAfter` | [`Duration`](#durations), 0 to 7 days | How long the limit starts no job.                   |
| `cause`      | `unknown`                             | The original error, as in `ErrorOptions`.           |

A `limit` that is not one of the job's rate limits, or a job with no rate limits at all, makes it act as a
`RetryJobError` with a `delay` of `retryAfter`: it then uses an attempt.
For what the pause does, see [Concurrency and rate limits](#concurrency-and-rate-limits). The constructor throws
`InvalidRateLimitError` when an option is invalid or unknown.

**Notes**

- The thrown error becomes the job's [`lastError`](#jobrecord-and-joberror).
- All three errors extend `SqlaneError`, with the `code` `FATAL_JOB`, `RETRY_JOB` or `RATE_LIMITED`. A thrown
  `JobCancelledError` is an ordinary error.

**Example**

```ts
const erpApi = defineRateLimit({ name: 'erp_api', max: 100, per: '1m' });
export const syncOrder = defineLane<{ orderId: number }>({ name: 'sync_order', globalRateLimits: () => [erpApi] });

export const syncOrderHandler = defineHandler(syncOrder, async ({ payload, signal }) => {
    const response = await fetch(`${erpUrl}/orders/${payload.orderId}`, { method: 'PUT', signal });
    if (response.status === 404) throw new FatalJobError(`Order ${payload.orderId} is not in the ERP`);
    if (response.status === 429) throw new RateLimitedError({ retryAfter: '1m' });
    if (response.status === 503) throw new RetryJobError('ERP is down', { delay: '1m' });
    if (!response.ok) throw new Error(`ERP answered ${response.status}`);
});
```

### `defineConcurrencyLimit`

Defines a concurrency limit: the most jobs that run at once under one limit key.

```ts
defineConcurrencyLimit(options: { name: string, max: number }): ConcurrencyLimit
```

| Option | Type           | Default  | Description                                             |
| ------ | -------------- | -------- | ------------------------------------------------------- |
| `name` | `string`       | required | The limit's name, matching `^[a-z][a-z0-9_.-]{0,127}$`. |
| `max`  | integer 1–1000 | required | The most jobs that run at once under one limit key.     |

**Returns** a frozen `ConcurrencyLimit`: `{ name, max, key }`.

**`limit.key(value)`** returns a frozen `ConcurrencyLimitKey`, `{ limit, key }`: `value` (a string or safe integer,
such as a customer id) gets its own count of `max` jobs, and `key` is `String(value)`. The limit without `key()` is
one limit key for all its jobs.

**Errors.**

| Error                          | When                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigError`                  | `defineConcurrencyLimit` gets an invalid `name` or `max`, or an unknown option.                                                        |
| `InvalidConcurrencyLimitError` | `key()` gets a value that is not a string or safe integer; or, at enqueue, a limit key is invalid or gets two `max` values in one job. |

**Notes**

- **Local or global.** `localConcurrencyLimits` takes the limit only, not `key()` results. See
  [Concurrency and rate limits](#concurrency-and-rate-limits).
- **A global limit key** is `name`, or `<name>:<value>` with `key()`: at most 255 printable ASCII characters, no space
  at either end.

**Example.** At most 2 syncs at once per customer, and 100 in all:

```ts
const perCustomer = defineConcurrencyLimit({ name: 'sync_per_customer', max: 2 });
const allSyncs = defineConcurrencyLimit({ name: 'sync_all', max: 100 });

export const syncCustomer = defineLane<{ customerId: number }>({
    name: 'sync_customer',
    timeout: '5m',
    globalConcurrencyLimits: ({ payload }) => [perCustomer.key(payload.customerId), allSyncs],
});
```

### `defineRateLimit`

Defines a rate limit: the most job starts in a period, such as 5000 per hour.

```ts
defineRateLimit(options: { name: string, max: number, per: Duration, burst?: number }): RateLimit
```

| Option  | Type                                  | Default  | Description                                             |
| ------- | ------------------------------------- | -------- | ------------------------------------------------------- |
| `name`  | `string`                              | required | The limit's name, matching `^[a-z][a-z0-9_.-]{0,127}$`. |
| `max`   | integer 1–1,000,000                   | required | The most starts per `per`, on average.                  |
| `per`   | [`Duration`](#durations), 1 ms to 7 d | required | The period of `max`.                                    |
| `burst` | integer 1–`max`                       | `1`      | How many starts may come at once after a quiet time.    |

**Returns** a frozen `RateLimit`: `{ name, max, per, burst, key, cost }`. `per` is in milliseconds.

**`limit.key(value, { cost? })`** returns a frozen `RateLimitKey`, `{ limit, key, cost }`: `value` (a string or safe
integer, such as an API token) gets its own quota, and `key` is `String(value)`.

**`limit.cost(n)`** returns a `RateLimitKey` with `key: null`: the whole limit, with a cost of `n`.

**Cost.** A start with cost `n` (1–`burst`, default 1) takes the quota of `n` starts.

**Errors.**

| Error                   | When                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigError`           | `defineRateLimit` gets an invalid or unknown option, or `max` is above the microseconds of `per`.                                                  |
| `InvalidRateLimitError` | `key()` gets a value that is not a string or safe integer, a cost outside 1–`burst`, or an unknown option; `cost()` gets a cost outside 1–`burst`. |
| `InvalidRateLimitError` | At enqueue, a limit key is invalid or gets two settings in one job.                                                                                |

**Notes**

- **Local or global.** `localRateLimits` takes the limit only; each start costs 1. For spacing and `burst`, see
  [Concurrency and rate limits](#concurrency-and-rate-limits).
- **A global limit key** has the same rules as a concurrency limit key. A rate limit and a concurrency limit never
  share a limit key, even with the same name.

**Example.** 5000 GitHub calls per hour per token:

```ts
const githubApi = defineRateLimit({ name: 'github_api', max: 5000, per: '1h', burst: 50 });

export const syncRepo = defineLane<{ tokenId: string, repo: string }>({
    name: 'sync_repo',
    globalRateLimits: ({ payload }) => [githubApi.key(payload.tokenId)],
});
```

### `defineSchedule`

Defines a schedule: a cron expression or interval that adds a job to a lane at each slot, a time at which it fires.

```ts
defineSchedule<J extends LaneDefinition>(
    lane: J,
    options: ScheduleOptions<HandlerPayload<J>>,
): ScheduleDefinition<HandlerPayload<J>>
```

| Option     | Type                     | Default   | Description                                                          |
| ---------- | ------------------------ | --------- | -------------------------------------------------------------------- |
| `key`      | `string`                 | required  | Tells the lane's schedules apart in the schedule id.                 |
| `cron`     | `string`                 | none      | A 5-field cron expression on the wall clock of `timezone`.           |
| `timezone` | `string`                 | `'UTC'`   | The IANA zone of `cron`, case-insensitive; see Time zones and DST.   |
| `every`    | [`Duration`](#durations) | none      | A fixed interval, `'1s'` to `'1d'`, in UTC.                          |
| `payload`  | JSON value               | `{}`      | The payload of every job; required when the lane has a payload type. |
| `missed`   | `'once'` \| `'skip'`     | `'once'`  | Whether a missed slot runs once, late, or never.                     |
| `overlap`  | `'allow'` \| `'skip'`    | `'allow'` | Whether a slot adds no job while the previous job is unfinished.     |
| `jitter`   | [`Duration`](#durations) | none      | The most delay after each slot, up to `'1d'`.                        |

See [Schedules](#schedules) for the cron syntax, time zones, intervals, missed slots, overlap and jitter.

**Returns** a frozen `ScheduleDefinition<P>`: `id` (`<lane>:<key>`), `lane` and the options, `payload` as a frozen JSON
copy.

**Errors.** `defineSchedule` throws `ConfigError` (message prefix `defineSchedule("<lane>")`) when:

- `lane` is not a lane definition, an option is unknown, or `missed` or `overlap` has another value;
- `key` is missing, or not 1–64 printable ASCII characters without a space at either end;
- not exactly one of `cron` and `every` is set, or `timezone` is invalid or comes with `every`;
- `cron` is invalid or never fires in the next 50 years, such as `'0 0 30 2 *'`;
- `every` is under `'1s'`, over `'1d'`, or over `'1h'` without dividing a day;
- `jitter` is not positive, over `'1d'`, or not less than `every`;
- `payload` does not survive `JSON.stringify`.

[`runner.mount()`](#runnermount) throws `ConfigError` when sqlane would refuse the schedule's job, such as a payload
larger than `maxPayloadBytes`, or when the runner already mounts a schedule with the same id.

**Notes**

- **Firing.** Only a started runner that mounts the schedule fires it, with or without the lane's handler.
- **The schedule id** is shared by every process on the database; a new `key` makes a new schedule.
- **The jobs** are ordinary jobs of the lane; the handler reads the slot in `job.scheduledAt`.

**Example**

```ts
export const nightlyReport = defineSchedule(buildReport, {
    key: 'nightly',
    cron: '0 3 * * *',
    timezone: 'Europe/Berlin',
    payload: { reportId: 'nightly' },
});

runner.mount([buildReportHandler, nightlyReport]); // in the worker
```

## sqlane instance

The sqlane instance that [`createSqlane`](#createsqlane) returns enqueues jobs, reads and changes them, and manages the
tables. It needs no runner, so a web process or a script uses it alone. It works before
[`runner.start()`](#runnerstart) and, except for `createRunner` and schema changes, after
[`sqlane.close()`](#sqlaneclose).

### `createSqlane`

Creates the sqlane instance over your database. It connects, migrates and starts nothing.

```ts
createSqlane<C>(options: SqlaneOptions<C>): Sqlane<C>
```

| Option            | Type                           | Default        | Description                                                                     |
| ----------------- | ------------------------------ | -------------- | ------------------------------------------------------------------------------- |
| `adapter`         | `Adapter<C>`                   | required       | Your driver's or ORM's [adapter](#adapters), over a small pool of sqlane's own. |
| `tablePrefix`     | `string`                       | `'sqlane_'`    | Prefix of sqlane's tables; matches `^[a-z][a-z0-9_]{0,31}$`.                    |
| `defaults`        | `JobDefaults`                  | see below      | Job options of every lane that does not set its own.                            |
| `hint`            | [`Hint`](#hint) \| `null`      | `null`         | Wakes the other processes when a lane has work.                                 |
| `logger`          | `Logger`                       | none (no logs) | Receives sqlane's logs; also the runner's default logger.                       |
| `onEvent`         | `(event: SqlaneEvent) => void` | none           | Receives every [event](#events) of the runners and of this instance.            |
| `pollInterval`    | [`Duration`](#durations) > 0   | `'5s'`         | How often a started runner looks for jobs when nothing wakes it.                |
| `maxPayloadBytes` | integer ≥ 1                    | `262144`       | Largest payload, in UTF-8 bytes of its JSON text (256 KiB).                     |
| `cleanup`         | `boolean`                      | `true`         | Lets started runners delete jobs whose [retention](#retention) has ended.       |

**`adapter`** fixes `C`: the connections and transactions that `enqueue` accepts. sqlane claims jobs (a runner claims
a job when it takes a due one to run it) and writes results through its pool.

**`defaults`.** Each omitted field keeps its built-in default. Lanes and enqueue options override
them; see [Where job options come from](#where-job-options-come-from).

| Field         | Type                         | Built-in default                                            |
| ------------- | ---------------------------- | ----------------------------------------------------------- |
| `maxAttempts` | integer ≥ 1                  | `3`                                                         |
| `maxStalls`   | integer ≥ 0                  | `2`                                                         |
| `backoff`     | [`Backoff`](#backoff)        | see [Backoff](#backoff)                                     |
| `retention`   | `{ completed?, failed? }`    | `{ completed: '1h', failed: '30d' }`, each field on its own |
| `timeout`     | [`Duration`](#durations) > 0 | none: an attempt may run without end                        |

**`logger`.** Methods `debug`, `info`, `warn` and `error`, each `(object: object, message?: string)`, so pino fits as
it is. [`createRunner`](#createrunner) can give the runner its own.

| Level   | What sqlane logs                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------- |
| `debug` | Transient errors that sqlane retried at once.                                                        |
| `info`  | Recoveries, such as a schedule that enqueues its slots again.                                        |
| `warn`  | What sqlane works around, such as a clock skew or an old database server.                            |
| `error` | Failed operations (each also emits an `error` event) and jobs that fail for good (a `failed` event). |

**`onEvent`** is called synchronously. When it throws, sqlane logs the error through `logger.error` and carries on.

**Returns** `Sqlane<C>`: [`enqueue`](#sqlaneenqueue), [`enqueueMany`](#sqlaneenqueuemany), [`close`](#sqlaneclose),
and the groups `jobs`, `lanes`, `schedules` and `schema`.

**Errors.** Throws `ConfigError` when `adapter` is missing; an option or `defaults` field is unknown or invalid; `hint`
lacks `publish` and `subscribe` functions; or you pass both `hint` and an adapter with `notify: true`.

**Notes**

- Create one instance per process, and share it.
- A PostgreSQL adapter with `notify: true` wakes the other processes itself, without `hint`.
- Call [`sqlane.schema.migrate()`](#sqlaneschemamigrate) once before the first enqueue, for example at deploy.

**Example**

```ts
export const sqlane = createSqlane({
    adapter: pgAdapter(new Pool({ max: 3 }), { dialect: 'postgres', notify: true }),
    defaults: { timeout: '10m' },
    logger: pino(),
});
```

### `sqlane.enqueue`

Adds one job to a lane, in your transaction or in a short transaction of its own.

```ts
sqlane.enqueue(connection, lane, payload, options?): Promise<{ id: string, created: boolean }>
```

| Parameter    | Type                                        | Description                                                |
| ------------ | ------------------------------------------- | ---------------------------------------------------------- |
| `connection` | a connection, client or pool of your driver | Where sqlane writes the job.                               |
| `lane`       | a lane definition                           | The job's lane, as [`defineLane`](#definelane) returns it. |
| `payload`    | JSON value                                  | The data that the handler receives.                        |
| `options`    | `EnqueueOptions`                            | Settings for this job only; see below.                     |

**`connection`** decides when the job becomes visible:

- A connection inside your transaction: after your commit; a rollback discards the job. Open the transaction before
  you pass the connection: sqlane cannot always tell.
- A pool: at once; sqlane commits the job in a short transaction of its own.

**`payload`** must survive `JSON.stringify`, without lone surrogates or NUL characters, within
[`maxPayloadBytes`](#createsqlane). The handler gets a JSON round trip: a `Date` arrives as a string. A typed lane,
such as `defineLane<{ userId: number }>(…)`, lets TypeScript check it.

**Options.** All optional; an unknown option is an error.

| Option                    | Type                          | Description                                                               |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `dedupeKey`               | `string`                      | Gives the job a fixed id, so a second enqueue with it adds nothing.       |
| `delay`                   | [Duration](#durations)        | How long the job waits before it may start; default `0`.                  |
| `runAt`                   | `Date`                        | When the job may start; not together with `delay`.                        |
| `maxAttempts`             | integer ≥ 1                   | The most times the job runs before it fails.                              |
| `maxStalls`               | integer ≥ 0                   | The most stalls the job survives before it fails.                         |
| `retention`               | `{ completed?, failed? }`     | How long the finished job is kept, merged field by field with the lane's. |
| `globalConcurrencyLimits` | array of limits or limit keys | Replaces the lane's global concurrency limits; `[]` clears them.          |
| `globalRateLimits`        | array of limits or limit keys | Replaces the lane's global rate limits; `[]` clears them.                 |

An omitted option comes from [the lane or `defaults`](#where-job-options-come-from). `backoff`, `timeout`,
`failureLane` and `fairGroup` are lane settings only.

**Returns** a promise of `{ id, created }`:

| Field     | Type      | Description                                                           |
| --------- | --------- | --------------------------------------------------------------------- |
| `id`      | `string`  | The job id: `<lane>:<dedupeKey>`, or a new ULID without a dedupe key. |
| `created` | `boolean` | `true` only when this call added the job.                             |

**Errors.** `enqueue` checks everything before it writes, so a rejected call adds no job.

| Error                          | When                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `InvalidOptionsError`          | The lane, payload, an option, the dedupe key or the lane's fair group result is invalid. |
| `PayloadTooLargeError`         | The payload JSON is larger than `maxPayloadBytes`.                                       |
| `InvalidConcurrencyLimitError` | A global concurrency limit or its limit key is invalid, or the job has more than 10.     |
| `InvalidRateLimitError`        | A global rate limit is invalid, or the job has more than 10 limit keys in all.           |

Errors from the database, the driver or the lane's `fairGroup` function pass through unchanged. See [Errors](#errors).

**Notes**

- **Dedupe key.** 1 to 120 printable ASCII characters, no leading or trailing space, not starting with `schedule:`.
  The same dedupe key in two lanes gives two jobs.
- **An existing job.** When a job with the same id exists, in any status, `enqueue` ignores the call's options and
  returns `{ id, created: false }`. The id is free again once the job is removed or cleaned up.
- **`delay`** counts from the database clock.
- **Global limits.** On a lane with a `fairGroup`, only `[]` is allowed. See
  [Concurrency and rate limits](#concurrency-and-rate-limits) and [Fair groups](#fair-groups).
- **Waking runners.** A new job wakes the lane's runners: in this process at once, in others through [`hint`](#hint)
  or PostgreSQL `notify`, else at their next poll. After `sqlane.close()`, other processes are not woken.

**Example**

```ts
await client.query('BEGIN');
await client.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, email]);
const { id, created } = await sqlane.enqueue(client, sendWelcome, { userId }, { dedupeKey: `welcome-${userId}` });
await client.query('COMMIT');
```

### `sqlane.enqueueMany`

Adds many jobs of one lane in one call, in your transaction or in a short transaction of its own.

```ts
sqlane.enqueueMany(connection, lane, items): Promise<{ id: string, created: boolean }[]>
```

| Parameter    | Type                                        | Description                                                       |
| ------------ | ------------------------------------------- | ----------------------------------------------------------------- |
| `connection` | a connection, client or pool of your driver | Where sqlane writes the jobs, as in `enqueue`.                    |
| `lane`       | a lane definition                           | The lane of every job.                                            |
| `items`      | array of `{ payload, options? }`            | One entry per job, with the rules of [`enqueue`](#sqlaneenqueue). |

**Returns** one `{ id, created }` per item, in order. An empty `items` returns `[]`.

**Errors.** Every item is checked before any write, so one bad item adds no job. `InvalidOptionsError` when `items`
is not an array; each item can raise the errors of `enqueue`.

**Notes**

- **The connection.** All jobs commit or roll back together: with your transaction, or in one of sqlane's own.
- **Dedupe keys.** When items share a dedupe key, the first adds the job; later ones, and items whose job already
  exists, get `created: false`.
- **Waking runners.** At least one new job wakes the lane's runners once.
- **One lane per call.** For several lanes, make one call per lane in the same transaction.

**Example**

```ts
await sqlane.enqueueMany(trx, syncUser, users.map(user => ({
    payload: { userId: user.id },
    options: { dedupeKey: `user-${user.id}` },
})));
```

### `sqlane.jobs.get`

Reads one job by its id, with its payload.

```ts
sqlane.jobs.get<P = any>(jobId: string): Promise<JobRecord<P> | null>
```

| Parameter | Type     | Description                                                        |
| --------- | -------- | ------------------------------------------------------------------ |
| `jobId`   | `string` | The full job id, as [`sqlane.enqueue`](#sqlaneenqueue) returns it. |

**Returns** a [`JobRecord`](#jobrecord-and-joberror), or `null` when no job has this id (also after cleanup).

**Errors.** `InvalidOptionsError` when `jobId` is not a string. Database and driver errors pass through. See
[Errors](#errors).

**Notes**

- **Job ids** are `<lane>:<dedupeKey>`, a schedule's job id, or a ULID. Pass the full id, not the dedupe key.
- **Strings that cannot be ids** (empty, over 255 characters, not printable ASCII, or with a leading or trailing
  space) resolve to `null` without a query.
- **`payload`** is included whenever the database holds one; a completed job has none.
- **`P`** is a TypeScript type only; sqlane does not check it.
- **Connections.** `get` reads with the adapter's pool, outside your transactions, without a lock. It works before
  `runner.start()` and after `close()`.

**Example**

```ts
const job = await sqlane.jobs.get<{ reportId: string }>(reportJobId);
```

### `sqlane.jobs.list`

Lists the jobs of one lane, newest first, one page at a time.

```ts
sqlane.jobs.list<J extends LaneDefinition | string>(
    filter: JobFilter<J>,
    options?: ListJobsOptions,
): Promise<JobPage<HandlerPayload<J>>>
```

**Filter**

| Field    | Type                                                | Default      | Description                                 |
| -------- | --------------------------------------------------- | ------------ | ------------------------------------------- |
| `lane`   | a lane definition or a lane name                    | required     | The lane whose jobs `list` returns.         |
| `status` | [`JobStatus`](#job-lifecycle) or a list of statuses | every status | Keeps only jobs with one of these statuses. |

**Options**

| Option           | Type             | Default | Description                                                    |
| ---------------- | ---------------- | ------- | -------------------------------------------------------------- |
| `limit`          | integer, 1–1000  | `100`   | The most jobs on one page.                                     |
| `cursor`         | `string \| null` | `null`  | The previous page's `nextCursor`; `null` reads the first page. |
| `includePayload` | `boolean`        | `false` | Adds each job's `payload` to its record.                       |

**Returns** a page:

| Field        | Type                                     | Description                                         |
| ------------ | ---------------------------------------- | --------------------------------------------------- |
| `jobs`       | [`JobRecord[]`](#jobrecord-and-joberror) | The jobs of the page, newest first.                 |
| `nextCursor` | `string \| null`                         | The next page's cursor, or `null` on the last page. |

**Errors.** `list` rejects with `InvalidOptionsError` when:

| Argument                              | Invalid when                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `filter` or `options`                 | Not an object, or has an unknown field; a known field set to `undefined` is absent. |
| `lane` or `status`                    | `lane` is invalid; `status` holds an unknown status, is empty or repeats one.       |
| `limit`, `includePayload` or `cursor` | A value is invalid, or `cursor` is not from `list` or belongs to another filter.    |

Database and driver errors pass through. See [Errors](#errors).

**Notes**

- **Order.** By `enqueuedAt`, then id in descending byte order; no two jobs tie.
- **Which jobs.** Finished ones too, until cleanup deletes them ([Retention](#retention)).
- **Typed payloads.** A lane definition gives `payload` the lane's type; a lane name gives `any`.
- **Connections.** As [`jobs.get`](#sqlanejobsget).

**Paging**

- Pass each `nextCursor` as `cursor` until it is `null`. Keep the same filter: leaving out `status` differs from
  listing all five. `limit` and `includePayload` may change.
- A cursor is opaque and works from any process on the same tables. It grants nothing: not an access token.
- A page may hold fewer jobs than `limit`, even none, while `nextCursor` is set.
- Each page applies `status` when read, and holds only jobs after the previous page's last. A job enqueued while you
  page shows only on a new first page.

**Example**

```ts
let cursor: string | null = null;
do {
    // The annotation keeps TypeScript from inferring page and cursor from each other
    const page: JobPage<{ reportId: string }> = await sqlane.jobs.list(
        { lane: buildReport, status: 'failed' },
        { limit: 50, cursor },
    );
    cursor = page.nextCursor;
} while (cursor !== null);
```

### `sqlane.jobs.retry`, `cancel` and `remove`

`retry` runs failed jobs again, `cancel` fails waiting jobs, and `remove` deletes jobs, many per call. They share
arguments, result and transaction rules. See [Job lifecycle](#job-lifecycle).

```ts
sqlane.jobs.retry(selector: JobSelector, options?: RetryOptions): Promise<BulkResult>
sqlane.jobs.cancel(selector: JobSelector, options?: BulkOptions): Promise<BulkResult>
sqlane.jobs.remove(selector: JobSelector, options?: BulkOptions): Promise<BulkResult>
```

| Method   | Changes jobs in status (never `running`)    | Default `status` of a filter |
| -------- | ------------------------------------------- | ---------------------------- |
| `retry`  | `failed`                                    | `'failed'`                   |
| `cancel` | `pending`, `blocked`                        | both                         |
| `remove` | `pending`, `blocked`, `completed`, `failed` | all four                     |

**Selector.** Either job ids or a filter:

| Field    | Type                                      | Description                                                   |
| -------- | ----------------------------------------- | ------------------------------------------------------------- |
| `jobIds` | `string[]`                                | Full job ids, 1 to 1000 distinct ones; repeats count once.    |
| `lane`   | a lane definition or a lane name          | Filter: the lane of the jobs.                                 |
| `status` | a status, or a non-empty list of statuses | Filter: only statuses that the method changes; default above. |

An id that cannot be a job id finds no job, as with [`jobs.get`](#sqlanejobsget).

**Options.** All optional; `undefined` counts as absent.

| Option                  | Type                                        | Default          | Description                                                        |
| ----------------------- | ------------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `connection`            | a connection, client or pool of your driver | the queue's pool | Where the call runs; see Transactions below.                       |
| `mode`                  | `'atomic'` \| `'batches'`                   | `'atomic'`       | One transaction for the call, or one per batch of up to 1000 jobs. |
| `strict`                | `boolean`                                   | `false`          | Rejects the whole call when any id would be ignored.               |
| `includeAffectedJobIds` | `boolean`                                   | `false`          | Adds the changed jobs' ids to the result.                          |
| `budget`                | `'reset'` \| `'one_more'`                   | `'reset'`        | `retry` only; see [`retry`](#sqlanejobsretry).                     |

**Returns** a `BulkResult`:

| Field            | Type               | Description                                                          |
| ---------------- | ------------------ | -------------------------------------------------------------------- |
| `affectedCount`  | `number`           | How many jobs the call changed.                                      |
| `affectedJobIds` | `string[]`         | The changed jobs' ids, unordered; only with `includeAffectedJobIds`. |
| `ignoredJobs`    | `BulkIgnoredJob[]` | With `jobIds`: each unchanged id, in order of first appearance.      |

`BulkIgnoredJob`:

| Field    | Type                                          | Description                                                                  |
| -------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `jobId`  | `string`                                      | The id, as you passed it.                                                    |
| `reason` | `'not_found'` \| `'status'` \| `'no_payload'` | No such job; a status the method does not change; or no payload for `retry`. |
| `status` | `JobStatus`                                   | The job's status, with `'status'` and `'no_payload'`.                        |

More reasons may come in a minor version: handle an unknown `reason`.

**Errors.**

| Error                 | When                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| `InvalidOptionsError` | The selector or an option is invalid or unknown, or two options do not go together. |
| `IgnoredJobsError`    | `strict` is `true` and the call would ignore some ids. The call changed nothing.    |

`IgnoredJobsError` has the code `IGNORED_JOBS` and an `ignoredJobs` list. Database and driver errors pass through.
See [Errors](#errors). Options that do not go together: `jobIds` with `lane`, or neither, or `status` with `jobIds`;
`strict` with a filter; `mode: 'batches'` with `jobIds`, `connection` or `strict`; `budget` with `cancel` or `remove`.

**Transactions.**

| Call                                  | Runs in                                                  | All or nothing | Run again after a deadlock |
| ------------------------------------- | -------------------------------------------------------- | -------------- | -------------------------- |
| No `connection`                       | A transaction of sqlane's own on the queue's pool.       | Yes            | Yes                        |
| `connection` is a pool                | A `READ COMMITTED` transaction of sqlane's own on it.    | Yes            | Yes                        |
| `connection` is in your transaction   | Your transaction: you commit, and a rollback undoes it.  | With yours     | No: you decide             |
| `connection` is outside a transaction | No transaction: one statement after another.             | No             | No                         |
| `mode: 'batches'`                     | One transaction of its own per batch of up to 1000 jobs. | No             | Yes, per batch             |

Open your transaction before you pass its connection. `mode: 'batches'` reads a filter's jobs in `jobs.list` order,
each at most once, so it ends even while new jobs arrive.

**After the commit**, sqlane:

| Method   | Work                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| `retry`  | Wakes the runners of the retried lanes.                                                             |
| `cancel` | Emits a `cancelled` [event](#events) per job, with `jobId`, `lane` and `attempt`; then as `remove`. |
| `remove` | Rechecks the global concurrency limit keys of `pending` jobs, so a blocked job may start.           |

In your transaction, `cancel` emits no event; the other work runs after your commit when the adapter can tell, else
at once. A failure here never rejects the call: sqlane emits an `error` event with the operation `after_commit` or
`unblock`.

**Notes**

- A job claimed by a runner during the call is left, and reported with its new status (or `not_found`).
- A call that is not all or nothing may have changed some jobs before it rejected. Rerun it without `strict`.
- No runner needed: they work before `runner.start()` and after `runner.close()`.

**Example**

```ts
try {
    await sqlane.jobs.cancel({ jobIds }, { strict: true });
} catch (error) {
    if (error instanceof IgnoredJobsError) console.warn(error.ignoredJobs);
    else throw error;
}
```

#### `sqlane.jobs.retry`

Runs `failed` jobs again: each becomes `pending` and may start now, keeping its id, `enqueuedAt` and payload.

```ts
sqlane.jobs.retry(selector: JobSelector, options?: RetryOptions): Promise<BulkResult>
```

Selector, other options and result: see [`retry`, `cancel` and `remove`](#sqlanejobsretry-cancel-and-remove).

**`budget`** sets the retried job's attempts:

| Value               | Effect on the job                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `'reset'` (default) | `attempts` and `stalls` go back to 0: full `maxAttempts` and `maxStalls` again.            |
| `'one_more'`        | `maxAttempts` becomes `attempts + 1`; `stalls` stays and `maxStalls` rises to it if lower. |

The new maximums stay: a later `'reset'` does not restore the enqueue's values.

**Notes**

- A `completed` job has no payload left: ignored as `'status'`. A failed job without a payload is skipped, reported
  as `'no_payload'` with `jobIds`.
- `finishedAt`, `expiresAt` and `blockedOn` become `null`; `lastError` stays until the next error.
- `runAt` is now, or later while an earlier run still keeps a place in a global concurrency limit key (after a
  [stall](#stalls) or a [release on close](#closing-a-runner)).
- An earlier [failure job](#failedjobpayload) stays; a new final failure adds another. `retry` emits no event.

**Example**

```ts
await sqlane.jobs.retry({ lane: sendEmail }, { budget: 'one_more', mode: 'batches' });
```

#### `sqlane.jobs.cancel`

Cancels `pending` and `blocked` jobs: each becomes `failed` at once, without running again.

```ts
sqlane.jobs.cancel(selector: JobSelector, options?: BulkOptions): Promise<BulkResult>
```

Selector, options and result: see [`retry`, `cancel` and `remove`](#sqlanejobsretry-cancel-and-remove).

**Notes**

- `finishedAt` becomes now, `blockedOn` `null`, `expiresAt` now plus the `failed` [retention](#retention).
- `lastError` becomes `{ name: 'JobCancelledError', message: 'Cancelled by jobs.cancel()', code: 'JOB_CANCELLED' }`,
  without a stack. A handler may throw the same error, so only a `cancelled` [event](#events) proves a cancel; a
  cancel in your transaction emits none.
- `attempts` and the payload stay, so `retry` can run the job again. No failure job is added.

**Example**

```ts
await sqlane.jobs.cancel({ lane: sendEmail });
```

#### `sqlane.jobs.remove`

Deletes jobs and their payloads, in any status but `running`.

```ts
sqlane.jobs.remove(selector: JobSelector, options?: BulkOptions): Promise<BulkResult>
```

Selector, options and result: see [`retry`, `cancel` and `remove`](#sqlanejobsretry-cancel-and-remove).

**Notes**

- Removing a job frees its dedupe key.
- A place that an earlier run still keeps in a global concurrency limit key stays until it frees.
- `remove` emits no event.

**Example**

```ts
await sqlane.jobs.remove({ jobIds: [`send_email:welcome-${userId}`] });
```

### `sqlane.jobs.keyStats`

Lists the global limit keys where jobs wait, worst first, for alerts on blocked jobs or full concurrency limit keys.

```ts
sqlane.jobs.keyStats(options?: KeyStatsOptions): Promise<KeyStatsPage>
```

| Option    | Type                        | Default     | Description                             |
| --------- | --------------------------- | ----------- | --------------------------------------- |
| `limit`   | integer, 1–1000             | `100`       | The most limit keys in the result.      |
| `type`    | `'concurrency'` \| `'rate'` | all types   | Only limit keys of this type.           |
| `orderBy` | `'blocked'` \| `'held'`     | `'blocked'` | Which limit keys come first; see Notes. |

**Returns** a `KeyStatsPage`:

| Field       | Type         | Description                                                   |
| ----------- | ------------ | ------------------------------------------------------------- |
| `keys`      | `KeyStats[]` | The limit keys, worst first.                                  |
| `truncated` | `boolean`    | `true` when more matched than `limit`; there is no next page. |

**Concurrency entries.** A limit key has `max` places, each held while a job runs in it. After a [stall](#stalls) or
a [release on close](#closing-a-runner), a place lingers a while, as the old handler may still run.

| Field                | Type             | Description                                                                              |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `type`               | `'concurrency'`  | The entry type.                                                                          |
| `key`                | `string`         | The full limit key, as in `JobRecord.globalConcurrencyLimits`.                           |
| `max`                | `number \| null` | The jobs that may run at once, or `null` when unknown.                                   |
| `held`               | `number`         | Places held by running jobs.                                                             |
| `lingering`          | `number`         | Places that ended runs still keep.                                                       |
| `blocked`            | `number`         | Jobs blocked on this limit key, up to 1000.                                              |
| `blockedTruncated`   | `boolean`        | `true` when more than 1000 are blocked.                                                  |
| `oldestBlockedAgeMs` | `number \| null` | Now minus the oldest blocked job's `runAt`; `null` when none.                            |
| `oldestHeldAgeMs`    | `number \| null` | Age of the oldest held or lingering place, from its run's `startedAt`; `null` when none. |

**Rate entries.**

| Field                | Type             | Description                                                                              |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `type`               | `'rate'`         | The entry type.                                                                          |
| `limit`              | `string`         | The rate limit's name.                                                                   |
| `key`                | `string \| null` | The limit key value, or `null` for the limit itself, as in `JobRecord.globalRateLimits`. |
| `blocked`            | `number`         | Jobs blocked on this limit key, up to 1000.                                              |
| `blockedTruncated`   | `boolean`        | `true` when more than 1000 are blocked.                                                  |
| `oldestBlockedAgeMs` | `number`         | Now minus the oldest blocked job's `runAt`.                                              |
| `nextStartInMs`      | `number`         | Milliseconds until the oldest blocked job may start; `0` means now.                      |

`type` may gain members in a minor version: give a `switch` on it a `default` branch.

**Errors.** `InvalidOptionsError` when an option is invalid or unknown, or for `orderBy: 'held'` with `type: 'rate'`.
`undefined` counts as absent.

**Notes**

- **Listed:** a concurrency limit key with blocked jobs or held or lingering places; a rate limit key with blocked
  jobs. Never local limits.
- **`'blocked'` order:** by `oldestBlockedAgeMs`, oldest first; limit keys without blocked jobs last.
- **`'held'` order:** concurrency limit keys with held or lingering places, by `oldestHeldAgeMs`; then the other
  concurrency limit keys; then rate limit keys, by `oldestBlockedAgeMs`.
- **Ties** go by stored limit key, in byte order.
- A job counts only on the limit key in its `JobRecord.blockedOn`.
- A job becomes `blocked` only when a runner tries to claim it, so a lane that no process runs shows nothing here: use
  `oldestDueAgeMs` of [`sqlane.lanes.stats`](#sqlanelanesstats).
- `max` comes from the jobs at enqueue, so it may differ after a deploy; `null` when no blocked or running job carries
  the limit key.
- Ages are whole milliseconds from one database time per call. Poll at alert pace, such as once a minute: cost grows
  with blocked limit keys. No runner needed.

**Example**

```ts
const [worst] = (await sqlane.jobs.keyStats({ limit: 10 })).keys;
if ((worst?.oldestBlockedAgeMs ?? 0) > 5 * 60_000) console.error('sqlane: jobs blocked > 5 min', worst);
```

### `sqlane.lanes.stats`

Counts the jobs of each lane by status, for dashboards and alerts.

```ts
sqlane.lanes.stats(): Promise<LaneStats[]>
```

**Returns** a promise of one `LaneStats` per lane that has jobs in any status or is paused by
[`lanes.pauseGlobally`](#sqlanelanespauseglobally-and-resumeglobally), sorted by lane name.

| Field            | Type             | Description                                                                         |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `name`           | `string`         | The name of the lane.                                                               |
| `pending`        | `number`         | The jobs that wait to run, whether their run time has come or not.                  |
| `due`            | `number`         | The pending jobs whose run time has come; they are part of `pending`.               |
| `blocked`        | `number`         | The jobs that wait for a full global concurrency limit key or for rate limit quota. |
| `running`        | `number`         | The jobs that run now, in every process.                                            |
| `stuck`          | `number`         | The running jobs past their `timeout` whose handler has not settled yet.            |
| `failed`         | `number`         | The failed jobs that sqlane still keeps.                                            |
| `completed`      | `number`         | The completed jobs that sqlane still keeps.                                         |
| `oldestDueAgeMs` | `number \| null` | How long the oldest due pending job has waited, in milliseconds; `null` when none.  |
| `pausedGlobally` | `boolean`        | `true` while `lanes.pauseGlobally` holds the lane.                                  |

**Errors.** `stats` rejects with `ConfigError` when the schema is not migrated. Errors from the database pass through
unchanged.

**Notes**

- **No runner needed.** `stats` reads the database, so it covers every lane.
- **`failed` and `completed`** count a job until cleanup, a little after its [retention](#retention).
- **`blocked`** jobs do not count in `oldestDueAgeMs`. When `blocked` grows, see
  [`jobs.keyStats`](#sqlanejobskeystats).
- **Paused lanes.** Their `due` and `oldestDueAgeMs` keep growing: skip them in alerts.
- **Cost.** `stats` reads every job row sqlane keeps: poll it every few seconds at most.

**Example**

```ts
for (const lane of await sqlane.lanes.stats()) {
    if (!lane.pausedGlobally && (lane.oldestDueAgeMs ?? 0) > 5 * 60_000) {
        logger.warn(`Lane ${lane.name} has waited ${lane.oldestDueAgeMs} ms`);
    }
}
```

### `sqlane.lanes.groupStats`

Counts the jobs of each [fair group](#fair-groups) of one lane, worst first.

```ts
sqlane.lanes.groupStats(lane: LaneDefinition | string, options?: GroupStatsOptions): Promise<GroupStatsPage>
```

| Parameter | Type                             | Description                      |
| --------- | -------------------------------- | -------------------------------- |
| `lane`    | a lane definition or a lane name | The lane whose groups you count. |

| Option    | Type                         | Default       | Description                              |
| --------- | ---------------------------- | ------------- | ---------------------------------------- |
| `limit`   | integer, 1–1000              | `100`         | The most groups in the result.           |
| `orderBy` | `'oldestDue'` \| `'pending'` | `'oldestDue'` | Which groups come first (see the notes). |

**Returns** a promise of `{ groups, truncated }`: `groups` holds at most `limit` `GroupStats`, worst first, and
`truncated` is `true` when more groups matched. A `GroupStats` has `fairGroup` (`string | null`; `null` stands for the
jobs without a group) and the `pending`, `due`, `blocked`, `running` and `oldestDueAgeMs` fields of
[`LaneStats`](#sqlanelanesstats), for that group.

**Errors.**

| Error                 | When                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `InvalidOptionsError` | `lane` is neither a lane definition nor a lane name, or an option is invalid or unknown.   |
| `ConfigError`         | The migration `0011_fair_groups` is missing: run [`schema.migrate`](#sqlaneschemamigrate). |

**Notes**

- **Which groups.** A group is listed while it has a pending, blocked or running job. A lane without groups returns
  one entry, with `fairGroup: null`.
- **Order.** `'oldestDue'`: largest `oldestDueAgeMs` first, groups with no due job last. `'pending'`: most pending
  jobs first. Ties go by group name in byte order, with the `null` group last.
- **No cursor.** To see more groups, raise `limit`.
- **Paused lanes.** `oldestDueAgeMs` keeps growing: check `pausedGlobally` in [`lanes.stats`](#sqlanelanesstats).
- **Cost.** It reads every unfinished job of the lane: poll it every few seconds at most. No runner is needed.

**Example**

```ts
const { groups } = await sqlane.lanes.groupStats(sendEmail, { limit: 20 });
const late = groups.filter(group => (group.oldestDueAgeMs ?? 0) > 10 * 60_000);
```

### `sqlane.lanes.pauseGlobally` and `resumeGlobally`

Stops every process from starting jobs of a lane, until you resume it; the pause holds across restarts and deploys.

```ts
sqlane.lanes.pauseGlobally(lane: LaneDefinition | string, options?: PauseGloballyOptions): Promise<void>
sqlane.lanes.resumeGlobally(lane: LaneDefinition | string, options?: PauseGloballyOptions): Promise<void>
```

| Parameter | Type                             | Description                  |
| --------- | -------------------------------- | ---------------------------- |
| `lane`    | a lane definition or a lane name | The lane to pause or resume. |

| Option       | Type                                        | Default          | Description                                     |
| ------------ | ------------------------------------------- | ---------------- | ----------------------------------------------- |
| `connection` | a connection, client or pool of your driver | the queue's pool | The connection that sqlane writes the pause on. |

**Returns** a promise that resolves once sqlane has written the change.

**Errors.**

| Error                 | When                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `InvalidOptionsError` | `lane` is neither a lane definition nor a lane name, or `options` has an unknown option. |
| `ConfigError`         | The schema is not migrated.                                                              |

Errors from the database or the driver pass through unchanged.

**Notes**

- **What stops.** No runner, in any process, claims a job of the lane; each sees the pause at its next poll at the
  latest. Running jobs finish. Enqueues and schedules go on: their jobs wait as pending.
- **Blocked jobs** of a paused lane stay blocked and take no room of their limit keys. On resume, sqlane makes them
  pending as far as their limit keys have room or quota. Runners start the lane at their next poll, or sooner.
- **Any lane name** works, also one with no job yet. Both methods are idempotent.
- **`connection`.** A connection inside your transaction applies the change on commit; a rollback discards it.
- **Seeing the pause.** [`lanes.stats`](#sqlanelanesstats) shows `pausedGlobally: true`.
- **One process only.** To hold a lane in this runner only, use
  [`runner.pauseLocally`](#runnerpauselocally-and-resumelocally).

**Example**

```ts
await sqlane.lanes.pauseGlobally(sendEmail); // the mail provider is down
await sqlane.lanes.resumeGlobally(sendEmail);
```

### `sqlane.schedules.list`

Lists every schedule stored in the database, from all processes, with its next slot, its last job and its pause state.

```ts
sqlane.schedules.list(): Promise<ScheduleInfo[]>
```

**Returns** a promise of an array of `ScheduleInfo`, sorted by `id`. A schedule appears once a started runner has
mounted it, or once [`schedules.pauseGlobally`](#sqlaneschedulespauseglobally-and-resumeglobally) has created its row.
Before the schedules table exists, it resolves to `[]`.

| Field            | Type             | Description                                                                        |
| ---------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `id`             | `string`         | The schedule id: `<lane>:<key>`, where key is the schedule key.                    |
| `lane`           | `string`         | The name of the lane that gets the schedule's jobs.                                |
| `spec`           | `string`         | The stored timing: `cron <fields> <time zone>` or `every <milliseconds>`.          |
| `nextAt`         | `Date \| null`   | The next slot, computed from `spec` and the database clock.                        |
| `nextRunAt`      | `Date \| null`   | The time at which the next slot's job may start, jitter included when known.       |
| `lastSlotAt`     | `Date`           | The latest slot that a runner has handled.                                         |
| `lastJobId`      | `string \| null` | The id of the job of the latest slot that added a job.                             |
| `pausedGlobally` | `boolean`        | `true` while `schedules.pauseGlobally` holds the schedule, so no process fires it. |

**Errors.** `list` rejects with `ConfigError` when the schedules table exists but lacks a later migration: run
[`schema.migrate`](#sqlaneschemamigrate). Errors from the database or the driver pass through unchanged.

**Notes**

- **`spec`**, such as `cron 0 3 * * * Europe/Berlin`, keeps the old timing after a deploy until a runner fires the
  new one. A schedule paused by id before any runner mounted it shows `unknown`.
- **`nextAt` and `nextRunAt` are `null`** while the schedule is paused, or when this version cannot read `spec`.
- **Jitter** is in `nextRunAt` only when this process's runner mounts the schedule with the same `spec`.
- No runner is needed. How slots fire: see [Schedules](#schedules).

**Example.** Flag a schedule whose last slot is older than a day:

```ts
const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
const stale = (await sqlane.schedules.list())
    .filter(schedule => !schedule.pausedGlobally && schedule.lastSlotAt.getTime() < dayAgo);
```

### `sqlane.schedules.runSlot`

Adds the job of one slot of a schedule by hand, as a runner would add it.

```ts
sqlane.schedules.runSlot(schedule: ScheduleDefinition, options?: RunSlotOptions): Promise<{ id: string, created: boolean }>
```

| Parameter  | Type                  | Description                                                      |
| ---------- | --------------------- | ---------------------------------------------------------------- |
| `schedule` | a schedule definition | The schedule, as [`defineSchedule`](#defineschedule) returns it. |

| Option       | Type                                        | Default                          | Description                                                 |
| ------------ | ------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `at`         | `Date`                                      | the latest slot at or before now | The slot to run: a slot of the schedule, not in the future. |
| `connection` | a connection, client or pool of your driver | the queue's pool                 | The connection that sqlane uses to write the job.           |

**Returns** a promise of `{ id, created }`, as [`sqlane.enqueue`](#sqlaneenqueue) returns it. `created` is `false`
when the slot's job exists already.

**Errors.** `runSlot` rejects with `InvalidOptionsError`, and adds no job, when:

| Argument   | Invalid when                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `schedule` | It is not a schedule definition; an id string is not one.                                              |
| `at`       | Not a valid `Date` in 1970–9999, in the future or not a slot; or omitted, and no slot lies before now. |
| `options`  | It holds an unknown option.                                                                            |

Errors from the database or the driver pass through unchanged.

**Notes**

- **What it adds.** The job gets the schedule's payload, the slot's dedupe key and the lane's options. It ignores
  jitter and `overlap`, so it may start at once.
- **Progress.** `runSlot` changes neither `lastSlotAt` nor `lastJobId`; a runner that later fires the slot records the
  existing job. It adds the job even while the schedule is paused.
- **The default `at`** uses this process's clock; runners use the database clock.
- **`connection`** works as in [`sqlane.enqueue`](#sqlaneenqueue).

**Example.** A test of a nightly report:

```ts
await sqlane.schedules.runSlot(nightlyReport); // or { at: new Date('2026-11-24T02:00:00Z') } for a missed day
await runner.drain();
```

### `sqlane.schedules.pauseGlobally` and `resumeGlobally`

Stops a schedule from firing in every process, and lets it fire again.

```ts
sqlane.schedules.pauseGlobally(schedule: ScheduleDefinition | string, options?: PauseGloballyOptions): Promise<void>
sqlane.schedules.resumeGlobally(schedule: ScheduleDefinition | string, options?: PauseGloballyOptions): Promise<void>
```

| Parameter  | Type                               | Description                             |
| ---------- | ---------------------------------- | --------------------------------------- |
| `schedule` | a schedule definition, or `string` | The schedule, or its id `<lane>:<key>`. |

| Option       | Type                                        | Default          | Description                                         |
| ------------ | ------------------------------------------- | ---------------- | --------------------------------------------------- |
| `connection` | a connection, client or pool of your driver | the queue's pool | The connection that sqlane uses to write the pause. |

**Returns** a promise that resolves once sqlane has written the change.

**Errors.**

| Error                 | When                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `InvalidOptionsError` | `schedule` is neither a schedule definition nor a valid schedule id, or `options` holds an unknown option. |
| `ConfigError`         | The schema is not migrated.                                                                                |

Errors from the database or the driver pass through unchanged.

**Notes**

- **While paused,** no process fires the schedule: its slots add no job and emit no event. The pause is in the
  database, so it holds across restarts and deploys. A slot being fired at the moment of the pause may still add its
  job.
- **Existing jobs** stay. To hold them, use [`lanes.pauseGlobally`](#sqlanelanespauseglobally-and-resumeglobally).
- **Resume skips the pause.** Runners do not catch up its slots, whatever `missed` says.
- **No row yet.** `pauseGlobally` creates the row, paused, with `spec: 'unknown'` until its first fire. Delete a row
  from a mistyped id with [`schedules.remove`](#sqlaneschedulesremove).
- **Idempotent.** Resuming a schedule that is not paused, or has no row, changes nothing.
- **Seeing the state.** [`schedules.list`](#sqlanescheduleslist) shows `pausedGlobally: true` and `nextAt: null`.
- No runner is needed. How slots fire and catch up: see [Schedules](#schedules).

**Example**

```ts
await sqlane.schedules.pauseGlobally('build_report:nightly');
await migrateReportData();
await sqlane.schedules.resumeGlobally('build_report:nightly');
```

### `sqlane.schedules.remove`

Deletes a schedule's row from the database: its progress, its last job id and its pause.

```ts
sqlane.schedules.remove(schedule: ScheduleDefinition | string, options?: PauseGloballyOptions): Promise<{ removed: boolean }>
```

It takes the parameters of [`schedules.pauseGlobally`](#sqlaneschedulespauseglobally-and-resumeglobally).

**Returns** a promise of `{ removed }`: `false` when no row existed.

**Errors.** As for [`schedules.pauseGlobally`](#sqlaneschedulespauseglobally-and-resumeglobally).

**Notes**

- **Use it** for a schedule deleted from your code, or a row a mistyped id created. Its jobs stay.
- **A schedule still mounted** by a started runner gets its row back at its next fire, not paused.

**Example**

```ts
const { removed } = await sqlane.schedules.remove('build_report:nightly');
```

### `sqlane.schema.migrate`

Creates or updates the tables of sqlane: it applies the missing migrations, in order.

```ts
sqlane.schema.migrate(options?: MigrateOptions): Promise<{ applied: string[] }>
```

| Option          | Type                     | Default         | Description                                                             |
| --------------- | ------------------------ | --------------- | ----------------------------------------------------------------------- |
| `targetVersion` | `'X.Y.Z'`                | every migration | Applies only the migrations of this sqlane version and the ones before. |
| `lockTimeout`   | [`Duration`](#durations) | `'10m'`         | How long `migrate` waits for another process that is migrating.         |

**Returns** a promise of `{ applied }`: the ids of the applied migrations, in order, such as `0009_lanes`; empty when
none is missing.

**Errors.**

| Error                       | When                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `InvalidOptionsError`       | `lockTimeout` is invalid, or `targetVersion` is not a valid version (see the notes).            |
| `MigrationLockTimeoutError` | Another process holds the migration lock for longer than `lockTimeout`.                         |
| `ConfigError`               | The database server is not the adapter's dialect, is too old, or has an unsupported `sql_mode`. |
| `ClosedError`               | You call it after `sqlane.close()`.                                                             |

**Notes**

- **When to call it.** At deploy, before any process of the new version runs jobs. `createSqlane` and
  `runner.start()` never migrate. Concurrent calls are safe: one applies.
- **`targetVersion`** is `'X.Y.Z'`, from `'6.0.0'` up to the installed version (an installed `10.0.0-rc.1` counts as
  `10.0.0`). `'v9.0.0'`, `'9.0'` and pre-releases are invalid.
- **Required and optional.** A migration up to `X.0.0` of the installed major version is required. A later one is
  optional: only its feature needs it, such as `0011_fair_groups` for a [`fairGroup`](#fair-groups).
- **The server check** runs at the first `migrate()` or `runner.start()` of an instance, and again after a failure.

**Running it from your own migration tool.** Each migration file calls `migrate` with a pinned version. Its `down`
calls [`rollback`](#sqlaneschemarollback) to the previous version, or [`drop`](#sqlaneschemadrop) in the first file.
Run it outside your tool's transaction, with your app's `tablePrefix` and, in `down`, a short `lockTimeout`.

**Example.** A Knex migration file; `config` makes Knex run it without a transaction:

```ts
// migrations/20261101_sqlane_10_0_0.ts
import type { Knex } from 'knex';
import { createSqlane } from '@sqlane/core';
import { knexAdapter } from '@sqlane/core/adapter-knex';

export const config = { transaction: false };

const sqlaneOf = (knex: Knex) => createSqlane({ adapter: knexAdapter(knex, { dialect: 'postgres' }) });

export async function up(knex: Knex) {
    await sqlaneOf(knex).schema.migrate({ targetVersion: '10.0.0' });
}

export async function down(knex: Knex) {
    await sqlaneOf(knex).schema.rollback({ targetVersion: '9.0.0', lockTimeout: '10s' });
}
```

### `sqlane.schema.rollback`

Takes the tables back to an older sqlane version: it reverts the migrations tagged above that version, newest first.

```ts
sqlane.schema.rollback(options: RollbackOptions): Promise<{ reverted: string[] }>
```

| Option          | Type                     | Default  | Description                                                            |
| --------------- | ------------------------ | -------- | ---------------------------------------------------------------------- |
| `targetVersion` | `'X.Y.Z'`                | required | The version to go back to, from `'6.0.0'` up to the installed version. |
| `lockTimeout`   | [`Duration`](#durations) | `'10m'`  | How long it waits for the migration lock, and for each table's lock.   |

**Returns** a promise of `{ reverted }`: the ids of the reverted migrations, newest first; empty when none is above
`targetVersion` or sqlane has no tables.

**Errors.**

| Error                       | When                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `InvalidOptionsError`       | `targetVersion` is missing or invalid, or `lockTimeout` is invalid.                                 |
| `MigrationLockTimeoutError` | The migration lock or a table's lock is not free within `lockTimeout`.                              |
| `ConfigError`               | A newer version applied a migration unknown here, or this instance's runner is started or draining. |
| `ClosedError`               | You call it after `sqlane.close()`.                                                                 |

**Notes**

- **`targetVersion`** follows the rules of [`migrate`](#sqlaneschemamigrate).
- **Data loss.** A reverted migration that drops a column or table loses its data.
- **Who may run.** Only when no process of a newer version uses the tables.
- **Lock waits.** The queue's queries wait behind the rollback's table locks: pass a short `lockTimeout`, such as
  `'10s'`.
- **A cut rollback,** after a crash or a timeout, finishes when you run it again.

**Example.** See the `down` in [`migrate`](#sqlaneschemamigrate):

```ts
const { reverted } = await sqlane.schema.rollback({ targetVersion: '9.0.0', lockTimeout: '10s' });
```

### `sqlane.schema.drop`

Drops every table of sqlane under the table prefix, with all its data.

```ts
sqlane.schema.drop(options?: DropOptions): Promise<{ dropped: string[] }>
```

| Option        | Type                     | Default | Description                                                          |
| ------------- | ------------------------ | ------- | -------------------------------------------------------------------- |
| `lockTimeout` | [`Duration`](#durations) | `'10m'` | How long it waits for the migration lock, and for the tables' locks. |

**Returns** a promise of `{ dropped }`: the tables that existed, in drop order, with `<prefix>migrations` last; empty
when no table exists.

**Errors.**

| Error                       | When                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `InvalidOptionsError`       | `lockTimeout` is invalid.                                                                           |
| `MigrationLockTimeoutError` | The migration lock or a table's lock is not free within `lockTimeout`.                              |
| `ConfigError`               | The tables under the prefix were not created by sqlane. It drops nothing.                           |
| `ConfigError`               | A newer version applied a migration unknown here, or this instance's runner is started or draining. |
| `ClosedError`               | You call it after `sqlane.close()`.                                                                 |

**Notes**

- **Any version.** `drop` removes the tables of every sqlane version.
- **Stop the other processes first:** every process that uses the same table prefix.
- **Your own tables** stay, but choose a `tablePrefix` that none of them starts with.

**Example.** A test teardown:

```ts
afterAll(async () => {
    await sqlane.schema.drop();
    await sqlane.close();
});
```

### `sqlane.schema.getMigrationStatus`

Tells which migrations are missing from the database, by the records that [`migrate`](#sqlaneschemamigrate) keeps.

```ts
sqlane.schema.getMigrationStatus(): Promise<MigrationStatus>
```

**Returns** a promise of a `MigrationStatus`:

| Field             | Type       | Description                                                                       |
| ----------------- | ---------- | --------------------------------------------------------------------------------- |
| `ok`              | `boolean`  | `true` when `missingRequired` is empty.                                           |
| `missingRequired` | `string[]` | The ids of missing migrations that this version's queries need.                   |
| `missingOptional` | `string[]` | The ids of missing migrations that only some features need.                       |
| `unknownApplied`  | `string[]` | The ids of applied migrations that this version does not know; `ok` ignores them. |

**Notes**

- **Required or optional:** see [`migrate`](#sqlaneschemamigrate). With no tables, every migration is missing.
- **A read only.** It never rejects because of a mismatch; database errors still reject.
- **Records, not tables.** To check the tables themselves, use [`findSchemaProblems`](#sqlaneschemafindschemaproblems).
- **Not automatic.** Call it at boot, in a readiness probe or in a deploy check.

**Example**

```ts
const status = await sqlane.schema.getMigrationStatus();
if (!status.ok) throw new Error(`Missing sqlane migrations: ${status.missingRequired.join(', ')}`);
```

### `sqlane.schema.findSchemaProblems`

Checks that the tables, columns and indexes this version needs exist in the database, as they really are.

```ts
sqlane.schema.findSchemaProblems(): Promise<SchemaProblems>
```

**Returns** a promise of `{ ok, problems }`: `problems` lists every `SchemaProblem` found, and `ok` is `true` when
none has `required: true`. Each `SchemaProblem` has these fields:

| Field      | Type          | Description                                                                                          |
| ---------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `table`    | `string`      | The table, with its prefix.                                                                          |
| `column`   | `string`      | The column, for a column problem.                                                                    |
| `index`    | `string`      | The index, with its prefix, for an index problem; the primary key of MySQL and MariaDB is `PRIMARY`. |
| `issue`    | `SchemaIssue` | What is wrong (see the table below).                                                                 |
| `expected` | `string`      | What this version expects, for a wrong type, nullability or index.                                   |
| `found`    | `string`      | What the database has, for a wrong type, nullability or index.                                       |
| `required` | `boolean`     | `false` when the problem comes from an optional migration.                                           |

| `issue`             | Meaning                                                      |
| ------------------- | ------------------------------------------------------------ |
| `missing_table`     | The table does not exist.                                    |
| `missing_column`    | The column does not exist.                                   |
| `wrong_type`        | The column has another type.                                 |
| `wrong_nullability` | The column allows `NULL` when it should not, or the reverse. |
| `missing_index`     | The index does not exist.                                    |
| `wrong_index`       | The index exists but differs.                                |

**Notes**

- **What it compares.** The tables, columns and indexes of this version's migrations, by name, in the connection's
  current schema only. It ignores extras, so you may add your own. It can disagree with `getMigrationStatus` after a
  hand edit.
- **A read only.** It never rejects because of a mismatch; database errors still reject.
- **Not automatic.** No sqlane method calls it: check it yourself, also in processes that only enqueue.

**Example.** A readiness probe:

```ts
app.get('/ready', async (req, res) => {
    const [status, schema] = await Promise.all([
        sqlane.schema.getMigrationStatus(),
        sqlane.schema.findSchemaProblems(),
    ]);
    const ready = status.ok && schema.ok;
    res.status(ready ? 200 : 503).json({ missing: status.missingRequired, problems: schema.problems });
});
```

### `sqlane.close`

Closes the runner of this process, if any, then stops waking the other processes.

```ts
sqlane.close(options?: CloseOptions): Promise<void>
```

It takes the options of [`runner.close`](#runnerclose) and passes them to the runner.

**Returns** a promise that resolves once the runner is closed and sqlane has stopped its [`hint`](#hint). A second
call returns the same promise.

**Errors.** `close` never rejects because of its options.

**What it adds to `runner.close`**

- **Wake-ups stop.** sqlane drops the wake-ups it has not sent: those jobs run at the next poll.
- **The instance is closed at once.** `createRunner(sqlane)` throws `ClosedError`, and `schema.migrate`, `rollback`
  and `drop` reject with it. `enqueue`, `enqueueMany` and the reads still work, without waking other processes.
- **Your pools** and `hint` connections stay open: end them after `close`.

Call `sqlane.close` at shutdown; call `runner.close` alone in a process that keeps enqueueing.

**Example**

```ts
process.once('SIGTERM', async () => {
    await sqlane.close({ deadline: '30s' });
    await queuePool.end();
});
```

## sqlane runner

A runner claims and runs jobs, and fires schedules, in this process. A process that only enqueues needs no runner. A
lane runs here when its handler is mounted here and no pause holds it.

All runner methods are synchronous, except `start`, `drain` and `close`.

### `createRunner`

Creates the runner of this process for a sqlane instance.

```ts
createRunner(sqlane: Sqlane<any>, options?: RunnerOptions): Runner
```

| Option                | Type        | Default                      | Description                                          |
| --------------------- | ----------- | ---------------------------- | ---------------------------------------------------- |
| `localMaxConcurrency` | integer ≥ 1 | `10`                         | How many handlers this runner runs at the same time. |
| `logger`              | `Logger`    | the sqlane instance's logger | Where the runner writes its logs.                    |

**Returns** a frozen `Runner`. Its events go to the `onEvent` of the sqlane instance (see
[`createSqlane`](#createsqlane)).

**Errors.** `createRunner` throws synchronously:

| Error         | When                                                                   |
| ------------- | ---------------------------------------------------------------------- |
| `ConfigError` | An option is invalid or unknown.                                       |
| `ConfigError` | The sqlane instance has a runner already.                              |
| `ConfigError` | `sqlane` is not a sqlane instance made by this copy of `@sqlane/core`. |
| `ClosedError` | You called [`sqlane.close`](#sqlaneclose) before.                      |

**Notes**

- **One runner per sqlane instance**, even after [`runner.close`](#runnerclose). To run jobs again, create a new
  instance.
- **`localMaxConcurrency`** caps all lanes together: see
  [How a runner shares `localMaxConcurrency`](#how-a-runner-shares-localmaxconcurrency).
- The runner uses the instance's `pollInterval` and `cleanup`.

**Example**

```ts
export const runner = createRunner(sqlane, { localMaxConcurrency: 20 });
```

### `runner.mount`

Adds handlers and schedules to this runner.

```ts
runner.mount(parts: readonly (LaneHandler | ScheduleDefinition)[]): Mount
```

| Parameter | Type                            | Description                                                                                             |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `parts`   | array of handlers and schedules | Handlers from [`defineHandler`](#definehandler) and schedules from [`defineSchedule`](#defineschedule). |

**Returns** a frozen `Mount`. Its [`unmount()`](#mountunmount) removes all the parts of this call.

**Errors.** `mount` checks all parts first. When it throws, it mounts nothing.

| Error         | When                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `ConfigError` | `parts` is not an array, or a part is neither a handler nor a schedule.                                         |
| `ConfigError` | A lane has a handler mounted here already, or `parts` holds two handlers of one lane.                           |
| `ConfigError` | A schedule with the same id is mounted here already, or `parts` holds it twice.                                 |
| `ConfigError` | Two different lane definitions share one name, among the mounted lanes, their failure lanes and schedule lanes. |
| `ConfigError` | Two handlers use local limits of one name with different settings.                                              |
| `ConfigError` | A lane has `globalConcurrencyLimits` but no `timeout`, in its definition or in `createSqlane({ defaults })`.    |
| `ConfigError` | A schedule's job would be refused at enqueue, for example for its payload size or its global limits.            |
| `ConfigError` | [`runner.drain()`](#runnerdrain) is running.                                                                    |
| `ClosedError` | The runner is closed.                                                                                           |

**Notes**

- **Any time.** After [`runner.start()`](#runnerstart), new parts take effect at once.
- **Schedules.** A mounted schedule fires here even without a handler of its lane. See [Schedules](#schedules).
- **The handler** runs outside any transaction; see [How a handler ends](#how-a-handler-ends). Its options apply to
  this runner only.

**Example**

```ts
runner.mount([
    defineHandler(sendEmail, async ({ payload, signal }) => {
        await mailer.send(payload.to, { signal });
    }),
    defineSchedule(buildReport, { key: 'hourly', cron: '0 * * * *', payload: { reportId: 'hourly' } }),
]);
```

#### `Mount.unmount`

Removes all the parts of one `runner.mount()` call from this runner, at once.

```ts
mount.unmount(): void
```

**Errors.** `unmount` throws `ConfigError` while [`runner.drain()`](#runnerdrain) runs. After
[`runner.close`](#runnerclose), it does nothing.

**Notes**

- The runner stops claiming the mount's lanes and firing its schedules. Running jobs finish with their old handler;
  `runner.close()` waits for them.
- You can mount the same lanes again at once. The old running jobs count toward the new handler's local limits.
- A second call does nothing.

**Example.** Swap a handler:

```ts
emailMount.unmount();
emailMount = runner.mount([makeEmailHandler(nextConfig)]);
```

### `runner.start`

Starts claiming jobs and firing mounted schedules in this process.

```ts
runner.start(): Promise<void>
```

**Returns** a promise that resolves once started. Then the runner:

- claims and runs the due jobs of the mounted lanes that no pause holds;
- renews the leases of its running jobs, and makes stalled jobs of any process pending again (see [Stalls](#stalls));
- deletes the jobs whose retention has ended, unless `createSqlane({ cleanup: false })` (see [Retention](#retention));
- adds the rows of its mounted schedules, and fires those that no global pause holds.

**Errors.**

| Error         | When                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `ConfigError` | The sqlane tables are missing or out of date: run [`sqlane.schema.migrate()`](#sqlaneschemamigrate). |
| `ConfigError` | The database server does not match the adapter's `dialect`, or fails its check.                      |
| `ConfigError` | [`runner.drain()`](#runnerdrain) is running.                                                         |
| `ClosedError` | The runner is closed.                                                                                |

**Notes**

- **Database down.** `start` resolves anyway, emits an `error` [event](#events), and retries on its own; it claims
  nothing until its checks pass.
- After a rejected start, you can call `start()` again. A second call to a started runner does nothing.

**Example**

```ts
await sqlane.schema.migrate();

const runner = createRunner(sqlane);
runner.mount([defineHandler(sendEmail, ({ payload }) => mailer.send(payload.to))]);
await runner.start();
```

### `runner.drain`

Runs the due jobs of the mounted lanes until none is left, without `start()`: for tests and scripts.

```ts
runner.drain(options?: DrainOptions): Promise<DrainResult>
```

| Option           | Type                     | Default | Description                                            |
| ---------------- | ------------------------ | ------- | ------------------------------------------------------ |
| `timeout`        | [`Duration`](#durations) | `'10s'` | How long `drain` may run before it rejects.            |
| `includeDelayed` | `boolean`                | `false` | Also runs delayed jobs and retries in backoff at once. |

**Returns** a promise of `{ completed, retried, failed }`, once no due job of the mounted, unpaused lanes is left:

| Field       | Type     | Description                               |
| ----------- | -------- | ----------------------------------------- |
| `completed` | `number` | The jobs that completed.                  |
| `retried`   | `number` | The failed attempts that will be retried. |
| `failed`    | `number` | The jobs that failed for good.            |

**Errors.**

| Error                 | When                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `DrainTimeoutError`   | The drain did not finish within `timeout`; its code is `DRAIN_TIMEOUT`.                              |
| `InvalidOptionsError` | `timeout` is not a valid duration.                                                                   |
| `ConfigError`         | The runner has started, or is starting.                                                              |
| `ConfigError`         | Another `drain()` runs.                                                                              |
| `ConfigError`         | The sqlane tables are missing or out of date: run [`sqlane.schema.migrate()`](#sqlaneschemamigrate). |
| `ClosedError`         | The runner is closed.                                                                                |

**Notes**

- `drain` fires no schedule: call [`sqlane.schedules.runSlot`](#sqlaneschedulesrunslot).
- **During a drain**, `mount`, [`unmount`](#mountunmount) and `start` throw `ConfigError`; a pause applies to the
  next claims.
- **Retries in tests.** A failed attempt waits for its backoff: call `drain({ includeDelayed: true })` once per
  attempt to run it at once.

**Example.** A test:

```ts
beforeAll(() => sqlane.schema.migrate());

test('sends the email', async () => {
    runner.mount([defineHandler(sendEmail, ({ payload }) => { sent.push(payload.to); })]);
    await sqlane.enqueue(queuePool, sendEmail, { to: 'ana@example.com' });

    const { completed } = await runner.drain();
    assert.equal(completed, 1);
});
```

For the teardown, see [`schema.drop`](#sqlaneschemadrop).

### `runner.close`

Stops the runner of this process. It claims no more jobs and gives the running handlers time to finish before it stops
them.

```ts
runner.close(options?: CloseOptions): Promise<void>
```

| Option     | Type                       | Default                                          | Description                                                                |
| ---------- | -------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `deadline` | [`Duration`](#durations)   | `'30s'`                                          | How long close waits for the running handlers, from the call.              |
| `mode`     | `'release'` \| `'abandon'` | `'release'`                                      | What happens to the jobs whose handlers have not finished by the deadline. |
| `exitsBy`  | [`Duration`](#durations)   | `deadline` plus 4 minutes (`'4m30s'` by default) | The latest time your process exits, from the call; at least `deadline`.    |

**Returns** a promise that resolves once every handler settled or the deadline passed, and unfinished jobs are
released.

**Errors.** `close` never rejects. An invalid or unknown option logs a warning and falls back to its default. A failed
release write emits an `error` [event](#events).

**Notes**

- **On the call.** No new claims or schedule fires; a fire already started completes. Leases of running jobs keep
  renewing until the deadline.
- **At the deadline.** Each unfinished handler's `signal` aborts with a `ShutdownError` (code `SHUTDOWN`); sqlane
  ignores its later result.
- **`mode: 'release'`.** Each unfinished job goes back to pending without using an attempt (event `released`). It can
  run again only 2 seconds after `exitsBy`.
- **`mode: 'abandon'`.** sqlane writes nothing; the job stalls when its lease runs out (see [Stalls](#stalls)).
- **Set `exitsBy`** to your platform's `SIGTERM` grace period.
- **A second call** returns the same promise and ignores its options.
- **After close.** `start()` and `drain()` reject with `ClosedError` (code `CLOSED`), and `mount()` throws it.
  `createRunner(sqlane)` throws `ConfigError` (one runner per instance); after `sqlane.close()`, `ClosedError`.
  Enqueues and reads still work.
- `close` never ends your pools. [`sqlane.close`](#sqlaneclose) closes the runner with the same options.

**Example.** The platform kills the process 30 seconds after `SIGTERM`:

```ts
process.once('SIGTERM', async () => {
    await sqlane.close({ deadline: '20s', exitsBy: '25s' }); // closes the runner too
    await queuePool.end();
});
```

### `runner.pauseLocally` and `resumeLocally`

Stops or restarts the claims of one lane in this runner only.

```ts
runner.pauseLocally(lane: LaneDefinition | string): void
runner.resumeLocally(lane: LaneDefinition | string): void
```

| Parameter | Type                             | Description                        |
| --------- | -------------------------------- | ---------------------------------- |
| `lane`    | a lane definition or a lane name | The lane, or the name of the lane. |

**Errors.** Both throw `InvalidOptionsError` when `lane` is neither a lane definition nor a string.

**Notes**

- Running jobs finish; pending jobs stay for other processes. Mounted schedules of the lane go on firing.
- A pause works before the lane is mounted and survives an unmount. Both methods are idempotent.
- To pause a lane in every process, use [`sqlane.lanes.pauseGlobally`](#sqlanelanespauseglobally-and-resumeglobally).

| Pause                 | Where         | Stored    | Lasts                  |
| --------------------- | ------------- | --------- | ---------------------- |
| `runner.pauseLocally` | this runner   | in memory | until resume or close  |
| `lanes.pauseGlobally` | every process | database  | until `resumeGlobally` |

**Example**

```ts
runner.pauseLocally(sendEmail);
mailer.once('healthy', () => runner.resumeLocally(sendEmail));
```

### `runner.getStatus`

Returns what this runner does with a lane or a schedule.

```ts
runner.getStatus(lane: LaneDefinition | string): LaneRunStatus
runner.getStatus(schedule: ScheduleDefinition | `${string}:${string}`): ScheduleRunStatus
```

| Parameter  | Type                               | Description                                                                        |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `lane`     | a lane definition or a lane name   | The lane, or the name of the lane.                                                 |
| `schedule` | a schedule definition, or `string` | The schedule, or its schedule id `<lane>:<schedule key>`: a string with `:` in it. |

**Returns** for a lane, a `LaneRunStatus`:

| Field           | Type      | Description                                                                    |
| --------------- | --------- | ------------------------------------------------------------------------------ |
| `mounted`       | `boolean` | A handler of the lane is mounted in this runner.                               |
| `pausedLocally` | `boolean` | [`runner.pauseLocally`](#runnerpauselocally-and-resumelocally) holds the lane. |
| `running`       | `number`  | The lane's jobs that run in this runner, by any of its handlers.               |
| `fairGroups`    | `boolean` | This runner claims the lane by [fair group](#fair-groups) now.                 |

For a schedule, a `ScheduleRunStatus`: `{ mounted }`, `true` when the schedule is mounted here.

**Errors.** `getStatus` throws `InvalidOptionsError` when the argument is neither a definition nor a string.

**Notes**

- An unknown or invalid name or id returns `mounted: false`.
- **`fairGroups`** is `true` when the mounted lane has a `fairGroup`, the schema has `0011_fair_groups`, and no job
  of the lane carries global limits (such as one enqueued by an older deploy).
- **`running`** counts jobs of an old handler too, after an [unmount](#mountunmount).
- It reads memory only. For all processes, use [`sqlane.lanes.stats`](#sqlanelanesstats).

**Example**

```ts
app.get('/health/jobs', (req, res) => {
    res.json({ email: runner.getStatus(sendEmail), nightly: runner.getStatus('build_report:nightly').mounted });
});
```

## Behavior

### Job lifecycle

A job's `status` says where it is in its life. Most changes made by a runner emit an [event](#events); `jobs.retry`,
`jobs.remove`, and `jobs.cancel` inside your transaction emit none.

**Delivery.** A job runs at least once, and may run again after its handler did its work (after a stall, a release or
a lost lease): make handlers idempotent, for example with a unique key in your own table.

| `status`    | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `pending`   | Waits for its run time, then for a runner to claim it.                      |
| `blocked`   | Due, but waits for a full global concurrency limit key or rate limit quota. |
| `running`   | A runner claimed it and runs its handler. `startedAt` is set.               |
| `completed` | The handler returned. `finishedAt` is set.                                  |
| `failed`    | Failed for good, or cancelled by `jobs.cancel`. `finishedAt` is set.        |

A blocked job's `JobRecord.blockedOn` says what it waits for. There is no `cancelled` status: a cancelled job is
`failed`, with `JobCancelledError` as its `lastError`.

```text
             enqueue
                │
                ▼
   ┌──────► pending ◄──────► blocked
   │            │ claim         ▲
   │            ▼               │ RateLimitedError (global)
   │  backoff, release, stall,  │
   │  RateLimitedError (local)  │
   └──────── running ───────────┘
                │
                ├───────► completed
                │
                ▼
              failed ◄─── cancel (pending or blocked)
                │
                └──► pending   (jobs.retry)
```

#### Attempts and retries

- `JobRecord.attempts` counts the finished attempts; in the handler, `job.attempt` is the current one, from 1.
- The lane's `maxAttempts` (default 3, fixed at enqueue) sets the number of attempts.
- By [how the handler ends](#how-a-handler-ends):

| The handler                                        | The job becomes                                 | Event                                   |
| -------------------------------------------------- | ----------------------------------------------- | --------------------------------------- |
| returns                                            | `completed`                                     | `completed`                             |
| throws, with attempts left                         | `pending`, after its [backoff](#backoff)        | `retried`                               |
| throws `RetryJobError`, with attempts left         | `pending`, after the error's `delay`            | `retried`                               |
| throws with no attempts left, or `FatalJobError`   | `failed`; sqlane logs the error                 | `failed`                                |
| throws `RateLimitedError` on the job's rate limits | `blocked` (a global limit) or `pending` (local) | `rate_limited`                          |
| passes its `timeout`                               | as a throw: `pending` or `failed`               | `timed_out`, then `retried` or `failed` |

- A `RateLimitedError` on the job's rate limits (all, without `limit`) uses no attempt. With another `limit`, or on a
  job without rate limits, it acts as a `RetryJobError` with `delay: retryAfter`, and uses an attempt.
- A job past `maxStalls` fails without running; see [Stalls](#stalls).
- When a job fails for good, sqlane adds a failure job with a [`FailedJobPayload`](#failedjobpayload) to the lane's
  `failureLane`, if any, in the same transaction.

#### Timeout

- The lane's `timeout` limits one attempt (no default: no limit). At the timeout, sqlane aborts the handler's
  `signal` with a `JobTimeoutError`. Event: `timed_out`.
- Until the handler settles, the job is stuck: it stays `running` with `JobRecord.stuck` `true`, for at most about
  one more lease, and keeps its limit keys. Then the attempt fails, even if the handler returned.

#### Stalls

- A running job holds a lease, a hold on the job with an expiry, that its runner renews while the handler runs.
  When a renewal fails in time, sqlane aborts the `signal` with a
  `LeaseLostError` (event: `lease_lost`), and this runner writes no result.
- A stall happens when the runner stops renewing: the process exited or hung, the lease was lost, or
  `mode: 'abandon'` on close.
- Another runner then makes the job `pending`, after a delay that grows with each stall, and adds 1 to
  `JobRecord.stalls`, not to `attempts`. Event: `stalled`.
- The lane's `maxStalls` (default 2, fixed at enqueue) sets how many stalls a job survives. After more, the next
  claim fails the job without running it, with a `StalledError`, and sqlane adds the failure job.

#### Closing a runner

At the deadline of [`runner.close`](#runnerclose), each unfinished handler's `signal` aborts with a `ShutdownError`.
`mode: 'release'` (default) makes the job `pending`, using no attempt (event: `released`); it can run again 2 seconds
after `exitsBy`, so the old handler cannot overlap it. `'abandon'` lets it stall.

#### Cancel, retry and remove

`jobs.cancel`, `jobs.retry` and `jobs.remove` never change a `running` job; see
[`sqlane.jobs.retry`, `cancel` and `remove`](#sqlanejobsretry-cancel-and-remove).

#### Retention

- sqlane keeps a finished job for the lane's `retention` (default `completed: '1h'`, `failed: '30d'`, cancelled
  jobs included), until `JobRecord.expiresAt`; then a started runner deletes it.
- `createSqlane({ cleanup: false })` turns deletion off.
- A finished job keeps its dedupe key until sqlane deletes it.

#### Example

```ts
const job = await sqlane.jobs.get(jobId);

if (job?.status === 'failed') console.log(job.attempts, job.stalls, job.lastError?.name);
```

### Where job options come from

For each option, the leftmost column that sets it wins:

| Option                    | Enqueue option | Lane definition  | `createSqlane({ defaults })` | Built-in default                   | Taken       |
| ------------------------- | -------------- | ---------------- | ---------------------------- | ---------------------------------- | ----------- |
| `maxAttempts`             | yes            | yes              | yes                          | `3`                                | at enqueue  |
| `maxStalls`               | yes            | yes              | yes                          | `2`                                | at enqueue  |
| `retention`               | yes, per field | yes, per field   | yes, per field               | `completed: '1h'`, `failed: '30d'` | at enqueue  |
| `delay` / `runAt`         | yes            | —                | —                            | start at once                      | at enqueue  |
| `globalConcurrencyLimits` | yes            | yes (a function) | —                            | none                               | at enqueue  |
| `globalRateLimits`        | yes            | yes (a function) | —                            | none                               | at enqueue  |
| `fairGroup`               | —              | yes (a function) | —                            | none                               | at enqueue  |
| `backoff`                 | —              | yes              | yes                          | see [Backoff](#backoff)            | at run time |
| `timeout`                 | —              | yes              | yes                          | none                               | at run time |
| `failureLane`             | —              | yes              | —                            | none                               | at run time |

**Rules**

- **At enqueue.** sqlane copies these into the job from the definition passed to `enqueue` and the producer's
  `defaults`; a later change applies only to new jobs.
- **At run time.** sqlane reads these when the job runs or fails, from the mounted lane definition, then that
  process's `defaults`, so a change reaches existing jobs once the runner runs new code.
- **`retention` merges field by field. `backoff` does not**: a lane's `backoff` replaces the whole
  `defaults.backoff`.
- **Global limits replace.** An enqueue option replaces what the lane's function returns, and `[]` clears it. On a
  lane with a `fairGroup`, the only enqueue value allowed is `[]`. See
  [Concurrency and rate limits](#concurrency-and-rate-limits).
- **Handler options.** Only [`defineHandler`](#definehandler) sets `fairShareWeight`, `localConcurrencyLimits` and
  `localRateLimits`, for the runner that mounts it.
- **A lane with `globalConcurrencyLimits` needs a `timeout`**, in its definition or in `defaults`. Without one,
  `runner.mount()` throws `ConfigError`.

**Example**

```ts
const sqlane = createSqlane({ adapter, defaults: { timeout: '10m' } });
const sendEmail = defineLane<{ to: string }>({ name: 'send_email', maxAttempts: 5 });

// maxAttempts 5 (lane), maxStalls 2 (built-in), timeout '10m' (defaults)
await sqlane.enqueue(trx, sendEmail, { to: 'ada@example.com' });

// This job only
await sqlane.enqueue(trx, sendEmail, { to: 'ada@example.com' }, {
    maxAttempts: 1,
    retention: { completed: '1d' },
});
```

### Concurrency and rate limits

A concurrency limit caps how many jobs run at once; a rate limit, how many start per period. See
[`defineConcurrencyLimit`](#defineconcurrencylimit) and [`defineRateLimit`](#defineratelimit).

**Local or global.** A limit counts in one runner or in all processes:

|                  | Local                                                        | Global                                                                 |
| ---------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Declared in      | `defineHandler`: `localConcurrencyLimits`, `localRateLimits` | `defineLane` or enqueue: `globalConcurrencyLimits`, `globalRateLimits` |
| Counted by       | each runner, in memory                                       | all processes, in the database                                         |
| Limit keys       | none: one count per limit name                               | one count per limit key                                                |
| A job that waits | stays `pending`                                              | becomes `blocked`                                                      |

- A job starts only when every one of its limits, local and global, has room.
- **Local.** Lanes of one runner that list the same limit share one count. Each runner counts apart: 3 runners with a
  local limit of 50 starts per second may start 150 per second in all. Same-name local limits with different settings
  in one runner make `runner.mount()` throw `ConfigError`.
- **Global.** sqlane calls the lane's limit functions at enqueue. Each returned limit is one limit key;
  `limit.key(value)` gives one per value, such as `perCustomer.key(42)`.

**Blocked jobs.** A due job becomes `blocked` when one of its global limit keys has no room or quota left.
`JobRecord.blockedOn` names that limit key.

- Waiting uses no attempt. The job becomes `pending` when its limit key has room again.
- It keeps its `runAt`: blocked jobs of one limit key leave in `runAt` order, and on a rate limit key a new job waits
  behind an older blocked one. [`sqlane.jobs.keyStats`](#sqlanejobskeystats) shows the limit keys with blocked jobs.

**Settings fixed at enqueue.** sqlane copies each global limit key with its `max` (and `per`, `burst` and `cost` for a
rate limit) into the job, so a changed limit applies only to later enqueues. A local limit comes from the running
runner's handler.

**At most 10 limit keys per job**, global concurrency and rate together. The same limit key twice counts once. More
than 10 concurrency limit keys reject the enqueue with `InvalidConcurrencyLimitError`; more than 10 in all, with
`InvalidRateLimitError`.

**The spacing of starts.** A rate limit starts one job every `per / max`. After a quiet time, up to `burst` jobs may
start at once. Any period of length `per` sees at most `max + burst − 1` starts.

| Limit                               | Starts                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `{ max: 10, per: '1s' }`            | One every 100 ms.                                                                     |
| `{ max: 10, per: '1s', burst: 10 }` | Up to 10 at once after a quiet time, then one every 100 ms; at most 19 in one second. |

A job with cost `n` takes the quota of `n` starts. Every start takes quota, also a retry or a run after a stall, and a
run that fails at once gets nothing back.

**`RateLimitedError`.** A handler throws it when the other side limits the rate, such as on HTTP 429:

```ts
throw new RateLimitedError({ limit: githubApi.key(payload.tokenId), retryAfter: '30s', cause: error });
```

On a global limit key the job becomes `blocked`; on a local limit, `pending`. Neither uses an attempt. See
[How a handler ends](#how-a-handler-ends) for the options and other cases.

**After a stall or a close.** A stalled run keeps its concurrency place for about one more lease; after
`runner.close({ mode: 'release' })`, until `exitsBy`. The next job of that limit key may wait. `jobs.keyStats` shows
these places as `lingering`.

**Example.** One sync per customer at a time, and at most 5000 GitHub calls per hour per token:

```ts
const perCustomer = defineConcurrencyLimit({ name: 'sync_per_customer', max: 1 });
const githubApi = defineRateLimit({ name: 'github_api', max: 5000, per: '1h' });

export const syncCustomer = defineLane<{ customerId: number, tokenId: string }>({
    name: 'sync_customer',
    timeout: '10m',
    globalConcurrencyLimits: ({ payload }) => [perCustomer.key(payload.customerId)],
    globalRateLimits: ({ payload }) => [githubApi.key(payload.tokenId)],
});
```

### How a runner shares `localMaxConcurrency`

A runner runs at most `localMaxConcurrency` handlers at once (default 10), shared between lanes by each handler's
`fairShareWeight`, so a busy lane cannot starve the others.

**Rules**

- **The lowest share first.** The next job to start comes from the lane with the lowest
  `running / fairShareWeight`, where `running` counts the lane's jobs that run in this runner.
- **`fairShareWeight`.** A [`defineHandler`](#definehandler) option: an integer from 1 to 1000, default 1.
- **Ties.** Lanes with the same share take turns, in the order you mounted their handlers.
- **Only lanes that can start a job** take part: with a due job and room under every local limit of the handler.
- **No memory.** A lane that waited does not catch up later with extra capacity.
- **Within a lane.** Jobs start in order of their run time, or by group with a `fairGroup`: see
  [Fair groups](#fair-groups).
- **Per runner; no preemption.** Other processes do not count. A running job always finishes; shares even out as
  handlers end.

With more due jobs than `localMaxConcurrency`, the running jobs settle in proportion to the weights:

| `localMaxConcurrency` | Lane A weight | Lane B weight | A runs | B runs |
| --------------------- | ------------- | ------------- | ------ | ------ |
| 8                     | 1             | 1             | 4      | 4      |
| 8                     | 3             | 1             | 6      | 2      |
| 12                    | 5             | 1             | 10     | 2      |
| 8 (B has 1 due job)   | 3             | 1             | 7      | 1      |

Capacity that a lane cannot use goes to the other lanes, as in the last row.
[`runner.getStatus(lane)`](#runnergetstatus) shows `running`.

**Example.** Payments get five times the capacity of reports, and reports still progress:

```ts
const runner = createRunner(sqlane, { localMaxConcurrency: 12 });

runner.mount([
    defineHandler(chargeCard, chargeCardHandler, { fairShareWeight: 5 }),
    defineHandler(buildReport, buildReportHandler),
]);
```

With both lanes busy, 10 payments and 2 reports run.

### Fair groups

A fair group splits one lane between its users, such as tenants, so one large backlog does not delay the others.

**Rules**

- **Setting the group.** The lane's [`fairGroup`](#definelane) function returns each job's group at enqueue.
  `null` or `undefined` means no group; the jobs without a group form one group together.
- **Group names.** 1 to 255 printable ASCII characters, with no space at either end.
- **Sharing inside a lane.** The lane's next job in a runner comes from the due group with the fewest jobs
  running in this runner. Within a group, jobs start in order of their run time.
- **Ties.** Tied groups take turns in byte order of name, the no-group jobs last, starting after the last winner.
- **Sharing between lanes.** A lane with 50 groups still gets one share, by its `fairShareWeight`. See
  [How a runner shares `localMaxConcurrency`](#how-a-runner-shares-localmaxconcurrency).
- **Per runner; no preemption.** Each runner counts its own running jobs. A group alone can use the lane's whole
  share; counts even out as jobs end.
- **Fixed at enqueue.** A job keeps its group through retries and stalls. Groups belong to one lane.
- **No global limits.** A lane with `fairGroup` cannot have `globalConcurrencyLimits` or `globalRateLimits`:
  `defineLane` throws `ConfigError`.
- **Dedupe keys** are unique per lane, not per group: include the group when two groups may share a value.

`JobRecord.fairGroup` and the [events](#events) carry the group. [`runner.getStatus(lane)`](#runnergetstatus) shows
`fairGroups: true`; [`lanes.groupStats`](#sqlanelanesgroupstats) shows each group's backlog.

**Example.** A tenant with 100,000 due emails does not hold back a tenant with 2:

```ts
export const sendEmail = defineLane<{ tenantId: string, to: string }>({
    name: 'send_email',
    fairGroup: ({ payload }) => payload.tenantId,
});
```

### Schedules

A schedule adds a job to its lane at each slot. A slot is one time at which the schedule fires: for `cron: '0 3 * * *'`,
03:00 each day. You define a schedule with [`defineSchedule`](#defineschedule) and fire it by mounting it in a runner.

**How a slot fires**

- Every started runner that mounts the schedule tries to fire each slot; one adds the job. Mount it in every worker,
  or in a process without the lane's handler. Without a started runner, nothing fires.
- The job is an ordinary job of the lane. The handler reads the slot in `job.scheduledAt`, even when late; other
  jobs have `null`.
- The job id is `<lane>:schedule:<key>:<slot>`, such as `build_report:schedule:nightly:2026-11-11T02:00:00.000Z`.
  [`sqlane.enqueue`](#sqlaneenqueue) rejects a dedupe key that starts with `schedule:`, with `InvalidOptionsError`.
- Each fired slot emits a `schedule_fired` [event](#events), with `late` and `jobId`.
- The schedule id `<lane>:<key>` is shared by all processes on the database: two services need different schedule
  keys.

**Cron syntax**

A cron expression has 5 fields, separated by spaces or tabs:

| Field        | Values | Names                                 |
| ------------ | ------ | ------------------------------------- |
| minute       | 0–59   |                                       |
| hour         | 0–23   |                                       |
| day of month | 1–31   |                                       |
| month        | 1–12   | `JAN`–`DEC`                           |
| day of week  | 0–7    | `SUN`–`SAT`; both 0 and 7 mean Sunday |

Each field is one item or a comma list of items, such as `0,30`. Names are case-insensitive.

| Item    | Meaning                                 | Example in the minute field |
| ------- | --------------------------------------- | --------------------------- |
| `*`     | Every value.                            | every minute                |
| `n`     | One value.                              | `5`: minute 5               |
| `a-b`   | A range.                                | `0-10`                      |
| `*/s`   | Every `s`-th value from the first one.  | `*/15`: 0, 15, 30, 45       |
| `a-b/s` | Every `s`-th value of the range.        | `0-30/10`: 0, 10, 20, 30    |
| `a/s`   | Every `s`-th value from `a` to the end. | `10/20`: 10, 30, 50         |

- **Day of week steps.** `*` and `a/s` count over 0–6: `1/2` is Monday, Wednesday and Friday.
- **Two day fields.** When both are restricted, a day matches if either one matches: `0 9 1 * MON` fires on the 1st
  and on every Monday. A field that starts with `*`, such as `*/2`, is not restricted; then both must match.
- **Macros** (case-insensitive): `@yearly` and `@annually` (`0 0 1 1 *`), `@monthly` (`0 0 1 * *`), `@weekly`
  (`0 0 * * 0`), `@daily` and `@midnight` (`0 0 * * *`), `@hourly` (`0 * * * *`).
- **Not supported** (`ConfigError`): a seconds field (use `every`), `L`, `W`, `#`, `?`, `H`, other macros such as
  `@reboot`, more than 256 characters.

**Time zones and DST**

`cron` reads the wall clock of `timezone` (default `'UTC'`). On a day when the clocks change:

- A cron with an hour field of `*`, `0-23` or `*/1` follows elapsed time: no run in the skipped hour, two in a repeated
  hour.
- Any other cron fires once for each matching wall time: in the skipped hour, when the gap ends; in the repeated hour,
  at its first pass.
- `every` counts in UTC: DST does not change it.

In `'Europe/Berlin'`, 2026: on 29 March, 02:00 jumps to 03:00; on 25 October, 03:00 goes back to 02:00.

| `cron`       | 29 March                        | 25 October                                   |
| ------------ | ------------------------------- | -------------------------------------------- |
| `30 2 * * *` | Once, at 03:00 (the gap's end). | Once, at the first 02:30.                    |
| `30 * * * *` | No 02:30 that day.              | Twice: at 02:30 summer time and winter time. |

**`every`**

- An interval from `'1s'` to `'1d'`. Over `'1h'`, it must divide a day, such as `'90m'`, `'2h'`, `'3h'`, `'6h'`,
  `'12h'` or `'1d'`.
- The slots are the multiples of the interval since 1970-01-01 00:00 UTC, the same in every process and across
  restarts: `'6h'` fires at 00:00, 06:00, 12:00 and 18:00 UTC. For a local time of day, use `cron`.

**Missed slots and catch-up**

A slot is on time when a runner fires it within 1 minute after its run time, by the database clock. Otherwise it is
missed.

- **`missed: 'once'`** (the default). The next fire adds a job for the latest missed slot only, so an outage never
  ends in a burst.
- **Reach.** sqlane catches up a missed slot only if the schedule handled a slot (`lastSlotAt` in
  [`sqlane.schedules.list`](#sqlanescheduleslist)) at most 1 day before the slot that precedes the missed one. After
  a longer outage, it drops the missed slot and waits for the next one (row 2 below).
- **`missed: 'skip'`.** A missed slot never runs.
- Slots before a started runner first mounts the schedule never run.

| Schedule            | All runners down               | With `missed: 'once'`                   |
| ------------------- | ------------------------------ | --------------------------------------- |
| `cron: '0 3 * * *'` | Tuesday 01:00 to 09:00         | Tuesday's 03:00 slot runs at 09:00.     |
| `cron: '0 3 * * *'` | Monday 10:00 to Thursday 10:00 | Nothing runs late; Friday's 03:00 runs. |
| `every: '1m'`       | 3 hours                        | The latest missed minute runs once.     |

**Overlap**

- **`'allow'`** (the default): jobs of a schedule may run at once.
- **`'skip'`:** A slot adds no job while the schedule's previous job is `pending` (also while it waits for a
  retry) or `running`. The skipped slot is gone: its `schedule_fired` event has `jobId: null`.
- To queue the jobs instead, give the lane a global concurrency limit with a `max` of 1.

**Jitter**

Each slot's job starts a fixed offset after the slot, to spread many schedules. The offset is below both `jitter` and
the gap to the next slot, in whole seconds when that bound is at least 1 second, and the same in every process.
`job.scheduledAt` is still the slot. A late catch-up keeps the offset, counted from when it fires.

**Deploys and removed schedules**

- In a rolling deploy, each slot still adds one job. A changed option applies to the slots that a new process fires.
  After a change of `cron`, `timezone` or `every`, a missed slot is caught up only once a slot of the new timing has
  fired on time. A new spelling of the same timing, such as `MON-FRI` for `1-5`, is no change.
- A new schedule key makes a new schedule. An unmounted schedule stops firing; `schedules.list()` shows it until
  [`sqlane.schedules.remove`](#sqlaneschedulesremove).
- To stop a schedule in every process without a deploy, use
  [`sqlane.schedules.pauseGlobally`](#sqlaneschedulespauseglobally-and-resumeglobally).

**The database clock**

The database clock decides when a slot is due. A runner whose clock is over 5 seconds off logs a warning, at most once
every 10 minutes.

**Manual runs**

[`sqlane.schedules.runSlot`](#sqlaneschedulesrunslot) adds the job of a slot now, for example after an outage that the
catch-up does not reach.

**Guarantees**

- Across all processes, the runners add at most one job per slot. `runSlot` adds nothing while the slot's job exists.
- A slot gets its job when a mounting runner is up within 1 minute after it, or, with `missed: 'once'`, at a later
  fire within the reach.
- A paused schedule fires no slot.
- The job then runs at least once, as every job does. See [Job lifecycle](#job-lifecycle).

**Example.** Every 15 minutes, never overlapping, spread over a minute:

```ts
export const syncAcme = defineSchedule(syncTenant, {
    key: 'acme',
    every: '15m',
    payload: { tenantId: 'acme' },
    overlap: 'skip',
    jitter: '1m',
});
```

## Types

### `JobRecord` and `JobError`

A `JobRecord` is a job as [`sqlane.jobs.get`](#sqlanejobsget) and [`sqlane.jobs.list`](#sqlanejobslist) read it. A
`JobError` is an error that sqlane wrote to a job. Both are exported from `@sqlane/core`.

**`JobRecord<P>`.** Every field is always present, except `payload`.

| Field                     | Type                                               | Description                                                             |
| ------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `id`                      | `string`                                           | The full job id.                                                        |
| `lane`                    | `string`                                           | The name of the job's lane.                                             |
| `status`                  | `JobStatus`                                        | See [Job lifecycle](#job-lifecycle).                                    |
| `attempts`                | `number`                                           | Finished attempts: each run that completes, is retried or fails adds 1. |
| `maxAttempts`             | `number`                                           | The most attempts, fixed at enqueue.                                    |
| `stalls`                  | `number`                                           | How often the job's lease ended while it ran.                           |
| `maxStalls`               | `number`                                           | The most stalls survived, fixed at enqueue.                             |
| `runAt`                   | `Date`                                             | When the job may start; for a started job, when its last run was due.   |
| `enqueuedAt`              | `Date`                                             | The insert time, not the commit time.                                   |
| `startedAt`               | `Date \| null`                                     | The start of the last run; `null` if it never ran.                      |
| `finishedAt`              | `Date \| null`                                     | When it completed or failed for good, else `null`.                      |
| `expiresAt`               | `Date \| null`                                     | From when cleanup may delete the finished job, else `null`.             |
| `scheduledAt`             | `Date \| null`                                     | The slot of a schedule's job, else `null`.                              |
| `stuck`                   | `boolean`                                          | `true` when `running` past its timeout.                                 |
| `lastError`               | `JobError \| null`                                 | The last error written to the job.                                      |
| `blockedOn`               | `BlockedOn \| null`                                | What a `blocked` job waits for, else `null`.                            |
| `globalConcurrencyLimits` | `readonly { key, max }[]`                          | Its global concurrency limit keys.                                      |
| `globalRateLimits`        | `readonly { limit, key, max, per, burst, cost }[]` | Its global rate limit keys.                                             |
| `payload`                 | `P`                                                | The payload as JSON gives it back.                                      |

**Notes on `JobRecord`**

- **`status`.** `pending` excludes `blocked`; a cancelled job is `failed`. `JobStatus` gains members only in a major
  version.
- **`attempts`.** A stall, a release by `runner.close` and a wait for rate limit quota add none. See
  [Attempts and retries](#attempts-and-retries).
- **`runAt`.** A `blocked` job, or one waiting after a global `RateLimitedError`, keeps its `runAt`.
- **`stuck`.** Its handler may still run; see [Timeout](#timeout).
- **`expiresAt`.** The job stays readable until cleanup deletes it; see [Retention](#retention).
- **`lastError`.** Written for a failed attempt, a stall, a global `RateLimitedError` and `jobs.cancel`; kept if the
  job later completes.
- **`payload`.** Absent when `jobs.list` ran without `includePayload`, or the database holds none, as for a completed
  job.

**Limit keys: which `key` is which.**

| Where                                                                      | `limit`                          | `key`                                                             |
| -------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `globalConcurrencyLimits`, `blockedOn` of type `'concurrency'`             | none                             | The full limit key: `order:42` for `order.key(42)`, or `order`.   |
| `globalRateLimits`, `blockedOn` of type `'rate'`, the `rate_limited` event | The limit name, such as `stripe` | The value passed to `limit.key()`, such as `'acct_1'`, or `null`. |

[`jobs.keyStats`](#sqlanejobskeystats) follows the same rule. Both arrays are sorted by full limit key. In
`globalRateLimits`, `per` is in ms and `cost` is the quota one start uses.

**`BlockedOn`.**

```ts
type BlockedOn =
    | { type: 'concurrency'; key: string }
    | { type: 'rate'; limit: string; key: string | null };
```

`type` may gain members in a minor version: give a `switch` on it a `default` branch.

**`JobError`.**

| Field     | Type     | Description                                       |
| --------- | -------- | ------------------------------------------------- |
| `name`    | `string` | Such as `TypeError` or `JobTimeoutError`.         |
| `message` | `string` | The error's `message`.                            |
| `stack`   | `string` | Cut to 8192 UTF-16 code units; absent if none.    |
| `code`    | `string` | Present only when the error's `code` is a string. |

**Notes on `JobError`**

- **`name`.** Whatever the handler threw, not always a sqlane class. A thrown non-`Error` gets `name` `Error` and
  the value as a string as `message`.
- **`StalledError`.** Written when a job stalls or exceeds `maxStalls`; no such class exists.
- **Text.** NUL characters and lone surrogates become U+FFFD.

**Example.** Why each job waits:

```ts
const { jobs } = await sqlane.jobs.list({ lane: sendEmail, status: ['blocked', 'pending'] });

for (const job of jobs) {
    const stalled = job.lastError?.name === 'StalledError';
    const waitsFor =
        job.blockedOn?.type === 'concurrency' ? `key ${job.blockedOn.key}`
        : job.blockedOn?.type === 'rate' ? `limit ${job.blockedOn.limit}`
        : 'its run time';
    console.log(job.id, waitsFor, stalled ? '(stalled before)' : '');
}
```

### `FailedJobPayload`

The payload of a failure job: when a job fails for good and its lane has a `failureLane`, sqlane adds a job with this
payload to that lane.

```ts
type FailedJobPayload = {
    job: { id: string; lane: string; payload: any; attempt: number; maxAttempts: number };
    error: JobError;
};
```

| Field             | Type                                  | Description                                         |
| ----------------- | ------------------------------------- | --------------------------------------------------- |
| `job.id`          | `string`                              | The failed job's full id.                           |
| `job.lane`        | `string`                              | Its lane name.                                      |
| `job.payload`     | `any`                                 | Its payload, or `null` when the database held none. |
| `job.attempt`     | `number`                              | The attempt that failed, from 1.                    |
| `job.maxAttempts` | `number`                              | Its `maxAttempts`.                                  |
| `error`           | [`JobError`](#jobrecord-and-joberror) | The error that failed it for good.                  |

**Notes**

- **When.** See [Attempts and retries](#attempts-and-retries). [`jobs.cancel`](#sqlanejobscancel) adds no failure
  job. A failure lane with its own `failureLane` makes [`defineLane`](#definelane) throw `ConfigError`.
- **Same transaction** as the one that marks the job `failed`. If the database refuses the failure job, the job still
  fails, with `failure_job_not_added` and `error` [events](#events) and a warning.
- **Which failure lane.** The one in the lane definition mounted in the failing runner.
- **An ordinary job.** It takes its options from the failure lane's definition; `maxPayloadBytes` does not apply.
- **`job.attempt` after stalls.** A job past `maxStalls` fails without running again: `job.attempt` is then one more
  than `JobRecord.attempts`.

**Example.** A failure lane for `build_report`:

```ts
import { defineHandler, defineLane, type FailedJobPayload } from '@sqlane/core';

export const buildReportFailed = defineLane<FailedJobPayload>({ name: 'build_report_failed' });
export const buildReport = defineLane<{ reportId: string }>({ name: 'build_report', failureLane: buildReportFailed });

export const reportFailure = defineHandler(buildReportFailed, async ({ payload: { job, error } }) => {
    const { reportId } = job.payload as { reportId: string };
    console.error(`report ${reportId} (job ${job.id}) failed at attempt ${job.attempt}: ${error.message}`);
});
```

### `Hint`

A `Hint` lets sqlane wake the other processes as soon as a lane has work, not at their next poll (`pollInterval`,
default `'5s'`). Write it over a pub/sub service such as Redis, and pass it as the optional `createSqlane({ hint })`.

```ts
type Hint = {
    publish: (channel: string, message: string) => Promise<void>;
    subscribe: (channel: string, onMessage: (message: string) => void) => Promise<() => Promise<void>>;
};
```

| Field       | Description                                                                      |
| ----------- | -------------------------------------------------------------------------------- |
| `publish`   | Sends `message` to every subscriber of `channel`.                                |
| `subscribe` | Calls `onMessage` per message on `channel`; resolves to an unsubscribe function. |

`createSqlane` throws `ConfigError` when `hint` is not an object or either field is not a function.

**Channel and message.** The channel is `tablePrefix` + `ready` (`'sqlane_ready'` by default). A message is a lane
name or `'*'`; pass it to `onMessage` unchanged.

**When sqlane publishes.** Whenever a lane may have a job to run now, such as after an enqueue or a `jobs.retry`. After
an enqueue, it publishes on commit if your adapter reports commits, else at once; receivers then keep looking until
the job is visible.

**Failures.** A failure in your `Hint` never rejects a sqlane call; `enqueue` does not wait for `publish`. sqlane logs
it and emits an [`error` event](#events) with this `operation`:

| `operation`        | When                                               |
| ------------------ | -------------------------------------------------- |
| `hint_publish`     | `publish` rejected.                                |
| `hint_listen`      | `subscribe` rejected; the runner starts and polls. |
| `hint_unsubscribe` | The unsubscribe function rejected.                 |
| `hint_message`     | Code that ran in `onMessage` threw.                |

A lost message only delays a job until the next poll.

**Processes.** A runner subscribes in [`runner.start()`](#runnerstart); every process publishes.

**Closing.** [`runner.close()`](#runnerclose) unsubscribes; enqueues after it still publish.
[`sqlane.close()`](#sqlaneclose) stops publishing and drops unsent messages. Close your connections after it.

**PostgreSQL.** The adapter option `notify: true` does the same without a pub/sub service (see [Adapters](#adapters)).
`createSqlane` throws `ConfigError` when you pass both.

**Example.** Redis, through ioredis:

```ts
import { Redis } from 'ioredis';
import { createSqlane, type Hint } from '@sqlane/core';

const publisher = new Redis(process.env.REDIS_URL!);
const subscriber = new Redis(process.env.REDIS_URL!); // a subscribed connection cannot publish

const hint: Hint = {
    publish: async (channel, message) => {
        await publisher.publish(channel, message);
    },
    subscribe: async (channel, onMessage) => {
        const listener = (from: string, message: string) => from === channel && onMessage(message);
        subscriber.on('message', listener);
        await subscriber.subscribe(channel);
        return async () => {
            subscriber.off('message', listener);
            await subscriber.unsubscribe(channel);
        };
    },
};

const sqlane = createSqlane({ adapter, hint });

// On shutdown: sqlane first, then your connections
await sqlane.close();
await Promise.all([publisher.quit(), subscriber.quit()]);
```

## Errors

Every error sqlane creates is a `SqlaneError` with a stable `code`. All classes are exported from `@sqlane/core`.

| Class                          | `code`                      | When                                                                                                                                                                                                                                                                                             |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ConfigError`                  | `CONFIG`                    | An option of [`createSqlane`](#createsqlane), [`createRunner`](#createrunner), a definition, [`runner.mount`](#runnermount) or an adapter is invalid; the server fails its check; the schema lacks a migration; or a call conflicts with the runner's state, such as `mount()` during `drain()`. |
| `InvalidOptionsError`          | `INVALID_OPTIONS`           | An argument of `enqueue`, `enqueueMany`, `sqlane.jobs`, `.lanes`, `.schedules`, `.schema`, `runner.drain`, `pauseLocally`, `resumeLocally` or `getStatus` is invalid.                                                                                                                            |
| `PayloadTooLargeError`         | `PAYLOAD_TOO_LARGE`         | An enqueued payload's JSON exceeds `maxPayloadBytes`.                                                                                                                                                                                                                                            |
| `InvalidConcurrencyLimitError` | `INVALID_CONCURRENCY_LIMIT` | A global concurrency limit or limit key is invalid, or a job has more than 10 concurrency limit keys.                                                                                                                                                                                            |
| `InvalidRateLimitError`        | `INVALID_RATE_LIMIT`        | A global rate limit is invalid, a job has more than 10 limit keys in all, or `new RateLimitedError()` gets invalid options.                                                                                                                                                                      |
| `ClosedError`                  | `CLOSED`                    | `start`, `drain` or `mount` after [`runner.close`](#runnerclose), or `createRunner` or a schema change after [`sqlane.close`](#sqlaneclose).                                                                                                                                                     |
| `DrainTimeoutError`            | `DRAIN_TIMEOUT`             | [`runner.drain`](#runnerdrain) passes its `timeout`.                                                                                                                                                                                                                                             |
| `MigrationLockTimeoutError`    | `MIGRATION_LOCK_TIMEOUT`    | [`schema.migrate`](#sqlaneschemamigrate), [`rollback`](#sqlaneschemarollback) or [`drop`](#sqlaneschemadrop) waits past `lockTimeout` for its lock.                                                                                                                                              |
| `IgnoredJobsError`             | `IGNORED_JOBS`              | A [bulk `sqlane.jobs` method](#sqlanejobsretry-cancel-and-remove) with `strict: true` would ignore some ids; nothing changes.                                                                                                                                                                    |
| `JobTimeoutError`              | `JOB_TIMEOUT`               | An attempt passes the lane's `timeout`: aborts the [`signal`](#the-handler-context) and fails the attempt.                                                                                                                                                                                       |
| `ShutdownError`                | `SHUTDOWN`                  | [`runner.close`](#runnerclose) reaches its deadline with the handler running: aborts its `signal`.                                                                                                                                                                                               |
| `LeaseLostError`               | `LEASE_LOST`                | The runner cannot renew the lease in time: aborts the handler's `signal`.                                                                                                                                                                                                                        |
| `MissingPayloadError`          | `MISSING_PAYLOAD`           | The job's payload is missing: the job fails for good.                                                                                                                                                                                                                                            |
| `JobCancelledError`            | `JOB_CANCELLED`             | The `lastError` of a job that [`jobs.cancel`](#sqlanejobscancel) cancelled.                                                                                                                                                                                                                      |
| `FatalJobError`                | `FATAL_JOB`                 | Thrown by your handler to fail the job at once; see [How a handler ends](#how-a-handler-ends).                                                                                                                                                                                                   |
| `RetryJobError`                | `RETRY_JOB`                 | Thrown by your handler to retry after its own `delay` instead of the backoff.                                                                                                                                                                                                                    |
| `RateLimitedError`             | `RATE_LIMITED`              | Thrown by your handler when the other side limits the rate: the job waits for its rate limit, using no attempt.                                                                                                                                                                                  |

Each method lists the errors it throws. Database and driver errors pass through unchanged.

**`SqlaneError`.** The base class of all the classes above; it extends `Error`.

| Field   | Type      | Description                                  |
| ------- | --------- | -------------------------------------------- |
| `code`  | `string`  | Such as `'CONFIG'`.                          |
| `name`  | `string`  | Such as `'ConfigError'`.                     |
| `cause` | `unknown` | The cause passed to the constructor, if any. |

Extra fields: `IgnoredJobsError.ignoredJobs` (the jobs the call would have ignored, as its result lists them),
`RetryJobError.delay` (the wait before the next attempt), and `RateLimitedError.limit` and `retryAfter` (the rate
limit the handler named, if any, and the wait it asked for).

**Notes**

- **Checking an error.** Use `instanceof` with the exported class, or compare `code`; both work for every class.
- **Errors of a job.** `JobTimeoutError`, `ShutdownError` and `LeaseLostError` reach your handler as `signal.reason`.
  A job's `lastError` is a plain [`JobError`](#jobrecord-and-joberror): check its `name`.
- **`JobCancelledError` in a handler.** Throwing it is an ordinary failure: the job is retried or fails as usual.

**Example.** Map errors to HTTP statuses:

```ts
try {
    await sqlane.enqueue(pool, buildExport, req.body);
} catch (error) {
    if (error instanceof PayloadTooLargeError) return res.status(413).end();
    if (error instanceof SqlaneError && error.code === 'INVALID_OPTIONS') return res.status(400).end();
    throw error;
}
```

## Events

sqlane reports what happens to jobs and schedules through the `onEvent` option of [`createSqlane`](#createsqlane).

```ts
onEvent?: (event: SqlaneEvent) => void
```

`onEvent` gets the events of the instance (`cancelled`, `error`, also without a runner) and of its runners. Switch on
`type`. `SqlaneEvent` is exported from `@sqlane/core`.

**Common fields.** Every event but `error` and `schedule_fired` has these fields; those two have only their own.

| Field       | Type             | Description                                                    |
| ----------- | ---------------- | -------------------------------------------------------------- |
| `jobId`     | `string`         | The job id.                                                    |
| `lane`      | `string`         | The job's lane.                                                |
| `attempt`   | `number`         | From 1; after a stall, that of the stalled run.                |
| `fairGroup` | `string \| null` | The [fair group](#fair-groups), or `null`; not on `cancelled`. |

**Event types**

| `type`                  | Other fields                                              | When                                                                  |
| ----------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| `claimed`               | `runAt`, `enqueuedAt`, `startedAt` (`Date`)               | The handler starts.                                                   |
| `completed`             | `durationMs`                                              | The handler returned.                                                 |
| `retried`               | `durationMs`, `delayMs`, `error`                          | The attempt failed; the job reruns after `delayMs`.                   |
| `failed`                | `durationMs`, `error`                                     | The job failed for good.                                              |
| `rate_limited`          | `durationMs`, `limit`, `key`, `scope`, `retryAt`, `error` | The handler threw a `RateLimitedError`; the job waits.                |
| `timed_out`             | `durationMs`                                              | The attempt passed `timeout`; `signal` aborted.                       |
| `stalled`               | none                                                      | The lease ran out; the job is pending again.                          |
| `released`              | none                                                      | [`runner.close`](#runnerclose) in `'release'` mode gave the job back. |
| `lease_lost`            | none                                                      | The lease was not renewed; `signal` aborted.                          |
| `failure_job_not_added` | `failureLane`, `error`                                    | The database refused the job's failure job.                           |
| `cancelled`             | none                                                      | [`jobs.cancel`](#sqlanejobscancel) committed its own transaction.     |
| `schedule_fired`        | `scheduleId`, `lane`, `scheduledAt`, `late`, `jobId`      | This process handled a due schedule slot.                             |
| `error`                 | `operation`, `error`                                      | An internal operation failed.                                         |

**Fields**

- `durationMs` and `delayMs` (`number`, ms): the handler's run time; the wait before the next attempt.
- `error` (`unknown`): the error thrown, as is.
- `rate_limited`: `limit` (`string`); `key` (`string | null`), the limit key value, `null` without a key or for a local
  limit; `scope`, `'global'` or `'local'`; `retryAt` (`Date`), the earliest next run.
- `failureLane` (`string`), `scheduleId` (`string`, `<lane>:<schedule key>`), `scheduledAt` (`Date`, the slot's time).
- `late` (`boolean`): `true` for a catch-up of a missed slot. `jobId` of `schedule_fired` (`string | null`): `null`
  when `overlap: 'skip'` skipped the slot.
- `operation` (`string`): what failed, such as `hint_publish` (see [`Hint`](#hint)).

**Notes**

- **Keep `onEvent` fast.** sqlane calls it synchronously; if it throws, sqlane logs the error and goes on.
- **Stalls.** A job past its `maxStalls` emits `claimed`, then `failed` with `durationMs` `0` and an `error` named
  `'StalledError'`. See [Stalls](#stalls).
- **`rate_limited`** uses no attempt. **`cancelled`**: `attempt` is the attempt the job would have run next.
- **`schedule_fired`.** Once per slot, across all processes; none for a schedule paused globally.
- **`error`.** Also logged; never rejects your calls.
- **New types.** A minor version may add event types: give your `switch` a `default` branch.

**Example.** Log slow jobs and lost leases:

```ts
const sqlane = createSqlane({
    adapter,
    onEvent: (event: SqlaneEvent) => {
        if (event.type === 'completed' && event.durationMs > 10_000) console.warn(`slow job ${event.jobId}`);
        if (event.type === 'lease_lost') console.error(`lost the lease of job ${event.jobId}`);
    },
});
```

## Adapters

An adapter connects sqlane to your database library. Create one over the queue's own pool and pass it as
`createSqlane({ adapter })`. [`adapters.md`](adapters.md) has the details and an example for each library.

| Library     | Import                             | Factory                                | Takes                                              |
| ----------- | ---------------------------------- | -------------------------------------- | -------------------------------------------------- |
| mysql2      | `@sqlane/core/adapter-mysql2`      | `mysql2Adapter(pool, options)`         | A `mysql2/promise` `Pool` (MySQL, MariaDB).        |
| pg          | `@sqlane/core/adapter-pg`          | `pgAdapter(pool, options)`             | A `pg` `Pool`.                                     |
| postgres.js | `@sqlane/core/adapter-postgres-js` | `postgresJsAdapter(sql, options)`      | The `sql` from `postgres(…)`.                      |
| Knex        | `@sqlane/core/adapter-knex`        | `knexAdapter(knex, options)`           | Knex with the `mysql2`, `mariadb` or `pg` client.  |
| Kysely      | `@sqlane/core/adapter-kysely`      | `kyselyAdapter(db, options)`           | A `Kysely` instance.                               |
| Drizzle     | `@sqlane/core/adapter-drizzle`     | `drizzleAdapter(db, options)`          | Drizzle over mysql2, node-postgres or postgres.js. |
| Prisma      | `@sqlane/core/adapter-prisma`      | `prismaAdapter(prisma, options)`       | A Prisma client.                                   |
| Sequelize   | `@sqlane/core/adapter-sequelize`   | `sequelizeAdapter(sequelize, options)` | A Sequelize instance.                              |
| TypeORM     | `@sqlane/core/adapter-typeorm`     | `typeOrmAdapter(dataSource, options)`  | An initialized `DataSource`.                       |
| MikroORM    | `@sqlane/core/adapter-mikro-orm`   | `mikroOrmAdapter(em, options)`         | The `EntityManager` of a MikroORM instance.        |

Knex, Kysely, Drizzle and the ORMs support all three databases. sqlane runs on MySQL 8.4+, MariaDB 10.11+ and
PostgreSQL 15+; [`adapters.md`](adapters.md) lists the supported library versions.

**Options.** Every factory takes these options:

| Option                            | Type                                 | Default  | Description                                                          |
| --------------------------------- | ------------------------------------ | -------- | -------------------------------------------------------------------- |
| `dialect`                         | `'mysql' \| 'mariadb' \| 'postgres'` | required | The database that the library talks to; see below.                   |
| `allowUnsupportedDbVersion`       | `boolean`                            | `false`  | Runs below the supported version, with a warning.                    |
| `allowUnsupportedDbConfiguration` | `boolean`                            | `false`  | MySQL, MariaDB: runs with an unsupported `sql_mode`, with a warning. |

pg and postgres.js take only `'postgres'`; mysql2 takes `'mysql'` or `'mariadb'`. Some adapters take more options:

| Option    | Type      | Default                     | Adapters                                           | Description                                            |
| --------- | --------- | --------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `notify`  | `boolean` | `false`                     | pg, postgres.js, Drizzle on PostgreSQL             | Wakes the other processes by LISTEN/NOTIFY, on commit. |
| `prepare` | `boolean` | `true` for pg, else `false` | pg, and Knex, Sequelize and MikroORM on PostgreSQL | Uses named prepared statements.                        |

**Errors.** The factory throws `ConfigError` for an invalid option, or a `dialect` that the library (not Kysely or
Prisma) reports wrong. The first [`runner.start`](#runnerstart), [`schema.migrate`](#sqlaneschemamigrate),
[`rollback`](#sqlaneschemarollback) or [`drop`](#sqlaneschemadrop) checks the server and throws `ConfigError` for
another database than `dialect`, or a version below the supported one (unless `allowUnsupportedDbVersion`). On MySQL
and MariaDB, it also throws for `NO_BACKSLASH_ESCAPES` in `sql_mode` and, unless `allowUnsupportedDbConfiguration`,
for `ALLOW_INVALID_DATES` or a missing required flag:

| Database | Required flags                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| MySQL    | `STRICT_TRANS_TABLES` or `STRICT_ALL_TABLES`, `NO_ZERO_DATE`, `NO_ZERO_IN_DATE`, `ERROR_FOR_DIVISION_BY_ZERO` |
| MariaDB  | `STRICT_TRANS_TABLES` or `STRICT_ALL_TABLES`, `ERROR_FOR_DIVISION_BY_ZERO`                                    |

The default `sql_mode` has them all.

**Notes**

- **The queue's own pool.** Give the adapter 2 or 3 connections, apart from your app's pool; see
  [Two pools](adapters.md#two-pools).
- **What `enqueue` takes.** See [`sqlane.enqueue`](#sqlaneenqueue) and
  [`adapters.md`](adapters.md#what-enqueue-accepts).
- **`notify`.** Not together with a [`hint`](#hint): `createSqlane` throws `ConfigError`.
- **`prepare`.** Set it to `false` behind a transaction-mode pooler without prepared statements, such as PgBouncer
  before 1.21.
- **postgres.js.** The factory throws `ConfigError` when the queue's `sql` transforms results.

**Example**

```ts
import { Pool } from 'pg';
import { createSqlane } from '@sqlane/core';
import { pgAdapter } from '@sqlane/core/adapter-pg';

const queuePool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 }); // the queue's own pool
const sqlane = createSqlane({ adapter: pgAdapter(queuePool, { dialect: 'postgres', notify: true }) });
```
