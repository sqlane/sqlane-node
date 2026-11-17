// The public types of sqlane. See docs/design.md.

/**
 * A duration: non-negative safe integer milliseconds, or decimal quantities with lowercase units in descending
 * order (`w`, `d`, `h`, `m`, `s`, `ms`), each at most once: `'500ms'`, `'4m30s'`, `'1d 1h 1ms'`.
 * Spaces may separate components; quantity and unit must be adjacent. Strings are rounded to milliseconds.
 * @typedef {string | number} Duration
 */

/**
 * The JSON form of T: T itself if it is JSON, else a type that T does not match. Optional fields and interfaces pass;
 * a `Date`, a `Map`, a `Set`, a function, a `bigint` or a class instance with methods does not.
 * @template T
 * @typedef {T extends string | number | boolean | null ? T
 *     : T extends undefined | bigint | symbol | Function | Date | RegExp | Map<any, any> | Set<any> ? never
 *     : T extends readonly (infer U)[] ? readonly Jsonable<U>[]
 *     : T extends object ? { [K in keyof T]: Jsonable<T[K]> }
 *     : never} Jsonable
 */

/**
 * @typedef {object} ExponentialBackoff
 * @property {'exponential'} type `delay × 2^(attempt − 1)`, at most `maxDelay`.
 * @property {Duration} delay
 * @property {Duration} [maxDelay]
 * @property {number} [jitter] 0–1: the delay is `delay × (1 − jitter × random())`. Default: 0.2.
 */

/**
 * @typedef {object} FixedBackoff
 * @property {'fixed'} type
 * @property {Duration} delay
 * @property {number} [jitter] 0–1. Default: 0.2.
 */

/** @typedef {ExponentialBackoff | FixedBackoff} Backoff */

/**
 * How long a finished job is kept. It is also the dedupe window of its `jobId`.
 * @typedef {object} Retention
 * @property {Duration} [completed] Default: `'1h'`.
 * @property {Duration} [failed] Default: `'30d'`.
 */

/**
 * The options of a job name, shared by its producers and workers. A definition overrides the instance `defaults`.
 * @template [P=any] The payload: `defineJob<{ reportId: string }>(…)` types `enqueue`, `handle`,
 *     `globalConcurrencyLimits` and `globalRateLimits`.
 * @typedef {object} JobOptions
 * @property {string} name Matches `^[a-z][a-z0-9_.-]{0,127}$`.
 * @property {number} [maxAttempts] Default: 3.
 * @property {number} [maxStalls] Default: 2.
 * @property {Backoff} [backoff]
 * @property {Retention} [retention]
 * @property {Duration} [timeout] No default. A job with global concurrency limits needs one.
 * @property {(context: { payload: P }) => readonly (ConcurrencyLimit | ConcurrencyLimitKey)[]}
 *     [globalConcurrencyLimits] Limits that the whole cluster counts, per key. Sync, from the context only; at enqueue.
 * @property {number} [fairShareWeight] 1–1000. The name's share of the free slots of an instance. Default: 1.
 * @property {readonly ConcurrencyLimit[]} [localConcurrencyLimits] Limits that each instance counts for its own jobs.
 *     A job starts only while every one of them has room.
 * @property {(context: { payload: P }) => readonly (RateLimit | RateLimitKey)[]} [globalRateLimits] Rate limits that
 *     the whole cluster counts, per key: the starts of jobs. Sync, from the context only; at enqueue. At most 10 keys
 *     with the global concurrency limits.
 * @property {readonly RateLimit[]} [localRateLimits] Rate limits that each instance counts for its own starts: keyless.
 * @property {string | JobDefinition} [failureJob] Added when a job fails for good.
 */

/**
 * The result of `defineJob()`. Frozen.
 * @template [P=any] The payload. `any`: not declared; `enqueue` then checks only that the payload is JSON.
 * @typedef {Readonly<JobOptions<P>>} JobDefinition
 */

/**
 * @template T
 * @typedef {0 extends (1 & T) ? true : false} IsAny
 */

/**
 * The payload that a job definition declares; `never` for a name or a definition without one.
 * @template J
 * @typedef {J extends JobDefinition<infer P> ? (IsAny<P> extends true ? never : P) : never} DeclaredPayload
 */

/**
 * The payload of an enqueue: the declared one (JSON), else any JSON (inferred as P).
 * @template J
 * @template P
 * @typedef {[DeclaredPayload<J>] extends [never] ? P & NoInfer<Jsonable<P>>
 *     : NoInfer<DeclaredPayload<J> & Jsonable<DeclaredPayload<J>>>} EnqueuePayload
 */

