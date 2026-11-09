export type Duration = string | number;
export type Jsonable<T> = T extends string | number | boolean | null ? T : T extends undefined | bigint | symbol | Function | Date | RegExp | Map<any, any> | Set<any> ? never : T extends readonly (infer U)[] ? readonly Jsonable<U>[] : T extends object ? {
    [K in keyof T]: Jsonable<T[K]>;
} : never;
export type ExponentialBackoff = {
    /**
     * `delay × 2^(attempt − 1)`, at most `maxDelay`.
     */
    type: 'exponential';
    delay: Duration;
    maxDelay?: Duration;
    /**
     * 0–1: the delay is `delay × (1 − jitter × random())`. Default: 0.2.
     */
    jitter?: number;
};
export type FixedBackoff = {
    type: 'fixed';
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
     * Default: 3.
     */
    maxAttempts?: number;
    /**
     * Default: 2.
     */
    maxStalls?: number;
    backoff?: Backoff;
    retention?: Retention;
    /**
     * No default. A job with mutex keys needs one.
     */
    timeout?: Duration;
    /**
     * Sync, from the payload only.
     */
    mutexKeys?: (payload: P) => readonly string[];
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
export type EnqueueBaseOptions = {
    /**
     * 1–120 printable ASCII characters. Dedupe: a job with this id is added once while its row
     * exists.
     */
    jobId?: string;
    maxAttempts?: number;
    maxStalls?: number;
    retention?: Retention;
    failureJob?: string | JobDefinition;
    /**
     * Replace the keys of the definition; `[]` clears them.
     */
    mutexKeys?: readonly string[];
};
export type EnqueueOptions = EnqueueBaseOptions & ({
    delay?: Duration;
    runAt?: never;
} | {
    runAt: Date;
    delay?: never;
});
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
    payload: P;
    options?: EnqueueOptions;
};
export type JobInfo = {
    id: string;
    name: string;
    /**
     * 1 for the first run.
     */
    attempt: number;
    maxAttempts: number;
    enqueuedAt: Date;
    mutexKeys: readonly string[];
};
export type HandlerContext<P = any> = {
    /**
     * As JSON gives it back.
     */
    payload: P;
    job: JobInfo;
    /**
     * Aborted with a `JobTimeoutError`, a `LeaseLostError` or a `ShutdownError`.
     */
    signal: AbortSignal;
};
export type Handler<P = any> = (context: HandlerContext<P>) => unknown;
export type HandleOptions<L extends string> = {
    timeout?: Duration;
} & ({
    concurrency?: number;
    lane?: never;
} | {
    lane: L;
    concurrency?: never;
});
export type LaneOptions = {
    /**
     * The handlers of the lane that run at the same time in one process.
     */
    concurrency: number;
};
export type JobDefaults = {
    maxAttempts?: number;
    maxStalls?: number;
    backoff?: Backoff;
    retention?: Retention;
    timeout?: Duration;
};
export type Hint = {
    publish: (channel: string, message: string) => Promise<void>;
    /**
     *     Resolves to the unsubscribe function.
     */
    subscribe: (channel: string, onMessage: (message: string) => void) => Promise<() => Promise<void>>;
};
export type LogFn = (object: object, message?: string) => void;
export type Logger = {
    debug: LogFn;
    info: LogFn;
    warn: LogFn;
    error: LogFn;
};
export type JobEventBase = {
    jobId: string;
    jobName: string;
    attempt: number;
};
export type SqlaneEvent = (JobEventBase & ({
    type: 'claimed';
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
})) | {
    type: 'error';
    operation: string;
    error: unknown;
};
export type Adapter<C> = {
    dialect: 'mysql' | 'postgres';
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
    query: (sql: string, params: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>;
    /**
     * Runs an INSERT, UPDATE or DELETE:
     * the number of rows it changed.
     */
    run: (sql: string, params: readonly unknown[]) => Promise<number>;
};
export type SqlaneOptions<C, L extends string> = {
    adapter: Adapter<C>;
    /**
     * The definitions known by name.
     */
    jobs?: readonly JobDefinition[];
    /**
     * The handlers that run at the same time in this process. Default: 10.
     */
    concurrency?: number;
    /**
     * Limits shared by several job names.
     */
    lanes?: Record<L, LaneOptions>;
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
     * Default: `'10m'`.
     */
    lockTimeout?: Duration;
};
export type JobStats = {
    name: string;
    pending: number;
    due: number;
    running: number;
    /**
     * Timed out, the handler has not settled.
     */
    stuck: number;
    failed: number;
    oldestDueAgeMs: number | null;
};
export type FailedJobPayload = {
    job: {
        id: string;
        name: string;
        payload: any;
        attempt: number;
        maxAttempts: number;
    };
    error: {
        name: string;
        message: string;
        stack?: string;
    };
};
export type Sqlane<C, L extends string> = {
    /**
     * Adds a job with the caller's connection: it must be in a transaction (or a
     * pool: then sqlane opens its own transaction).
     */
    enqueue: <J extends JobDefinition | string, P>(connection: C, job: J, payload: EnqueuePayload<J, P>, options?: EnqueueOptions) => Promise<EnqueueResult>;
    /**
     * The results are in the order of the items.
     */
    enqueueMany: <J extends JobDefinition | string, P>(connection: C, job: J, items: readonly EnqueueManyItem<J, P>[]) => Promise<EnqueueResult[]>;
    handle: <J extends JobDefinition | string>(job: J, handler: Handler<HandlerPayload<J>>, options?: HandleOptions<L>) => void;
    start: () => Promise<void>;
    /**
     * For tests: runs the due jobs of the handled
     * names until none is left, without `start()`.
     */
    drain: (options?: DrainOptions) => Promise<DrainResult>;
    close: (options?: CloseOptions) => Promise<void>;
    /**
     * Applies the missing migrations:
     * their ids.
     */
    migrate: (options?: MigrateOptions) => Promise<{
        applied: string[];
    }>;
    getStats: () => Promise<JobStats[]>;
    /**
     * Low level: probes this name now.
     */
    wake: (jobName: string) => void;
};
export type Migration = {
    id: string;
    statements: readonly string[];
};
/**
 * A duration: milliseconds, or a string of parse-duration (`'500ms'`, `'5s'`, `'4m30s'`, `'1h'`, `'2 days'`).
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
 * @template [P=any] The payload: `defineJob<{ reportId: string }>(…)` types `enqueue`, `handle` and `mutexKeys`.
 * @typedef {object} JobOptions
 * @property {string} name Matches `^[a-z][a-z0-9_.-]{0,127}$`.
 * @property {number} [maxAttempts] Default: 3.
 * @property {number} [maxStalls] Default: 2.
 * @property {Backoff} [backoff]
 * @property {Retention} [retention]
 * @property {Duration} [timeout] No default. A job with mutex keys needs one.
 * @property {(payload: P) => readonly string[]} [mutexKeys] Sync, from the payload only.
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
 * @typedef {object} EnqueueBaseOptions
 * @property {string} [jobId] 1–120 printable ASCII characters. Dedupe: a job with this id is added once while its row
 *     exists.
 * @property {number} [maxAttempts]
 * @property {number} [maxStalls]
 * @property {Retention} [retention]
 * @property {string | JobDefinition} [failureJob]
 * @property {readonly string[]} [mutexKeys] Replace the keys of the definition; `[]` clears them.
 */
/**
 * The options of an enqueue: `delay` or `runAt`, not both.
 * @typedef {EnqueueBaseOptions & ({ delay?: Duration, runAt?: never } | { runAt: Date, delay?: never })}
 *     EnqueueOptions
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
 * @property {readonly string[]} mutexKeys
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
 * A private lane (`concurrency`) or a shared lane of `lanes` (`lane`), not both.
 * @template {string} L
 * @typedef {{ timeout?: Duration } & (
 *     { concurrency?: number, lane?: never } | { lane: L, concurrency?: never }
 * )} HandleOptions
 */
/**
 * @typedef {object} LaneOptions
 * @property {number} concurrency The handlers of the lane that run at the same time in one process.
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
 *     | { type: 'timed_out', durationMs: number }
 *     | { type: 'stalled' }
 *     | { type: 'released' }
 *     | { type: 'lease_lost' }
 *     | { type: 'failure_job_not_added', failureJob: string, error: unknown }
 * )) | { type: 'error', operation: string, error: unknown }} SqlaneEvent
 */
/**
 * The connections that `enqueue` accepts (C), and the queue's own pool. Made by `mysql2Adapter()` or `pgAdapter()`.
 * @template C
 * @typedef {object} Adapter
 * @property {'mysql' | 'postgres'} dialect
 * @property {(connection: C) => Executor} wrap Used by sqlane: wraps a connection given to `enqueue`.
 * @property {Executor} queue Used by sqlane: the queue's own pool.
 * @property {<T>(func: (executor: Executor) => Promise<T>) => Promise<T>} withConnection Used by sqlane: runs func on
 *     one connection of the queue's pool, then releases it.
 * @property {<T>(func: (executor: Executor) => Promise<T>) => Promise<T>} queueTransaction Used by sqlane: runs func
 *     in a `READ COMMITTED` transaction on a connection of the queue's pool.
 * @property {<T>(connection: C, func: (executor: Executor) => Promise<T>) => Promise<T>} inTransaction Used by sqlane:
 *     a pool → func in a transaction of its own; a connection or a client → func on it, in the caller's transaction.
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
 * @template {string} L
 * @typedef {object} SqlaneOptions
 * @property {Adapter<C>} adapter
 * @property {readonly JobDefinition[]} [jobs] The definitions known by name.
 * @property {number} [concurrency] The handlers that run at the same time in this process. Default: 10.
 * @property {Record<L, LaneOptions>} [lanes] Limits shared by several job names.
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
 * @property {{ name: string, message: string, stack?: string }} error
 */
/**
 * @template C The connections that `enqueue` accepts.
 * @template {string} L The lane names.
 * @typedef {object} Sqlane
 * @property {<J extends JobDefinition | string, P>(
 *     connection: C, job: J, payload: EnqueuePayload<J, P>, options?: EnqueueOptions,
 * ) => Promise<EnqueueResult>} enqueue Adds a job with the caller's connection: it must be in a transaction (or a
 *     pool: then sqlane opens its own transaction).
 * @property {<J extends JobDefinition | string, P>(
 *     connection: C, job: J, items: readonly EnqueueManyItem<J, P>[],
 * ) => Promise<EnqueueResult[]>} enqueueMany The results are in the order of the items.
 * @property {<J extends JobDefinition | string>(
 *     job: J, handler: Handler<HandlerPayload<J>>, options?: HandleOptions<L>,
 * ) => void} handle
 * @property {() => Promise<void>} start
 * @property {(options?: DrainOptions) => Promise<DrainResult>} drain For tests: runs the due jobs of the handled
 *     names until none is left, without `start()`.
 * @property {(options?: CloseOptions) => Promise<void>} close
 * @property {(options?: MigrateOptions) => Promise<{ applied: string[] }>} migrate Applies the missing migrations:
 *     their ids.
 * @property {() => Promise<JobStats[]>} getStats
 * @property {(jobName: string) => void} wake Low level: probes this name now.
 */
/**
 * @typedef {object} Migration
 * @property {string} id
 * @property {readonly string[]} statements
 */
export {};
