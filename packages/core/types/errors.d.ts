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
/** More than 10 mutex keys, or a key that breaks the rules. */
export declare class InvalidMutexKeyError extends SqlaneError {
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
/** `migrate()` did not get the migration lock in its `lockTimeout`. */
export declare class MigrationLockTimeoutError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message: string, options?: ErrorOptions);
}