/**
 * An item of `enqueueMany`: its payload as in `enqueue`.
 * @template J
 * @template P
 * @typedef {[DeclaredPayload<J>] extends [never] ? EnqueueItem<P> & NoInfer<EnqueueItem<Jsonable<P>>>
 *     : EnqueueItem<NoInfer<DeclaredPayload<J> & Jsonable<DeclaredPayload<J>>>>} EnqueueManyItem
 */

/**
 * The payload that a handler gets: the declared one, else `any`.
 * @template J
 * @typedef {[DeclaredPayload<J>] extends [never] ? any : DeclaredPayload<J>} HandlerPayload
 */

/**
 * A slot of a schedule, run by hand: the job gets the `jobId` that the scheduler gives the slot.
 * @typedef {object} SlotOptions
 * @property {Date} at The slot, in the years 1970 to 9999.
 * @property {string} [key] The `key` of the schedule.
 */

/**
 * @typedef {object} EnqueueBaseOptions
 * @property {number} [maxAttempts]
 * @property {number} [maxStalls]
 * @property {Retention} [retention]
 * @property {string | JobDefinition} [failureJob]
 * @property {readonly (ConcurrencyLimit | ConcurrencyLimitKey)[]} [globalConcurrencyLimits] Replace the global limits
 *     of the definition; `[]` clears them.
 * @property {readonly (RateLimit | RateLimitKey)[]} [globalRateLimits] Replace the global rate limits of the
 *     definition; `[]` clears them.
 */

/**
 * @typedef {object} EnqueueJobIdOption
 * @property {string} [jobId] 1–120 printable ASCII characters, not starting with `schedule:`. Dedupe: a job with this
 *     id is added once while its row exists.
 * @property {never} [slot]
 */

/**
 * @typedef {object} EnqueueSlotOption
 * @property {SlotOptions} slot Runs a slot of a schedule by hand: the job gets the `jobId` of the slot.
 * @property {never} [jobId]
 */

/**
 * The options of an enqueue: `delay` or `runAt`, not both; `jobId` or `slot`, not both.
 * @typedef {EnqueueBaseOptions
 *     & ({ delay?: Duration, runAt?: never } | { runAt: Date, delay?: never })
 *     & (EnqueueJobIdOption | EnqueueSlotOption)} EnqueueOptions
 */

/**
 * @typedef {object} EnqueueResult
 * @property {string} id `<job_name>:<jobId>`, or a new ULID without a `jobId`.
 * @property {boolean} created False: a job with this `jobId` exists already, nothing was added.
 */

/**
 * @template P
 * @typedef {object} EnqueueItem
 * @property {P} payload
 * @property {EnqueueOptions} [options]
 */

/**
 * @typedef {object} JobInfo
 * @property {string} id
 * @property {string} name
 * @property {number} attempt 1 for the first run.
 * @property {number} maxAttempts
 * @property {Date} enqueuedAt
 * @property {readonly { key: string, max: number }[]} globalConcurrencyLimits Its keys, sorted, with their maxes.
 * @property {Date | null} scheduledAt The slot of a job of a schedule (also when it runs late); else null.
 */

/**
 * @template [P=any]
 * @typedef {object} HandlerContext
 * @property {P} payload As JSON gives it back.
 * @property {JobInfo} job
 * @property {AbortSignal} signal Aborted with a `JobTimeoutError`, a `LeaseLostError` or a `ShutdownError`.
 */

/**
 * Runs a job. Its return value is ignored.
 * @template [P=any]
 * @typedef {(context: HandlerContext<P>) => unknown} Handler
 */

/**
 * @typedef {object} ConcurrencyLimitOptions
 * @property {string} name Matches `^[a-z][a-z0-9_.-]{0,127}$`.
 * @property {number} max 1–1000. The most jobs that hold the limit at once.
 */

/**
 * The result of `defineConcurrencyLimit()`. Frozen.
 * @typedef {Readonly<ConcurrencyLimitOptions> & {
 *     readonly key: (value: string | number) => ConcurrencyLimitKey,
 * }} ConcurrencyLimit
 */

/**
 * A key of a global limit, `<limit name>:<value>`: each key counts its own jobs. The result of `limit.key()`.
 * @typedef {Readonly<{ limit: ConcurrencyLimit, key: string }>} ConcurrencyLimitKey
 */

