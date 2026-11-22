// The public API of sqlane. See docs/design.md.

export { createSqlane } from './create_sqlane.js';
export { defineConcurrencyLimit } from './define_concurrency_limit.js';
export { defineJob } from './define_job.js';
export { defineRateLimit } from './define_rate_limit.js';
export {
    ClosedError,
    ConfigError,
    DrainTimeoutError,
    FatalJobError,
    IgnoredJobsError,
    InvalidConcurrencyLimitError,
    InvalidOptionsError,
    InvalidRateLimitError,
    JobCancelledError,
    JobTimeoutError,
    LeaseLostError,
    MigrationLockTimeoutError,
    MissingPayloadError,
    PayloadTooLargeError,
    RateLimitedError,
    RetryJobError,
    ShutdownError,
    SqlaneError,
    UnknownJobError,
} from './errors.js';

/**
 * @typedef {import('./types.js').Adapter<C>} Adapter
 * @template C
 */
/**
 * @typedef {import('./types.js').Sqlane<C>} Sqlane
 * @template C
 */
/**
 * @typedef {import('./sqlane.js').SqlaneJobs<C>} SqlaneJobs
 * @template [C=any]
 */
/** @typedef {import('./sqlane.js').SqlaneSchema} SqlaneSchema */
/**
 * @typedef {import('./types.js').SqlaneOptions<C>} SqlaneOptions
 * @template C
 */
/**
 * @typedef {import('./types.js').Jsonable<T>} Jsonable
 * @template T
 */
/** @typedef {import('./types.js').Backoff} Backoff */
/**
 * @typedef {import('./types.js').BulkOptions<C>} BulkOptions
 * @template [C=any]
 */
/** @typedef {import('./types.js').BulkResult} BulkResult */
/** @typedef {import('./types.js').CloseOptions} CloseOptions */
/** @typedef {import('./types.js').ConcurrencyLimit} ConcurrencyLimit */
/** @typedef {import('./types.js').ConcurrencyLimitOptions} ConcurrencyLimitOptions */
/** @typedef {import('./types.js').ConcurrencyLimitKey} ConcurrencyLimitKey */
/** @typedef {import('./types.js').Dialect} Dialect */
/** @typedef {import('./types.js').DrainOptions} DrainOptions */
/** @typedef {import('./types.js').DrainResult} DrainResult */
/** @typedef {import('./types.js').Duration} Duration */
/** @typedef {import('./types.js').EnqueueOptions} EnqueueOptions */
/** @typedef {import('./types.js').EnqueueResult} EnqueueResult */
/** @typedef {import('./types.js').Executor} Executor */
/** @typedef {import('./types.js').FailedJobPayload} FailedJobPayload */
/**
 * @typedef {import('./types.js').Handler<P>} Handler
 * @template [P=any]
 */
/**
 * @typedef {import('./types.js').HandlerContext<P>} HandlerContext
 * @template [P=any]
 */
/**
 * @typedef {import('./types.js').HandlerPayload<J>} HandlerPayload
 * @template J
 */
/** @typedef {import('./types.js').Hint} Hint */
/** @typedef {import('./types.js').JobDefaults} JobDefaults */
/**
 * @typedef {import('./types.js').JobDefinition<P>} JobDefinition
 * @template [P=any]
 */
/** @typedef {import('./types.js').JobError} JobError */
/**
 * @typedef {import('./types.js').JobFilter<J>} JobFilter
 * @template {import('./types.js').JobDefinition | string} [J=import('./types.js').JobDefinition | string]
 */
/** @typedef {import('./types.js').JobInfo} JobInfo */
/**
 * @typedef {import('./types.js').JobPage<P>} JobPage
 * @template [P=any]
 */
/**
 * @typedef {import('./types.js').JobRecord<P>} JobRecord
 * @template [P=any]
 */
/**
 * @typedef {import('./types.js').JobOptions<P>} JobOptions
 * @template [P=any]
 */
/** @typedef {import('./types.js').JobSelector} JobSelector */
/** @typedef {import('./types.js').JobStats} JobStats */
/** @typedef {import('./types.js').JobStatus} JobStatus */
/** @typedef {import('./types.js').ListJobsOptions} ListJobsOptions */
/** @typedef {import('./types.js').KeyStats} KeyStats */
/** @typedef {import('./types.js').KeyStatsOptions} KeyStatsOptions */
/** @typedef {import('./types.js').KeyStatsPage} KeyStatsPage */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').MigrateOptions} MigrateOptions */
/** @typedef {import('./types.js').RollbackOptions} RollbackOptions */
/** @typedef {import('./types.js').DropOptions} DropOptions */
/** @typedef {import('./types.js').MigrationStatus} MigrationStatus */
/** @typedef {import('./types.js').SchemaProblem} SchemaProblem */
/** @typedef {import('./types.js').SchemaProblems} SchemaProblems */
/** @typedef {import('./types.js').RateLimit} RateLimit */
/** @typedef {import('./types.js').RateLimitKey} RateLimitKey */
/** @typedef {import('./types.js').RateLimitOptions} RateLimitOptions */
/** @typedef {import('./types.js').Retention} Retention */
/**
 * @typedef {import('./types.js').RetryOptions<C>} RetryOptions
 * @template [C=any]
 */
/** @typedef {import('./types.js').ScheduleFiredEvent} ScheduleFiredEvent */
/** @typedef {import('./types.js').ScheduleInfo} ScheduleInfo */
/**
 * @typedef {import('./types.js').ScheduleOptions<P>} ScheduleOptions
 * @template [P=any]
 */
/** @typedef {import('./types.js').SlotOptions} SlotOptions */
/** @typedef {import('./types.js').SqlaneEvent} SqlaneEvent */
