export type Duration = string | number;
export type Jsonable<T> = T extends string | number | boolean | null ? T : T extends undefined | bigint | symbol | Function | Date | RegExp | Map<any, any> | Set<any> ? never : T extends readonly (infer U)[] ? readonly Jsonable<U>[] : T extends object ? {
    [K in keyof T]: Jsonable<T[K]>;
} : never;
export type ExponentialBackoff = {
    /**
     * `delay × 2^(attempt − 1)`, at most `maxDelay`.
     */
    type: 'exponential';
    /**
     * The base wait.
     */
    delay: Duration;
    /**
     * The longest wait: at least `delay`.
     */
    maxDelay?: Duration;
    /**
     * 0–1: the delay is `delay × (1 − jitter × random())`. Default: 0.2.
     */
    jitter?: number;
};
export type FixedBackoff = {
    /**
     * The wait is always `delay`.
     */
    type: 'fixed';
    /**
     * The wait.
     */
    delay: Duration;
    /**
     * 0–1. Default: 0.2.
     */
    jitter?: number;
};
export type Backoff = ExponentialBackoff | FixedBackoff;
export type Retention = {
    /**
     * Default: `'1h'`.
     */
    completed?: Duration;
    /**
     * Default: `'30d'`.
     */
    failed?: Duration;
};
export type JobOptions<P = any> = {
    /**
     * Matches `^[a-z][a-z0-9_.-]{0,127}$`.
     */
    name: string;
    /**
     * The runs of a job before it fails for good. Default: 3. Set at enqueue; a
     * `one_more` retry changes it.
     */
    maxAttempts?: number;
    /**
     * The stalls (a lost lease, a crashed process) that a job survives. Default: 2. Set at
     * enqueue; a `one_more` retry changes it.
     */
    maxStalls?: number;
    /**
     * The wait before the next attempt. Default:
     * `{ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 }`.
     */
    backoff?: Backoff;
    /**
     * How long a finished job is kept. Default: `{ completed: '1h', failed: '30d' }`.
     */
    retention?: Retention;
    /**
     * Aborts the handler's `signal` after it. No default. A job with global concurrency
     * limits needs one.
     */
    timeout?: Duration;
    /**
     * Limits that the whole cluster counts, per key. Sync, from the context only; at enqueue.
     */
    globalConcurrencyLimits?: (context: {
        payload: P;
    }) => readonly (ConcurrencyLimit | ConcurrencyLimitKey)[];
    /**
     * 1–1000. The name's share of the free slots of an instance. Default: 1.
     */
    fairShareWeight?: number;
    /**
     * Limits that each instance counts for its own jobs.
     * A job starts only while every one of them has room.
     */
    localConcurrencyLimits?: readonly ConcurrencyLimit[];
    /**
     * Rate limits that
     * the whole cluster counts, per key: the starts of jobs. Sync, from the context only; at enqueue. At most 10 keys
     * with the global concurrency limits.
     */
    globalRateLimits?: (context: {
        payload: P;
    }) => readonly (RateLimit | RateLimitKey)[];
    /**
     * Rate limits that each instance counts for its own starts: keyless.
     */
    localRateLimits?: readonly RateLimit[];
    /**
     * Added when a job fails for good.
     */
    failureJob?: string | JobDefinition;
};
export type JobDefinition<P = any> = Readonly<JobOptions<P>>;
export type IsAny<T> = 0 extends (1 & T) ? true : false;
export type DeclaredPayload<J> = J extends JobDefinition<infer P> ? (IsAny<P> extends true ? never : P) : never;
export type EnqueuePayload<J, P> = [DeclaredPayload<J>] extends [never] ? P & NoInfer<Jsonable<P>> : NoInfer<DeclaredPayload<J> & Jsonable<DeclaredPayload<J>>>;
export type EnqueueManyItem<J, P> = [DeclaredPayload<J>] extends [never] ? EnqueueItem<P> & NoInfer<EnqueueItem<Jsonable<P>>> : EnqueueItem<NoInfer<DeclaredPayload<J> & Jsonable<DeclaredPayload<J>>>>;
export type HandlerPayload<J> = [DeclaredPayload<J>] extends [never] ? any : DeclaredPayload<J>;
export type SlotOptions = {
    /**
     * The slot, in the years 1970 to 9999.
     */
    at: Date;
    /**
     * The `key` of the schedule.
     */
    key?: string;
};
export type EnqueueBaseOptions = {
    /**
     * Overrides the definition's `maxAttempts` for this job. A `one_more` retry changes
     * it.
     */
    maxAttempts?: number;
    /**
     * Overrides the definition's `maxStalls` for this job. A `one_more` retry changes it.
     */
    maxStalls?: number;
    /**
     * Overrides the definition's retention for this job, field by field.
     */
    retention?: Retention;
    /**
     * Overrides the definition's failure job for this job.
     */
    failureJob?: string | JobDefinition;
    /**
     * Replace the global limits
     * of the definition; `[]` clears them.
     */
    globalConcurrencyLimits?: readonly (ConcurrencyLimit | ConcurrencyLimitKey)[];
    /**
     * Replace the global rate limits of the
     * definition; `[]` clears them.
     */
    globalRateLimits?: readonly (RateLimit | RateLimitKey)[];
};
export type EnqueueJobIdOption = {
    /**
     * 1–120 printable ASCII characters, not starting with `schedule:`. Dedupe: a job with this
     * id is added once while its row exists.
     */
    jobId?: string;
    /**
     * Not with `jobId`.
     */
    slot?: never;
};
export type EnqueueSlotOption = {
    /**
     * Runs a slot of a schedule by hand: the job gets the `jobId` of the slot.
     */
    slot: SlotOptions;
    /**
     * Not with `slot`.
     */
    jobId?: never;
};
export type EnqueueOptions = EnqueueBaseOptions & ({
    delay?: Duration;
    runAt?: never;
} | {
    runAt: Date;
    delay?: never;
}) & (EnqueueJobIdOption | EnqueueSlotOption);
export type EnqueueResult = {
    /**
     * `<job_name>:<jobId>`, or a new ULID without a `jobId`.
     */
    id: string;
    /**
     * False: a job with this `jobId` exists already, nothing was added.
     */
    created: boolean;
};
export type EnqueueItem<P> = {
    /**
     * The payload of this job, as in `enqueue`.
     */
    payload: P;
    /**
     * The options of this job, as in `enqueue`.
     */
    options?: EnqueueOptions;
};
export type JobInfo = {
    /**
     * The job id.
     */
    id: string;
    /**
     * The job name.
     */
    name: string;
    /**
     * 1 for the first run.
     */
    attempt: number;
    /**
     * The most attempts of this job: set at enqueue; a `one_more` retry changes it.
     */
    maxAttempts: number;
    /**
     * The time of the enqueue.
     */
    enqueuedAt: Date;
    /**
     * Its keys, sorted, with their maxes.
     */
    globalConcurrencyLimits: readonly {
        key: string;
        max: number;
    }[];
    /**
     * The slot of a job of a schedule (also when it runs late); else null.
     */
    scheduledAt: Date | null;
    /**
     * The job's due time, as stored: its place in line. A retry, a release, a stall,
     * `drain({ includeDelayed })` and `jobs.retry()` set it; a block on a key, its unblock and a `RateLimitedError`
     * on a global rate key keep it. So the start delay, `startedAt − runAt`, includes the time on a key and a
     * rate-limited run. From the app's clock with the `runAt` option, until the first rerun.
     */
    runAt: Date;
    /**
     * The start of this run, by the database clock, as `JobRecord.startedAt` shows it.
     */
    startedAt: Date;
};
export type HandlerContext<P = any> = {
    /**
     * As JSON gives it back.
     */
    payload: P;
    /**
     * The job: its id, name, attempt, slot and keys.
     */
    job: JobInfo;
    /**
     * Aborted with a `JobTimeoutError`, a `LeaseLostError` or a `ShutdownError`.
     */
    signal: AbortSignal;
};
export type Handler<P = any> = (context: HandlerContext<P>) => unknown;
export type ConcurrencyLimitOptions = {
    /**
     * Matches `^[a-z][a-z0-9_.-]{0,127}$`.
     */
    name: string;
    /**
     * 1–1000. The most jobs that hold the limit at once.
     */
    max: number;
};
export type ConcurrencyLimit = Readonly<ConcurrencyLimitOptions> & {
    readonly key: (value: string | number) => ConcurrencyLimitKey;
};
export type ConcurrencyLimitKey = Readonly<{
    limit: ConcurrencyLimit;
    key: string;
}>;
export type RateLimitOptions = {
    /**
     * Matches `^[a-z][a-z0-9_.-]{0,127}$`.
     */
    name: string;
    /**
     * 1–1,000,000. The most starts per `per`, on average: one every `per / max`.
     */
    max: number;
    /**
     * 1 ms to 7 d.
     */
    per: Duration;
    /**
     * 1–`max`. The starts that may come at once after a pause. Default: 1.
     */
    burst?: number;
};
export type RateLimit = Readonly<{
    name: string;
    max: number;
    per: number;
    burst: number;
}> & {
    readonly key: (value: string | number, options?: {
        cost?: number;
    }) => RateLimitKey;
    readonly cost: (cost: number) => RateLimitKey;
};
export type RateLimitKey = Readonly<{
    limit: RateLimit;
    key: string | null;
    cost: number;
}>;
export type JobDefaults = {
    /**
     * The runs of a job before it fails for good. Default: 3.
     */
    maxAttempts?: number;
    /**
     * The stalls that a job survives. Default: 2.
     */
    maxStalls?: number;
    /**
     * The wait before the next attempt. Default:
     * `{ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 }`.
     */
    backoff?: Backoff;
    /**
     * How long a finished job is kept. Default: `{ completed: '1h', failed: '30d' }`.
     */
    retention?: Retention;
    /**
     * Aborts the handler's `signal` after it. No default.
     */
    timeout?: Duration;
};
export type Hint = {
    /**
     * Sends a message on a channel.
     */
    publish: (channel: string, message: string) => Promise<void>;
    /**
     *     Resolves to the unsubscribe function.
     */
    subscribe: (channel: string, onMessage: (message: string) => void) => Promise<() => Promise<void>>;
};
export type LogFn = (object: object, message?: string) => void;
export type Logger = {
    /**
     * Transient errors that sqlane retried at once.
     */
    debug: LogFn;
    /**
     * Recoveries, such as schedules that enqueue their slots again.
     */
    info: LogFn;
    /**
     * What sqlane works around: a clock skew, a server below the supported version.
     */
    warn: LogFn;
    /**
     * Failed operations, such as a failed job; also an `error` event.
     */
    error: LogFn;
};
export type JobEventBase = {
    /**
     * The job id.
     */
    jobId: string;
    /**
     * The job name.
     */
    jobName: string;
    /**
     * The attempt, from 1. After a stall, the attempt of the run that stalled.
     */
    attempt: number;
};
export type SqlaneEvent = (JobEventBase & ({
    type: 'claimed';
    runAt: Date;
    enqueuedAt: Date;
    startedAt: Date;
} | {
    type: 'completed';
    durationMs: number;
} | {
    type: 'retried';
    durationMs: number;
    delayMs: number;
    error: unknown;
} | {
    type: 'failed';
    durationMs: number;
    error: unknown;
} | {
    type: 'rate_limited';
    durationMs: number;
    limit: string;
    key: string | null;
    scope: 'global' | 'local';
    retryAt: Date;
    error: unknown;
} | {
    type: 'timed_out';
    durationMs: number;
} | {
    type: 'stalled';
} | {
    type: 'released';
} | {
    type: 'lease_lost';
} | {
    type: 'failure_job_not_added';
    failureJob: string;
    error: unknown;
} | {
    type: 'cancelled';
})) | ScheduleFiredEvent | {
    type: 'error';
    operation: string;
    error: unknown;
};
export type ScheduleFiredEvent = {
    /**
     * The event type.
     */
    type: 'schedule_fired';
    /**
     * `<job name>` or `<job name>:<key>`.
     */
    scheduleId: string;
    /**
     * The job name.
     */
    jobName: string;
    /**
     * The slot.
     */
    scheduledAt: Date;
    /**
     * A catch-up of a missed slot.
     */
    late: boolean;
    /**
     * The job of the slot. Null: `overlap: 'skip'` skipped the slot.
     */
    jobId: string | null;
};
export type ScheduleTiming = {
    cron: string;
    timezone?: string;
    every?: never;
} | {
    every: Duration;
    cron?: never;
    timezone?: never;
};
export type ScheduleBaseOptions = {
    /**
     * Tells several schedules of one job name apart: 1–64 printable ASCII characters.
     */
    key?: string;
    /**
     * A slot that no process enqueued within 1 minute. Default: `'once'`: the
     * latest missed slot runs once, within the catch-up reach.
     */
    missed?: 'once' | 'skip';
    /**
     * Default: `'allow'`. `'skip'`: a slot adds no job while the previous job of
     * the schedule is pending or running.
     */
    overlap?: 'allow' | 'skip';
    /**
     * Up to `'1d'`; below `every`. Each slot runs at a fixed offset after it, below the
     * jitter and below the next slot: the runs of many schedules spread out.
     */
    jitter?: Duration;
};
export type ScheduleOptions<P = any> = ScheduleBaseOptions & ScheduleTiming & (IsAny<P> extends true ? {
    payload?: P;
} : {
    payload: P;
});
export type SchedulePayload<J, P> = [DeclaredPayload<J>] extends [never] ? {
    payload?: P & NoInfer<Jsonable<P>>;
} : {
    payload: NoInfer<DeclaredPayload<J> & Jsonable<DeclaredPayload<J>>>;
};
export type ScheduleInfo = {
    /**
     * `<job name>` or `<job name>:<key>`.
     */
    id: string;
    /**
     * The job name.
     */
    name: string;
    /**
     * The stored spec, e.g. `cron 0 3 * * * Europe/Berlin` or `every 900000`.
     */
    spec: string;
    /**
     * `schedule()` was called in this process.
     */
    registered: boolean;
    /**
     * Registered: the next slot. Null: not registered, or no next slot.
     */
    nextAt: Date | null;
    /**
     * When the job of the next slot will be due: `nextAt` plus its jitter. Null when
     * `nextAt` is.
     */
    nextRunAt: Date | null;
    /**
     * The cursor: the last decided slot.
     */
    lastSlotAt: Date | null;
    /**
     * The job of the last enqueued slot.
     */
    lastJobId: string | null;
};
export type Dialect = 'mysql' | 'mariadb' | 'postgres';
export type Adapter<C> = {
    /**
     * The database, as the app named it. The first `start()` or call of `schema.migrate()`,
     * `schema.rollback()` or `schema.drop()` of an instance checks it against the server.
     */
    dialect: Dialect;
    /**
     * A server below the supported minimum (MySQL 8.4, MariaDB 10.11,
     * PostgreSQL 15) logs a warning instead of a `ConfigError`.
     */
    allowUnsupportedDbVersion?: boolean;
    /**
     * MySQL and MariaDB: a `sql_mode` that lacks a required flag,
     * or has `ALLOW_INVALID_DATES`, logs a warning instead of a `ConfigError`. `NO_BACKSLASH_ESCAPES` is always one.
     */
    allowUnsupportedDbConfiguration?: boolean;
    /**
     * Used by sqlane: wraps a connection given to `enqueue`.
     */
    wrap: (connection: C) => Executor;
    /**
     * Used by sqlane: the queue's own pool.
     */
    queue: Executor;
    /**
     * Used by sqlane: runs func on
     * one connection of the queue's pool, then releases it.
     */
    withConnection: <T>(func: (executor: Executor) => Promise<T>) => Promise<T>;
    /**
     * Used by sqlane: runs func
     * in a `READ COMMITTED` transaction on a connection of the queue's pool.
     */
    queueTransaction: <T>(func: (executor: Executor) => Promise<T>) => Promise<T>;
    /**
     * Used by sqlane:
     * a pool → func in a transaction of its own; a connection or a client → func on it, in the caller's transaction.
     */
    inTransaction: <T>(connection: C, func: (executor: Executor) => Promise<T>) => Promise<T>;
    /**
     * Used by sqlane,
     * PostgreSQL: runs func, which sends one statement: a pool → on the pool, outside a transaction (the statement is
     * atomic); a connection or a client → on it, in the caller's transaction. Without it: `inTransaction`.
     */
    inStatement?: <T>(connection: C, func: (executor: Executor) => Promise<T>) => Promise<T>;
    /**
     * Used by sqlane, by the bulk methods of `sqlane.jobs`: a pool (or an ORM instance outside a transaction) → func
     * in a READ COMMITTED transaction of sqlane's own on it, decided synchronously; a connection or a client in a
     * transaction → `null`. Without it, a pool given as `connection` runs as a caller's connection, through
     * `inTransaction`.
     */
    poolTransaction?: <T>(connection: C, func: (executor: Executor) => Promise<T>) => Promise<T> | null;
    /**
     * Used by sqlane, after an enqueue on the
     * connection: calls onCommit once its transaction commits (at once when it has committed: a pool), never when it
     * rolls back. Returns false when the adapter cannot tell (a connection in the caller's transaction): sqlane then
     * re-probes until it sees the job. A call of onCommit without a commit costs one probe.
     */
    afterCommit?: (connection: C, onCommit: () => void) => boolean;
    /**
     * `withConnection` runs func in a transaction (an ORM that has no
     * connection outside one): the migration of PostgreSQL does not begin and commit one of its own.
     */
    transactionalConnection?: boolean;
    /**
     * PostgreSQL: hints by LISTEN/NOTIFY.
     */
    notify?: boolean;
    /**
     * Used by
     * sqlane, with `notify`: LISTEN on a connection of its own; resolves to the unlisten function.
     */
    listen?: (channel: string, onMessage: (message: string) => void) => Promise<() => Promise<void>>;
};
export type Executor = {
    /**
     * Runs a
     * SELECT: its rows.
     */
    query: (sql: string, params: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>;
    /**
     * Runs an INSERT, UPDATE or DELETE:
     * the number of rows it changed.
     */
    run: (sql: string, params: readonly unknown[]) => Promise<number>;
};
export type SqlaneOptions<C> = {
    /**
     * The adapter of your driver or ORM, over the queue's own small pool, e.g.
     * `pgAdapter(queuePool, { dialect: 'postgres' })`.
     */
    adapter: Adapter<C>;
    /**
     * The definitions known by name.
     */
    jobs?: readonly JobDefinition[];
    /**
     * The handlers that run at the same time in this instance. Default: 10.
     */
    localMaxConcurrency?: number;
    /**
     * Defaults of `maxAttempts`, `maxStalls`, `backoff`, `retention` and `timeout`. A
     * definition overrides them.
     */
    defaults?: JobDefaults;
    /**
     * Default: `'allow'`. `'reject'`: `enqueue` of a name that is not in
     * `jobs` and not handled throws an `UnknownJobError`.
     */
    unknownJobs?: 'allow' | 'reject';
    /**
     * Default: null: polling only.
     */
    hint?: Hint | null;
    /**
     * Default: no logs.
     */
    logger?: Logger;
    /**
     * Gets the events of the job lifecycle. A throw is logged.
     */
    onEvent?: (event: SqlaneEvent) => void;
    /**
     * Default: `'sqlane_'`.
     */
    tablePrefix?: string;
    /**
     * Default: `'5s'`.
     */
    pollInterval?: Duration;
    /**
     * Default: 256 KiB.
     */
    maxPayloadBytes?: number;
    /**
     * Built-in deletion of the expired jobs. Default: true.
     */
    cleanup?: boolean;
};
export type DrainOptions = {
    /**
     * Default: `'10s'`.
     */
    timeout?: Duration;
    /**
     * Also runs the delayed jobs and the retries in backoff at once.
     */
    includeDelayed?: boolean;
};
export type DrainResult = {
    /**
     * Jobs that completed.
     */
    completed: number;
    /**
     * Failed attempts that were retried.
     */
    retried: number;
    /**
     * Jobs that failed for good.
     */
    failed: number;
};
export type CloseOptions = {
    /**
     * From the call. Default: `'30s'`.
     */
    deadline?: Duration;
    /**
     * Default: `'release'`.
     */
    mode?: 'release' | 'abandon';
    /**
     * From the call: the latest time the process exits. Default: the deadline plus one
     * lease.
     */
    exitsBy?: Duration;
};
export type MigrateOptions = {
    /**
     * `'X.Y.Z'`: only the migrations tagged at or below it. From `'6.0.0'` up to the
     * installed version. Default: every migration.
     */
    targetVersion?: string;
    /**
     * Default: `'10m'`.
     */
    lockTimeout?: Duration;
};
export type RollbackOptions = {
    /**
     * `'X.Y.Z'`: the migrations tagged above it are reverted. From `'6.0.0'` up to the
     * installed version.
     */
    targetVersion: string;
    /**
     * For the migration lock, and for each lock of a table. Default: `'10m'`.
     */
    lockTimeout?: Duration;
};
export type MigrationStatus = {
    /**
     * `missingRequired` is empty.
     */
    ok: boolean;
    /**
     * Not recorded, tagged up to the base of the installed major (`X.0.0`): the
     * queries of this version need them.
     */
    missingRequired: string[];
    /**
     * Not recorded, tagged above `X.0.0`: only the features that they serve need
     * them.
     */
    missingOptional: string[];
    /**
     * Recorded, unknown to this version: a newer version migrated.
     */
    unknownApplied: string[];
};
export type SchemaIssue = 'missing_table' | 'missing_column' | 'wrong_type' | 'wrong_nullability' | 'missing_index' | 'wrong_index';
export type SchemaProblem = {
    /**
     * With its prefix.
     */
    table: string;
    /**
     * The column of a column issue.
     */
    column?: string;
    /**
     * The index of an index issue, with its prefix (MySQL's primary key: `PRIMARY`).
     */
    index?: string;
    /**
     * What is wrong.
     */
    issue: SchemaIssue;
    /**
     * For a wrong type, nullability or index: what this version expects.
     */
    expected?: string;
    /**
     * For a wrong type, nullability or index: what the catalog has.
     */
    found?: string;
    /**
     * False: from a migration tagged above the base of the installed major (`X.0.0`).
     */
    required: boolean;
};
export type SchemaProblems = {
    /**
     * No problem with `required: true`.
     */
    ok: boolean;
    /**
     * Every problem, required or not.
     */
    problems: SchemaProblem[];
};
export type DropOptions = {
    /**
     * For the migration lock, and for the locks of the tables. Default: `'10m'`.
     */
    lockTimeout?: Duration;
};
export type JobStats = {
    /**
     * The job name.
     */
    name: string;
    /**
     * The jobs that wait to run, also those not due yet and those blocked on a key.
     */
    pending: number;
    /**
     * The pending jobs that are due now.
     */
    due: number;
    /**
     * The jobs that run now.
     */
    running: number;
    /**
     * Timed out, the handler has not settled.
     */
    stuck: number;
    /**
     * The failed jobs that sqlane still keeps.
     */
    failed: number;
    /**
     * How long the oldest due job has waited, in ms. Null: no job is due.
     */
    oldestDueAgeMs: number | null;
};
export type JobError = {
    /**
     * The `name` of the error, as a string: not always an exported class (`StalledError`).
     */
    name: string;
    /**
     * The `message` of the error, or the thrown value as a string.
     */
    message: string;
    /**
     * At most 8,192 UTF-16 code units (`String#length`).
     */
    stack?: string;
    /**
     * The string `code` of the thrown error, if it had one.
     */
    code?: string;
};
export type JobStatus = 'pending' | 'blocked' | 'running' | 'completed' | 'failed';
export type BlockedOn = {
    type: 'concurrency';
    key: string;
} | {
    type: 'rate';
    limit: string;
    key: string | null;
};
export type JobRecord<P = any> = {
    /**
     * The full job id.
     */
    id: string;
    /**
     * The job name.
     */
    name: string;
    /**
     * The state when read. `pending` does not include `blocked`.
     */
    status: JobStatus;
    /**
     * The finished attempts: a completion, a retry or a failure each add one. A `reset` retry
     * sets it to 0.
     */
    attempts: number;
    /**
     * Set at enqueue; a `one_more` retry changes it.
     */
    maxAttempts: number;
    /**
     * The times its lease ended while it ran. A `reset` retry sets it to 0.
     */
    stalls: number;
    /**
     * The stalls it survives: set at enqueue; a `one_more` retry changes it.
     */
    maxStalls: number;
    /**
     * When the job is due, or was: its place in line; a running or finished job, the due time of
     * its last run. A blocked job keeps it; after a `RateLimitedError` on a global rate key, the due time of the run
     * that was rate limited. `jobs.retry` sets it as a rerun does (truncated to the millisecond on PostgreSQL); a
     * cancelled job that never ran keeps its due time.
     */
    runAt: Date;
    /**
     * The time of the insert, not of the commit.
     */
    enqueuedAt: Date;
    /**
     * The start of its last run. Null: it never ran.
     */
    startedAt: Date | null;
    /**
     * When it completed or failed for good.
     */
    finishedAt: Date | null;
    /**
     * From when cleanup may delete the finished job.
     */
    expiresAt: Date | null;
    /**
     * The slot of a job of a schedule.
     */
    scheduledAt: Date | null;
    /**
     * Running and timed out, by the last state written.
     */
    stuck: boolean;
    /**
     * The last error written to the job: of a failed attempt, a stall, a
     * `RateLimitedError` on a global rate key of the job, or `jobs.cancel` (`JobCancelledError`). Kept when the job
     * later completes.
     */
    lastError: JobError | null;
    /**
     * Its full keys, sorted, with their maxes.
     */
    globalConcurrencyLimits: readonly {
        key: string;
        max: number;
    }[];
    /**
     * Its rate limits: the limit name and the key value (null: the limit itself), `per` in ms; sorted
     * by the full rate key.
     */
    globalRateLimits: readonly {
        limit: string;
        key: string | null;
        max: number;
        per: number;
        burst: number;
        cost: number;
    }[];
    /**
     * What a blocked job waits for. Null when it is not blocked. Its `type` may
     * gain members in a minor.
     */
    blockedOn: BlockedOn | null;
    /**
     * The name of its failure job.
     */
    failureJob: string | null;
    /**
     * Absent when not asked for, or when the database holds no payload for the job.
     */
    payload?: P;
};
export type JobFilter<J extends JobDefinition | string = JobDefinition | string> = {
    /**
     * A job name, or a definition.
     */
    jobName: J;
    /**
     * One status, or a non-empty list. Default: every
     * status.
     */
    status?: JobStatus | readonly JobStatus[] | undefined;
};
export type ListJobsOptions = {
    /**
     * The most jobs of a page: an integer from 1 to 1000. Default: 100.
     */
    limit?: number | undefined;
    /**
     * The `nextCursor` of the previous page. Null or absent: the first page.
     */
    cursor?: string | null | undefined;
    /**
     * Default: `false`.
     */
    includePayload?: boolean | undefined;
};
export type JobPage<P = any> = {
    /**
     * Newest first.
     */
    jobs: JobRecord<P>[];
    /**
     * The cursor of the next page. Null: the last page.
     */
    nextCursor: string | null;
};
export type JobSelector = {
    jobIds: readonly string[];
    jobName?: undefined;
    status?: undefined;
} | (JobFilter & {
    jobIds?: undefined;
});
export type BulkOptions<C = any> = {
    /**
     * Atomic only. A connection or a client in a transaction: the call runs in it,
     * and its owner commits. A pool: a READ COMMITTED transaction of sqlane's own on it. Default: one on the queue's
     * pool.
     */
    connection?: C | undefined;
    /**
     * `'atomic'` (default): one transaction. `'batches'`: a filter in
     * short transactions of up to 1000 jobs on the queue's pool; not atomic.
     */
    mode?: 'atomic' | 'batches' | undefined;
    /**
     * Atomic with `jobIds` only: any id that would be ignored rejects the call
     * with an `IgnoredJobsError`, and nothing changes. Default: `false`.
     */
    strict?: boolean | undefined;
    /**
     * The result lists the ids of the jobs it changed. Default:
     * `false`.
     */
    includeAffectedJobIds?: boolean | undefined;
};
export type RetryOptions<C = any> = BulkOptions<C> & {
    budget?: 'reset' | 'one_more' | undefined;
};
export type BulkIgnoredJob = {
    /**
     * The id, as given.
     */
    jobId: string;
    /**
     * `not_found`: no such job. `status`: a status that the
     * operation does not change. `no_payload`: a job without a payload, which a retry cannot run. More reasons may come
     * in a minor version.
     */
    reason: 'not_found' | 'status' | 'no_payload';
    /**
     * The status of the job, with `status` and `no_payload`.
     */
    status?: JobStatus;
};
export type BulkResult = {
    /**
     * The jobs that it changed.
     */
    affectedCount: number;
    /**
     * Their ids, in no order: with `includeAffectedJobIds`.
     */
    affectedJobIds?: string[];
    /**
     * With `jobIds`: one entry per distinct id that it did not change, in the
     * order of their first appearance. Empty for a filter.
     */
    ignoredJobs: BulkIgnoredJob[];
};
export type KeyStatsOptions = {
    /**
     * The most keys of the page: 1 to 1000. Default: 100.
     */
    limit?: number | undefined;
    /**
     * Only the keys of this type. Default: all types.
     */
    type?: 'concurrency' | 'rate' | undefined;
    /**
     * `blocked` (default): by the oldest blocked job. `held`: the
     * concurrency keys with held or lingering slots by their oldest slot, then the other concurrency keys, then the
     * rate keys, by their oldest blocked job. `held` rejects with `type: 'rate'`.
     */
    orderBy?: 'blocked' | 'held' | undefined;
};
export type KeyStats = {
    type: 'concurrency';
    key: string;
    max: number | null;
    held: number;
    lingering: number;
    blocked: number;
    blockedTruncated: boolean;
    oldestBlockedAgeMs: number | null;
    oldestHeldAgeMs: number | null;
} | {
    type: 'rate';
    limit: string;
    key: string | null;
    blocked: number;
    blockedTruncated: boolean;
    oldestBlockedAgeMs: number;
    nextStartInMs: number;
};
export type KeyStatsPage = {
    /**
     * Worst first, by `orderBy`; ties by the stored key in byte order.
     */
    keys: KeyStats[];
    /**
     * More keys matched than `limit`.
     */
    truncated: boolean;
};
export type FailedJobPayload = {
    /**
     * The job that
     * failed for good. Its `maxAttempts`: set at enqueue; a `one_more` retry changes it.
     */
    job: {
        id: string;
        name: string;
        payload: any;
        attempt: number;
        maxAttempts: number;
    };
    /**
     * The last error.
     */
    error: JobError;
};
export type Sqlane<C> = import('./sqlane.js').Sqlane<C>;
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
 * @property {Duration} delay The base wait.
 * @property {Duration} [maxDelay] The longest wait: at least `delay`.
 * @property {number} [jitter] 0–1: the delay is `delay × (1 − jitter × random())`. Default: 0.2.
 */
/**
 * @typedef {object} FixedBackoff
 * @property {'fixed'} type The wait is always `delay`.
 * @property {Duration} delay The wait.
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
 * @property {number} [maxAttempts] The runs of a job before it fails for good. Default: 3. Set at enqueue; a
 *     `one_more` retry changes it.
 * @property {number} [maxStalls] The stalls (a lost lease, a crashed process) that a job survives. Default: 2. Set at
 *     enqueue; a `one_more` retry changes it.
 * @property {Backoff} [backoff] The wait before the next attempt. Default:
 *     `{ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 }`.
 * @property {Retention} [retention] How long a finished job is kept. Default: `{ completed: '1h', failed: '30d' }`.
 * @property {Duration} [timeout] Aborts the handler's `signal` after it. No default. A job with global concurrency
 *     limits needs one.
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
 * @property {number} [maxAttempts] Overrides the definition's `maxAttempts` for this job. A `one_more` retry changes
 *     it.
 * @property {number} [maxStalls] Overrides the definition's `maxStalls` for this job. A `one_more` retry changes it.
 * @property {Retention} [retention] Overrides the definition's retention for this job, field by field.
 * @property {string | JobDefinition} [failureJob] Overrides the definition's failure job for this job.
 * @property {readonly (ConcurrencyLimit | ConcurrencyLimitKey)[]} [globalConcurrencyLimits] Replace the global limits
 *     of the definition; `[]` clears them.
 * @property {readonly (RateLimit | RateLimitKey)[]} [globalRateLimits] Replace the global rate limits of the
 *     definition; `[]` clears them.
 */
/**
 * @typedef {object} EnqueueJobIdOption
 * @property {string} [jobId] 1–120 printable ASCII characters, not starting with `schedule:`. Dedupe: a job with this
 *     id is added once while its row exists.
 * @property {never} [slot] Not with `jobId`.
 */
/**
 * @typedef {object} EnqueueSlotOption
 * @property {SlotOptions} slot Runs a slot of a schedule by hand: the job gets the `jobId` of the slot.
 * @property {never} [jobId] Not with `slot`.
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
 * @property {P} payload The payload of this job, as in `enqueue`.
 * @property {EnqueueOptions} [options] The options of this job, as in `enqueue`.
 */
/**
 * @typedef {object} JobInfo
 * @property {string} id The job id.
 * @property {string} name The job name.
 * @property {number} attempt 1 for the first run.
 * @property {number} maxAttempts The most attempts of this job: set at enqueue; a `one_more` retry changes it.
 * @property {Date} enqueuedAt The time of the enqueue.
 * @property {readonly { key: string, max: number }[]} globalConcurrencyLimits Its keys, sorted, with their maxes.
 * @property {Date | null} scheduledAt The slot of a job of a schedule (also when it runs late); else null.
 * @property {Date} runAt The job's due time, as stored: its place in line. A retry, a release, a stall,
 *     `drain({ includeDelayed })` and `jobs.retry()` set it; a block on a key, its unblock and a `RateLimitedError`
 *     on a global rate key keep it. So the start delay, `startedAt − runAt`, includes the time on a key and a
 *     rate-limited run. From the app's clock with the `runAt` option, until the first rerun.
 * @property {Date} startedAt The start of this run, by the database clock, as `JobRecord.startedAt` shows it.
 */
/**
 * @template [P=any]
 * @typedef {object} HandlerContext
 * @property {P} payload As JSON gives it back.
 * @property {JobInfo} job The job: its id, name, attempt, slot and keys.
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
 * @property {number} [maxAttempts] The runs of a job before it fails for good. Default: 3.
 * @property {number} [maxStalls] The stalls that a job survives. Default: 2.
 * @property {Backoff} [backoff] The wait before the next attempt. Default:
 *     `{ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 }`.
 * @property {Retention} [retention] How long a finished job is kept. Default: `{ completed: '1h', failed: '30d' }`.
 * @property {Duration} [timeout] Aborts the handler's `signal` after it. No default.
 */
/**
 * A pub/sub that wakes the other processes. Only an optimization: a lost message delays a job until the next poll.
 * @typedef {object} Hint
 * @property {(channel: string, message: string) => Promise<void>} publish Sends a message on a channel.
 * @property {(channel: string, onMessage: (message: string) => void) => Promise<() => Promise<void>>} subscribe
 *     Resolves to the unsubscribe function.
 */
/**
 * @typedef {(object: object, message?: string) => void} LogFn
 */
/**
 * A pino-compatible logger.
 * @typedef {object} Logger
 * @property {LogFn} debug Transient errors that sqlane retried at once.
 * @property {LogFn} info Recoveries, such as schedules that enqueue their slots again.
 * @property {LogFn} warn What sqlane works around: a clock skew, a server below the supported version.
 * @property {LogFn} error Failed operations, such as a failed job; also an `error` event.
 */
/**
 * @typedef {object} JobEventBase
 * @property {string} jobId The job id.
 * @property {string} jobName The job name.
 * @property {number} attempt The attempt, from 1. After a stall, the attempt of the run that stalled.
 */
/**
 * An event of the job lifecycle, by `type`.
 * @typedef {(JobEventBase & (
 *     | { type: 'claimed', runAt: Date, enqueuedAt: Date, startedAt: Date }
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
 *     | { type: 'cancelled' }
 * )) | ScheduleFiredEvent | { type: 'error', operation: string, error: unknown }} SqlaneEvent
 */
/**
 * A slot of a schedule was decided: once in the cluster, by the process that moved the cursor.
 * @typedef {object} ScheduleFiredEvent
 * @property {'schedule_fired'} type The event type.
 * @property {string} scheduleId `<job name>` or `<job name>:<key>`.
 * @property {string} jobName The job name.
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
 * @property {Dialect} dialect The database, as the app named it. The first `start()` or call of `schema.migrate()`,
 *     `schema.rollback()` or `schema.drop()` of an instance checks it against the server.
 * @property {boolean} [allowUnsupportedDbVersion] A server below the supported minimum (MySQL 8.4, MariaDB 10.11,
 *     PostgreSQL 15) logs a warning instead of a `ConfigError`.
 * @property {boolean} [allowUnsupportedDbConfiguration] MySQL and MariaDB: a `sql_mode` that lacks a required flag,
 *     or has `ALLOW_INVALID_DATES`, logs a warning instead of a `ConfigError`. `NO_BACKSLASH_ESCAPES` is always one.
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
 * @property {<T>(connection: C, func: (executor: Executor) => Promise<T>) => Promise<T> | null} [poolTransaction]
 *     Used by sqlane, by the bulk methods of `sqlane.jobs`: a pool (or an ORM instance outside a transaction) → func
 *     in a READ COMMITTED transaction of sqlane's own on it, decided synchronously; a connection or a client in a
 *     transaction → `null`. Without it, a pool given as `connection` runs as a caller's connection, through
 *     `inTransaction`.
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
 * @property {(sql: string, params: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>} query Runs a
 *     SELECT: its rows.
 * @property {(sql: string, params: readonly unknown[]) => Promise<number>} run Runs an INSERT, UPDATE or DELETE:
 *     the number of rows it changed.
 */
/**
 * @template C
 * @typedef {object} SqlaneOptions
 * @property {Adapter<C>} adapter The adapter of your driver or ORM, over the queue's own small pool, e.g.
 *     `pgAdapter(queuePool, { dialect: 'postgres' })`.
 * @property {readonly JobDefinition[]} [jobs] The definitions known by name.
 * @property {number} [localMaxConcurrency] The handlers that run at the same time in this instance. Default: 10.
 * @property {JobDefaults} [defaults] Defaults of `maxAttempts`, `maxStalls`, `backoff`, `retention` and `timeout`. A
 *     definition overrides them.
 * @property {'allow' | 'reject'} [unknownJobs] Default: `'allow'`. `'reject'`: `enqueue` of a name that is not in
 *     `jobs` and not handled throws an `UnknownJobError`.
 * @property {Hint | null} [hint] Default: null: polling only.
 * @property {Logger} [logger] Default: no logs.
 * @property {(event: SqlaneEvent) => void} [onEvent] Gets the events of the job lifecycle. A throw is logged.
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
 * @property {number} completed Jobs that completed.
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
 * @property {string} [targetVersion] `'X.Y.Z'`: only the migrations tagged at or below it. From `'6.0.0'` up to the
 *     installed version. Default: every migration.
 * @property {Duration} [lockTimeout] Default: `'10m'`.
 */
/**
 * @typedef {object} RollbackOptions
 * @property {string} targetVersion `'X.Y.Z'`: the migrations tagged above it are reverted. From `'6.0.0'` up to the
 *     installed version.
 * @property {Duration} [lockTimeout] For the migration lock, and for each lock of a table. Default: `'10m'`.
 */
/**
 * What `schema.migrate()` would do, by the records of the migrations.
 * @typedef {object} MigrationStatus
 * @property {boolean} ok `missingRequired` is empty.
 * @property {string[]} missingRequired Not recorded, tagged up to the base of the installed major (`X.0.0`): the
 *     queries of this version need them.
 * @property {string[]} missingOptional Not recorded, tagged above `X.0.0`: only the features that they serve need
 *     them.
 * @property {string[]} unknownApplied Recorded, unknown to this version: a newer version migrated.
 */
/**
 * @typedef {'missing_table' | 'missing_column' | 'wrong_type' | 'wrong_nullability' | 'missing_index' | 'wrong_index'}
 *     SchemaIssue
 */
/**
 * @typedef {object} SchemaProblem
 * @property {string} table With its prefix.
 * @property {string} [column] The column of a column issue.
 * @property {string} [index] The index of an index issue, with its prefix (MySQL's primary key: `PRIMARY`).
 * @property {SchemaIssue} issue What is wrong.
 * @property {string} [expected] For a wrong type, nullability or index: what this version expects.
 * @property {string} [found] For a wrong type, nullability or index: what the catalog has.
 * @property {boolean} required False: from a migration tagged above the base of the installed major (`X.0.0`).
 */
/**
 * Whether the queries of this version find what they need, by the catalog.
 * @typedef {object} SchemaProblems
 * @property {boolean} ok No problem with `required: true`.
 * @property {SchemaProblem[]} problems Every problem, required or not.
 */
/**
 * @typedef {object} DropOptions
 * @property {Duration} [lockTimeout] For the migration lock, and for the locks of the tables. Default: `'10m'`.
 */
/**
 * @typedef {object} JobStats
 * @property {string} name The job name.
 * @property {number} pending The jobs that wait to run, also those not due yet and those blocked on a key.
 * @property {number} due The pending jobs that are due now.
 * @property {number} running The jobs that run now.
 * @property {number} stuck Timed out, the handler has not settled.
 * @property {number} failed The failed jobs that sqlane still keeps.
 * @property {number | null} oldestDueAgeMs How long the oldest due job has waited, in ms. Null: no job is due.
 */
/**
 * An error as sqlane stores it: the last error of a job, and the error of a failure job.
 * @typedef {object} JobError
 * @property {string} name The `name` of the error, as a string: not always an exported class (`StalledError`).
 * @property {string} message The `message` of the error, or the thrown value as a string.
 * @property {string} [stack] At most 8,192 UTF-16 code units (`String#length`).
 * @property {string} [code] The string `code` of the thrown error, if it had one.
 */
/**
 * The state of a job. New members come only in a major. A cancelled job is `failed`.
 * @typedef {'pending' | 'blocked' | 'running' | 'completed' | 'failed'} JobStatus
 */
/**
 * What a blocked job waits for: a concurrency key (the full key), or a rate limit and its key value. `type` may gain
 * members in a minor: a `switch` needs a `default`.
 * @typedef {{ type: 'concurrency', key: string } | { type: 'rate', limit: string, key: string | null }} BlockedOn
 */
/**
 * A job as the database has it, from `sqlane.jobs`.
 * @template [P=any]
 * @typedef {object} JobRecord
 * @property {string} id The full job id.
 * @property {string} name The job name.
 * @property {JobStatus} status The state when read. `pending` does not include `blocked`.
 * @property {number} attempts The finished attempts: a completion, a retry or a failure each add one. A `reset` retry
 *     sets it to 0.
 * @property {number} maxAttempts Set at enqueue; a `one_more` retry changes it.
 * @property {number} stalls The times its lease ended while it ran. A `reset` retry sets it to 0.
 * @property {number} maxStalls The stalls it survives: set at enqueue; a `one_more` retry changes it.
 * @property {Date} runAt When the job is due, or was: its place in line; a running or finished job, the due time of
 *     its last run. A blocked job keeps it; after a `RateLimitedError` on a global rate key, the due time of the run
 *     that was rate limited. `jobs.retry` sets it as a rerun does (truncated to the millisecond on PostgreSQL); a
 *     cancelled job that never ran keeps its due time.
 * @property {Date} enqueuedAt The time of the insert, not of the commit.
 * @property {Date | null} startedAt The start of its last run. Null: it never ran.
 * @property {Date | null} finishedAt When it completed or failed for good.
 * @property {Date | null} expiresAt From when cleanup may delete the finished job.
 * @property {Date | null} scheduledAt The slot of a job of a schedule.
 * @property {boolean} stuck Running and timed out, by the last state written.
 * @property {JobError | null} lastError The last error written to the job: of a failed attempt, a stall, a
 *     `RateLimitedError` on a global rate key of the job, or `jobs.cancel` (`JobCancelledError`). Kept when the job
 *     later completes.
 * @property {readonly { key: string, max: number }[]} globalConcurrencyLimits Its full keys, sorted, with their maxes.
 * @property {readonly { limit: string, key: string | null, max: number, per: number, burst: number, cost: number }[]}
 *     globalRateLimits Its rate limits: the limit name and the key value (null: the limit itself), `per` in ms; sorted
 *     by the full rate key.
 * @property {BlockedOn | null} blockedOn What a blocked job waits for. Null when it is not blocked. Its `type` may
 *     gain members in a minor.
 * @property {string | null} failureJob The name of its failure job.
 * @property {P} [payload] Absent when not asked for, or when the database holds no payload for the job.
 */
/**
 * Which jobs `sqlane.jobs.list()` reads.
 * @template {JobDefinition | string} [J=JobDefinition | string]
 * @typedef {object} JobFilter
 * @property {J} jobName A job name, or a definition.
 * @property {JobStatus | readonly JobStatus[] | undefined} [status] One status, or a non-empty list. Default: every
 *     status.
 */
/**
 * @typedef {object} ListJobsOptions
 * @property {number | undefined} [limit] The most jobs of a page: an integer from 1 to 1000. Default: 100.
 * @property {string | null | undefined} [cursor] The `nextCursor` of the previous page. Null or absent: the first page.
 * @property {boolean | undefined} [includePayload] Default: `false`.
 */
/**
 * A page of `sqlane.jobs.list()`.
 * @template [P=any]
 * @typedef {object} JobPage
 * @property {JobRecord<P>[]} jobs Newest first.
 * @property {string | null} nextCursor The cursor of the next page. Null: the last page.
 */
/**
 * The jobs that a bulk method of `sqlane.jobs` changes: up to 1000 full job ids, or a filter as `jobs.list` takes it.
 * Not both.
 * @typedef {{ jobIds: readonly string[], jobName?: undefined, status?: undefined }
 *     | (JobFilter & { jobIds?: undefined })} JobSelector
 */
/**
 * The options of `jobs.cancel()` and `jobs.remove()`, and of `jobs.retry()` with `budget`.
 * @template [C=any]
 * @typedef {object} BulkOptions
 * @property {C | undefined} [connection] Atomic only. A connection or a client in a transaction: the call runs in it,
 *     and its owner commits. A pool: a READ COMMITTED transaction of sqlane's own on it. Default: one on the queue's
 *     pool.
 * @property {'atomic' | 'batches' | undefined} [mode] `'atomic'` (default): one transaction. `'batches'`: a filter in
 *     short transactions of up to 1000 jobs on the queue's pool; not atomic.
 * @property {boolean | undefined} [strict] Atomic with `jobIds` only: any id that would be ignored rejects the call
 *     with an `IgnoredJobsError`, and nothing changes. Default: `false`.
 * @property {boolean | undefined} [includeAffectedJobIds] The result lists the ids of the jobs it changed. Default:
 *     `false`.
 */
/**
 * The options of `jobs.retry()`.
 * @template [C=any]
 * @typedef {BulkOptions<C> & { budget?: 'reset' | 'one_more' | undefined }} RetryOptions `budget`: `'reset'`
 *     (default): attempts and stalls back to 0. `'one_more'`: one more attempt; the maxes of the job change for good.
 */
/**
 * An id of a bulk call that it did not change.
 * @typedef {object} BulkIgnoredJob
 * @property {string} jobId The id, as given.
 * @property {'not_found' | 'status' | 'no_payload'} reason `not_found`: no such job. `status`: a status that the
 *     operation does not change. `no_payload`: a job without a payload, which a retry cannot run. More reasons may come
 *     in a minor version.
 * @property {JobStatus} [status] The status of the job, with `status` and `no_payload`.
 */
/**
 * The result of a bulk method of `sqlane.jobs`.
 * @typedef {object} BulkResult
 * @property {number} affectedCount The jobs that it changed.
 * @property {string[]} [affectedJobIds] Their ids, in no order: with `includeAffectedJobIds`.
 * @property {BulkIgnoredJob[]} ignoredJobs With `jobIds`: one entry per distinct id that it did not change, in the
 *     order of their first appearance. Empty for a filter.
 */
/**
 * The options of `sqlane.jobs.keyStats()`.
 * @typedef {object} KeyStatsOptions
 * @property {number | undefined} [limit] The most keys of the page: 1 to 1000. Default: 100.
 * @property {'concurrency' | 'rate' | undefined} [type] Only the keys of this type. Default: all types.
 * @property {'blocked' | 'held' | undefined} [orderBy] `blocked` (default): by the oldest blocked job. `held`: the
 *     concurrency keys with held or lingering slots by their oldest slot, then the other concurrency keys, then the
 *     rate keys, by their oldest blocked job. `held` rejects with `type: 'rate'`.
 */
/**
 * A key of `sqlane.jobs.keyStats()`, by `type`. `type` may gain members in a minor: a `switch` needs a `default`.
 * @typedef {{
 *     type: 'concurrency',
 *     key: string,
 *     max: number | null,
 *     held: number,
 *     lingering: number,
 *     blocked: number,
 *     blockedTruncated: boolean,
 *     oldestBlockedAgeMs: number | null,
 *     oldestHeldAgeMs: number | null,
 * } | {
 *     type: 'rate',
 *     limit: string,
 *     key: string | null,
 *     blocked: number,
 *     blockedTruncated: boolean,
 *     oldestBlockedAgeMs: number,
 *     nextStartInMs: number,
 * }} KeyStats A concurrency key: the full key; the max of its oldest blocked job, else of the job of its newest slot
 *     (null: neither, or that job no longer carries the key); its slots held by runs (orphans too, until the sweep) and
 *     its lingering slots; its blocked jobs, up to 1000 (`blockedTruncated`: more); the age of its oldest blocked job
 *     (`now − runAt`) and of its oldest held or lingering slot (from when it was taken: a run's `startedAt`). A rate
 *     key: its limit and key (null for the limit itself), its blocked jobs, the age of the oldest, and the ms until it
 *     may start, by its own settings (0: now).
 */
/**
 * A page of `sqlane.jobs.keyStats()`.
 * @typedef {object} KeyStatsPage
 * @property {KeyStats[]} keys Worst first, by `orderBy`; ties by the stored key in byte order.
 * @property {boolean} truncated More keys matched than `limit`.
 */
/**
 * The payload of a failure job.
 * @typedef {object} FailedJobPayload
 * @property {{ id: string, name: string, payload: any, attempt: number, maxAttempts: number }} job The job that
 *     failed for good. Its `maxAttempts`: set at enqueue; a `one_more` retry changes it.
 * @property {JobError} error The last error.
 */
/**
 * A sqlane instance, made by `createSqlane()`. Its methods and their docs are in sqlane.ts.
 * @template C The connections that `enqueue` accepts.
 * @typedef {import('./sqlane.js').Sqlane<C>} Sqlane
 */
export {};