/**
 * @typedef {object} RateLimitOptions
 * @property {string} name Matches `^[a-z][a-z0-9_.-]{0,127}$`.
 * @property {number} max 1–1,000,000. The most starts per `per`, on average: one every `per / max`.
 * @property {Duration} per 1 ms to 7 d.
 * @property {number} [burst] 1–`max`. The starts that may come at once after a pause. Default: 1.
 */

/**
 * The result of `defineRateLimit()`. Frozen.
 * @typedef {Readonly<{ name: string, max: number, per: number, burst: number }> & {
 *     readonly key: (value: string | number, options?: { cost?: number }) => RateLimitKey,
 *     readonly cost: (cost: number) => RateLimitKey,
 * }} RateLimit `per` in milliseconds. `key(value, { cost })`: a key of a global limit, each with its own count;
 *     `cost(n)`: the limit itself. A cost (1 to `burst`, default 1) is the starts that a job takes.
 */

/**
 * A key of a global rate limit at a cost: the result of `limit.key()`, or of `limit.cost()` (`key` null: the limit
 * itself).
 * @typedef {Readonly<{ limit: RateLimit, key: string | null, cost: number }>} RateLimitKey
 */

/**
 * The instance defaults; a definition overrides them.
 * @typedef {object} JobDefaults
 * @property {number} [maxAttempts]
 * @property {number} [maxStalls]
 * @property {Backoff} [backoff]
 * @property {Retention} [retention]
 * @property {Duration} [timeout]
 */

/**
 * A pub/sub that wakes the other processes. Only an optimization: a lost message delays a job until the next poll.
 * @typedef {object} Hint
 * @property {(channel: string, message: string) => Promise<void>} publish
 * @property {(channel: string, onMessage: (message: string) => void) => Promise<() => Promise<void>>} subscribe
 *     Resolves to the unsubscribe function.
 */

/**
 * @typedef {(object: object, message?: string) => void} LogFn
 */

/**
 * A pino-compatible logger.
 * @typedef {object} Logger
 * @property {LogFn} debug
 * @property {LogFn} info
 * @property {LogFn} warn
 * @property {LogFn} error
 */

/**
 * @typedef {object} JobEventBase
 * @property {string} jobId
 * @property {string} jobName
 * @property {number} attempt
 */

/**
 * An event of the job lifecycle, by `type`.
 * @typedef {(JobEventBase & (
 *     | { type: 'claimed' }
 *     | { type: 'completed', durationMs: number }
 *     | { type: 'retried', durationMs: number, delayMs: number, error: unknown }
 *     | { type: 'failed', durationMs: number, error: unknown }
 *     | { type: 'rate_limited', durationMs: number, limit: string, key: string | null, scope: 'global' | 'local',
 *         retryAt: Date, error: unknown }
 *     | { type: 'timed_out', durationMs: number }
 *     | { type: 'stalled' }
 *     | { type: 'released' }
 *     | { type: 'lease_lost' }
 *     | { type: 'failure_job_not_added', failureJob: string, error: unknown }
 * )) | ScheduleFiredEvent | { type: 'error', operation: string, error: unknown }} SqlaneEvent
 */

/**
 * A slot of a schedule was decided: once in the cluster, by the process that moved the cursor.
 * @typedef {object} ScheduleFiredEvent
 * @property {'schedule_fired'} type
 * @property {string} scheduleId
 * @property {string} jobName
 * @property {Date} scheduledAt The slot.
 * @property {boolean} late A catch-up of a missed slot.
 * @property {string | null} jobId The job of the slot. Null: `overlap: 'skip'` skipped the slot.
 */

/**
 * When a schedule adds its jobs: a cron in a time zone, or a fixed interval. Not both.
 * @typedef {{ cron: string, timezone?: string, every?: never }
 *     | { every: Duration, cron?: never, timezone?: never }} ScheduleTiming
 */

/**
 * @typedef {object} ScheduleBaseOptions
 * @property {string} [key] Tells several schedules of one job name apart: 1–64 printable ASCII characters.
 * @property {'once' | 'skip'} [missed] A slot that no process enqueued within 1 minute. Default: `'once'`: the
 *     latest missed slot runs once, within the catch-up reach.
 * @property {'allow' | 'skip'} [overlap] Default: `'allow'`. `'skip'`: a slot adds no job while the previous job of
 *     the schedule is pending or running.
 * @property {Duration} [jitter] Up to `'1d'`; below `every`. Each slot runs at a fixed offset after it, below the
 *     jitter and below the next slot: the runs of many schedules spread out.
 */

