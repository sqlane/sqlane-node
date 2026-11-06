/**
 * The base of the errors of sqlane.
 */
export class SqlaneError extends Error {
    /**
     * @param {string} code A stable code, e.g. `CONFIG`.
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(code, message, options) {
        super(message, options);
        this.name = 'SqlaneError';
        /** @readonly */
        this.code = code;
    }
}

/** Bad `createSqlane`, `defineJob` or `handle()` options. */
export class ConfigError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('CONFIG', message, options);
        this.name = 'ConfigError';
    }
}

/** Bad enqueue options: a bad name or `jobId`, `delay` with `runAt`. */
export class InvalidOptionsError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('INVALID_OPTIONS', message, options);
        this.name = 'InvalidOptionsError';
    }
}

/** The payload is above `maxPayloadBytes`. */
export class PayloadTooLargeError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('PAYLOAD_TOO_LARGE', message, options);
        this.name = 'PayloadTooLargeError';
    }
}

/** More than 10 mutex keys, or a key that breaks the rules. */
export class InvalidMutexKeyError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('INVALID_MUTEX_KEY', message, options);
        this.name = 'InvalidMutexKeyError';
    }
}

/** Enqueue of an unknown name with `unknownJobs: 'reject'`. */
export class UnknownJobError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('UNKNOWN_JOB', message, options);
        this.name = 'UnknownJobError';
    }
}

/** `start`, `handle` or `drain` after `close()`. */
export class ClosedError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('CLOSED', message, options);
        this.name = 'ClosedError';
    }
}

/** `drain()` did not finish in its `timeout`. */
export class DrainTimeoutError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('DRAIN_TIMEOUT', message, options);
        this.name = 'DrainTimeoutError';
    }
}

/** The `signal.reason` on a timeout; the error of the attempt. */
export class JobTimeoutError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('JOB_TIMEOUT', message, options);
        this.name = 'JobTimeoutError';
    }
}

/** The `signal.reason` at the close deadline. */
export class ShutdownError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('SHUTDOWN', message, options);
        this.name = 'ShutdownError';
    }
}

/** The `signal.reason` when the lease could not be renewed in time. */
export class LeaseLostError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('LEASE_LOST', message, options);
        this.name = 'LeaseLostError';
    }
}

/** The error of a job without its payload. */
export class MissingPayloadError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('MISSING_PAYLOAD', message, options);
        this.name = 'MissingPayloadError';
    }
}

/** Thrown by a handler: the job fails at once, without retries; its failure job runs. */
export class FatalJobError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('FATAL_JOB', message, options);
        this.name = 'FatalJobError';
    }
}

/** Thrown by a handler: the job is retried after `delay` instead of the backoff. It still uses an attempt. */
export class RetryJobError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions & { delay: import('./types.js').Duration }} options
     */
    constructor(message, options) {
        const { delay, ...errorOptions } = options;

        super('RETRY_JOB', message, errorOptions);
        this.name = 'RetryJobError';
        /** @readonly */
        this.delay = delay;
    }
}

/** `migrate()` did not get the migration lock in its `lockTimeout`. */
export class MigrationLockTimeoutError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('MIGRATION_LOCK_TIMEOUT', message, options);
        this.name = 'MigrationLockTimeoutError';
    }
}
