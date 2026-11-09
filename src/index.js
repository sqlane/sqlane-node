// The public API of sqlane. See docs/design.md.

export { createSqlane } from './create_sqlane.js';
export { defineJob } from './define_job.js';
export {
    ClosedError,
    ConfigError,
    DrainTimeoutError,
    FatalJobError,
    InvalidMutexKeyError,
    InvalidOptionsError,
    JobTimeoutError,
    LeaseLostError,
    MigrationLockTimeoutError,
    MissingPayloadError,
    PayloadTooLargeError,
    RetryJobError,
    ShutdownError,
    SqlaneError,
    UnknownJobError,
} from './errors.js';
export { getMigrations } from './migrations.js';

/**
 * @typedef {import('./types.js').Adapter<C>} Adapter
 * @template C
 */
/**
 * @typedef {import('./types.js').Sqlane<C, L>} Sqlane
 * @template C
 * @template {string} L
 */
/**
 * @typedef {import('./types.js').SqlaneOptions<C, L>} SqlaneOptions
 * @template C
 * @template {string} L
 */
/**
 * @typedef {import('./types.js').Jsonable<T>} Jsonable
 * @template T
 */
/** @typedef {import('./types.js').Backoff} Backoff */
/** @typedef {import('./types.js').CloseOptions} CloseOptions */
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
/** @typedef {import('./types.js').Hint} Hint */
/** @typedef {import('./types.js').JobDefaults} JobDefaults */
/**
 * @typedef {import('./types.js').JobDefinition<P>} JobDefinition
 * @template [P=any]
 */
/** @typedef {import('./types.js').JobInfo} JobInfo */
/**
 * @typedef {import('./types.js').JobOptions<P>} JobOptions
 * @template [P=any]
 */
/** @typedef {import('./types.js').JobStats} JobStats */
/** @typedef {import('./types.js').LaneOptions} LaneOptions */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').MigrateOptions} MigrateOptions */
/** @typedef {import('./types.js').Migration} Migration */
/** @typedef {import('./types.js').Retention} Retention */
/** @typedef {import('./types.js').SqlaneEvent} SqlaneEvent */