/**
 * The options of `schedule()`. With a payload type, `payload` is required: a variable of this type passes to
 * `schedule()` with a definition of that payload type.
 * @template [P=any] The payload of each job. Default: `{}`.
 * @typedef {ScheduleBaseOptions & ScheduleTiming & (IsAny<P> extends true ? { payload?: P } : { payload: P })}
 *     ScheduleOptions
 */

/**
 * The payload of a schedule, with `ScheduleOptions`: required and checked when the definition declares one, else any
 * JSON.
 * @template J
 * @template P
 * @typedef {[DeclaredPayload<J>] extends [never] ? { payload?: P & NoInfer<Jsonable<P>> }
 *     : { payload: NoInfer<DeclaredPayload<J> & Jsonable<DeclaredPayload<J>>> }} SchedulePayload
 */

/**
 * @typedef {object} ScheduleInfo
 * @property {string} id `<job name>` or `<job name>:<key>`.
 * @property {string} name The job name.
 * @property {string} spec The stored spec, e.g. `cron 0 3 * * * Europe/Berlin` or `every 900000`.
 * @property {boolean} registered `schedule()` was called in this process.
 * @property {Date | null} nextAt Registered: the next slot. Null: not registered, or no next slot.
 * @property {Date | null} nextRunAt When the job of the next slot will be due: `nextAt` plus its jitter. Null when
 *     `nextAt` is.
 * @property {Date | null} lastSlotAt The cursor: the last decided slot.
 * @property {string | null} lastJobId The job of the last enqueued slot.
 */

/**
 * The SQL dialect: the database family.
 * @typedef {'mysql' | 'mariadb' | 'postgres'} Dialect
 */

/**
 * The connections that `enqueue` accepts (C), and the queue's own pool. Made by `mysql2Adapter()` or `pgAdapter()`.
 * @template C
 * @typedef {object} Adapter
 * @property {Dialect} dialect The database, as the app named it. The first `start()` or `migrate()` of an instance
 *     checks it against the server.
 * @property {boolean} [allowUnsupportedVersion] A server below the supported minimum (MySQL 8.4, MariaDB 10.11,
 *     PostgreSQL 15) logs a warning instead of a `ConfigError`.
 * @property {(connection: C) => Executor} wrap Used by sqlane: wraps a connection given to `enqueue`.
 * @property {Executor} queue Used by sqlane: the queue's own pool.
 * @property {<T>(func: (executor: Executor) => Promise<T>) => Promise<T>} withConnection Used by sqlane: runs func on
 *     one connection of the queue's pool, then releases it.
 * @property {<T>(func: (executor: Executor) => Promise<T>) => Promise<T>} queueTransaction Used by sqlane: runs func
 *     in a `READ COMMITTED` transaction on a connection of the queue's pool.
 * @property {<T>(connection: C, func: (executor: Executor) => Promise<T>) => Promise<T>} inTransaction Used by sqlane:
 *     a pool → func in a transaction of its own; a connection or a client → func on it, in the caller's transaction.
 * @property {<T>(connection: C, func: (executor: Executor) => Promise<T>) => Promise<T>} [inStatement] Used by sqlane,
 *     PostgreSQL: runs func, which sends one statement: a pool → on the pool, outside a transaction (the statement is
 *     atomic); a connection or a client → on it, in the caller's transaction. Without it: `inTransaction`.
 * @property {(connection: C, onCommit: () => void) => boolean} [afterCommit] Used by sqlane, after an enqueue on the
 *     connection: calls onCommit once its transaction commits (at once when it has committed: a pool), never when it
 *     rolls back. Returns false when the adapter cannot tell (a connection in the caller's transaction): sqlane then
 *     re-probes until it sees the job. A call of onCommit without a commit costs one probe.
 * @property {boolean} [transactionalConnection] `withConnection` runs func in a transaction (an ORM that has no
 *     connection outside one): the migration of PostgreSQL does not begin and commit one of its own.
 * @property {boolean} [notify] PostgreSQL: hints by LISTEN/NOTIFY.
 * @property {(channel: string, onMessage: (message: string) => void) => Promise<() => Promise<void>>} [listen] Used by
 *     sqlane, with `notify`: LISTEN on a connection of its own; resolves to the unlisten function.
 */

/**
 * Runs SQL. Used by sqlane, through an adapter.
 * @typedef {object} Executor
 * @property {(sql: string, params: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>} query
 * @property {(sql: string, params: readonly unknown[]) => Promise<number>} run Runs an INSERT, UPDATE or DELETE:
 *     the number of rows it changed.
 */

