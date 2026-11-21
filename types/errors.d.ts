/**
 * The base of the errors of sqlane.
 */
export declare class SqlaneError extends Error {
    /** @readonly */
    code: string;
    /**
     * @param {string} code A stable code, e.g. `CONFIG`.
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(code: string, message: string, options?: ErrorOptions);
}
/** Bad `createSqlane`, `defineJob` or `handle()` options. */
export declare class ConfigError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/** Bad enqueue options: a bad name or `jobId`, `delay` with `runAt`. */
export declare class InvalidOptionsError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/** The payload is above `maxPayloadBytes`. */
export declare class PayloadTooLargeError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/** More than 10 global concurrency limits, a key that breaks the rules, or one key with two maxes. */
export declare class InvalidConcurrencyLimitError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/**
 * More than 10 global keys with the concurrency limits, a key or a cost that breaks the rules, one key with two
 * settings, or bad options of a `RateLimitedError`.
 */
export declare class InvalidRateLimitError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/** Enqueue of an unknown name with `unknownJobs: 'reject'`. */
export declare class UnknownJobError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/** `start`, `handle` or `drain` after `close()`. */
export declare class ClosedError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/** `drain()` did not finish in its `timeout`. */
export declare class DrainTimeoutError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/** The `signal.reason` on a timeout; the error of the attempt. */
export declare class JobTimeoutError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/** The `signal.reason` at the close deadline. */
export declare class ShutdownError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/** The `signal.reason` when the lease could not be renewed in time. */
export declare class LeaseLostError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/** The error of a job without its payload. */
export declare class MissingPayloadError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/**
 * The error of a job that `sqlane.jobs.cancel()` cancelled: its `lastError`. A handler that throws it throws an
 * ordinary error.
 */
export declare class JobCancelledError extends SqlaneError {
    /**
     * @param {string} [message] Default: `'Cancelled'`.
     * @param {ErrorOptions} [options]
     */
    constructor(message?: string, options?: ErrorOptions);
}
/**
 * A bulk method of `sqlane.jobs` with `strict: true` would have ignored some of its ids: it changed nothing.
 * `ignoredJobs` lists them, as the result would have.
 */
export declare class IgnoredJobsError extends SqlaneError {
    /** @readonly */
    ignoredJobs: readonly import("./types.js").BulkIgnoredJob[];
    /**
     * @param {string} message
     * @param {ErrorOptions & { ignoredJobs: readonly import('./types.js').BulkIgnoredJob[] }} options
     */
    constructor(message: string, options: ErrorOptions & {
        ignoredJobs: readonly import('./types.js').BulkIgnoredJob[];
    });
}
/** Thrown by a handler: the job fails at once, without retries; its failure job runs. */
export declare class FatalJobError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
/** Thrown by a handler: the job is retried after `delay` instead of the backoff. It still uses an attempt. */
export declare class RetryJobError extends SqlaneError {
    /** @readonly */
    delay: import("./types.js").Duration;
    /**
     * @param {string} message
     * @param {ErrorOptions & { delay: import('./types.js').Duration }} options
     */
    constructor(message: string, options: ErrorOptions & {
        delay: import('./types.js').Duration;
    });
}
/**
 * Thrown by a handler when the other side limits the rate (an HTTP 429): the job waits for the limit, without using an
 * attempt. `limit`: the rate limit, or the key of it, to push back to at least `retryAfter` from now; without it, all
 * the global rate keys of the job. A job without rate keys is retried after `retryAfter`, as by a `RetryJobError`.
 */
export declare class RateLimitedError extends SqlaneError {
    /**
     * @readonly
     * @type {import('./types.js').RateLimit | import('./types.js').RateLimitKey | undefined}
     */
    limit: import('./types.js').RateLimit | import('./types.js').RateLimitKey | undefined;
    /**
     * @readonly
     * @type {import('./types.js').Duration}
     */
    retryAfter: import('./types.js').Duration;
    /**
     * @param {{
     *     limit?: import('./types.js').RateLimit | import('./types.js').RateLimitKey,
     *     retryAfter: import('./types.js').Duration,
     *     cause?: unknown,
     * }} options
     */
    constructor(options: {
        limit?: import('./types.js').RateLimit | import('./types.js').RateLimitKey;
        retryAfter: import('./types.js').Duration;
        cause?: unknown;
    });
}
/** `migrate()` did not get the migration lock in its `lockTimeout`. */
export declare class MigrationLockTimeoutError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