/**
 * @template C
 * @typedef {object} SqlaneOptions
 * @property {Adapter<C>} adapter
 * @property {readonly JobDefinition[]} [jobs] The definitions known by name.
 * @property {number} [localMaxConcurrency] The handlers that run at the same time in this instance. Default: 10.
 * @property {JobDefaults} [defaults]
 * @property {'allow' | 'reject'} [unknownJobs] Default: `'allow'`. `'reject'`: `enqueue` of a name that is not in
 *     `jobs` and not handled throws an `UnknownJobError`.
 * @property {Hint | null} [hint] Default: null: polling only.
 * @property {Logger} [logger] Default: no logs.
 * @property {(event: SqlaneEvent) => void} [onEvent]
 * @property {string} [tablePrefix] Default: `'sqlane_'`.
 * @property {Duration} [pollInterval] Default: `'5s'`.
 * @property {number} [maxPayloadBytes] Default: 256 KiB.
 * @property {boolean} [cleanup] Built-in deletion of the expired jobs. Default: true.
 */

/**
 * @typedef {object} DrainOptions
 * @property {Duration} [timeout] Default: `'10s'`.
 * @property {boolean} [includeDelayed] Also runs the delayed jobs and the retries in backoff at once.
 */

/**
 * @typedef {object} DrainResult
 * @property {number} completed
 * @property {number} retried Failed attempts that were retried.
 * @property {number} failed Jobs that failed for good.
 */

/**
 * @typedef {object} CloseOptions
 * @property {Duration} [deadline] From the call. Default: `'30s'`.
 * @property {'release' | 'abandon'} [mode] Default: `'release'`.
 * @property {Duration} [exitsBy] From the call: the latest time the process exits. Default: the deadline plus one
 *     lease.
 */

/**
 * @typedef {object} MigrateOptions
 * @property {Duration} [lockTimeout] Default: `'10m'`.
 */

/**
 * @typedef {object} JobStats
 * @property {string} name
 * @property {number} pending
 * @property {number} due
 * @property {number} running
 * @property {number} stuck Timed out, the handler has not settled.
 * @property {number} failed
 * @property {number | null} oldestDueAgeMs
 */

/**
 * The payload of a failure job.
 * @typedef {object} FailedJobPayload
 * @property {{ id: string, name: string, payload: any, attempt: number, maxAttempts: number }} job
 * @property {{ name: string, message: string, stack?: string, code?: string }} error `code`: the string `code` of the
 *     thrown error, if it had one.
 */

/**
 * @template C The connections that `enqueue` accepts.
 * @typedef {object} Sqlane
 * @property {<J extends JobDefinition | string, P>(
 *     connection: C, job: J, payload: EnqueuePayload<J, P>, options?: EnqueueOptions,
 * ) => Promise<EnqueueResult>} enqueue Adds a job with the caller's connection: it must be in a transaction (or a
 *     pool: then sqlane opens its own transaction).
 * @property {<J extends JobDefinition | string, P>(
 *     connection: C, job: J, items: readonly EnqueueManyItem<J, P>[],
 * ) => Promise<EnqueueResult[]>} enqueueMany The results are in the order of the items.
 * @property {<J extends JobDefinition | string>(
 *     job: J, handler: Handler<HandlerPayload<J>>,
 * ) => void} handle
 * @property {<J extends JobDefinition | string, P>(
 *     job: J, options: ScheduleBaseOptions & ScheduleTiming & SchedulePayload<J, P>,
 * ) => void} schedule Adds a job at each slot of a cron or an interval, in every started process that calls it.
 *     Before `start()`.
 * @property {() => Promise<ScheduleInfo[]>} getSchedules The schedules of the table and of this process.
 * @property {() => Promise<void>} start Starts the runner and the schedules. Idempotent.
 * @property {(options?: DrainOptions) => Promise<DrainResult>} drain For tests: runs the due jobs of the handled
 *     names until none is left, without `start()`. It does not fire schedules.
 * @property {(options?: CloseOptions) => Promise<void>} close
 * @property {(options?: MigrateOptions) => Promise<{ applied: string[] }>} migrate Applies the missing migrations:
 *     their ids.
 * @property {() => Promise<JobStats[]>} getStats
 * @property {() => void} wake Low level: probes the handled names now, instead of at the next poll. Does nothing
 *     before `start()`.
 */

/**
 * @typedef {object} Migration
 * @property {string} id
 * @property {readonly string[]} statements
 */

// oxlint-disable-next-line unicorn/require-module-specifiers -- makes the file a module: its typedefs are exported
export {};
