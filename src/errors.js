import { parseDuration } from './duration.js';
import { isRateLimit, isRateLimitKey, MAX_PER_MS, rateKeyOf } from './rate_limit_shape.js';
import { checkObject } from './validate.js';

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

/** Bad options of `createSqlane`, `createRunner`, a definition or a mount. */
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

/** Bad enqueue options: a bad name or `dedupeKey`, `delay` with `runAt`. */
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

/** More than 10 global concurrency limits, a key that breaks the rules, or one key with two maxes. */
export class InvalidConcurrencyLimitError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('INVALID_CONCURRENCY_LIMIT', message, options);
        this.name = 'InvalidConcurrencyLimitError';
    }
}

/**
 * More than 10 global keys with the concurrency limits, a key or a cost that breaks the rules, one key with two
 * settings, or bad options of a `RateLimitedError`.
 */
export class InvalidRateLimitError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('INVALID_RATE_LIMIT', message, options);
        this.name = 'InvalidRateLimitError';
    }
}

/** A method of a runner after its `close()`, or `createRunner` or a schema change after `sqlane.close()`. */
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

/**
 * The error of a job that `sqlane.jobs.cancel()` cancelled: its `lastError`. A handler that throws it throws an
 * ordinary error.
 */
export class JobCancelledError extends SqlaneError {
    /**
     * @param {string} [message] Default: `'Cancelled'`.
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super('JOB_CANCELLED', message ?? 'Cancelled', options);
        this.name = 'JobCancelledError';
    }
}

/**
 * A bulk method of `sqlane.jobs` with `strict: true` would have ignored some of its ids: it changed nothing.
 * `ignoredJobs` lists them, as the result would have.
 */
export class IgnoredJobsError extends SqlaneError {
    /**
     * @param {string} message
     * @param {ErrorOptions & { ignoredJobs: readonly import('./types.js').BulkIgnoredJob[] }} options
     */
    constructor(message, options) {
        const { ignoredJobs, ...errorOptions } = options;

        super('IGNORED_JOBS', message, errorOptions);
        this.name = 'IgnoredJobsError';
        /** @readonly */
        this.ignoredJobs = ignoredJobs;
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

/**
 * Thrown by a handler when the other side limits the rate (an HTTP 429): the job waits for the limit, without using an
 * attempt. `limit`: the rate limit, or the key of it, to push back to at least `retryAfter` from now; without it, all
 * the global rate keys of the job. A job without rate keys is retried after `retryAfter`, as by a `RetryJobError`.
 */
export class RateLimitedError extends SqlaneError {
    /**
     * @param {{
     *     limit?: import('./types.js').RateLimit | import('./types.js').RateLimitKey,
     *     retryAfter: import('./types.js').Duration,
     *     cause?: unknown,
     * }} options
     */
    constructor(options) {
        const where = 'new RateLimitedError()';
        const { limit, retryAfter, ...rest } = checkObject(options, ['limit', 'retryAfter', 'cause'], 'options', {
            where,
            ErrorClass: InvalidRateLimitError,
        });

        if (limit !== undefined && !isRateLimit(limit) && !isRateLimitKey(limit)) {
            throw new InvalidRateLimitError(
                `${where}: "limit" must be a limit from defineRateLimit(), its key() or its cost()`,
            );
        }

        const retryAfterMs = parseDuration(retryAfter);

        if (retryAfterMs === null || retryAfterMs > MAX_PER_MS) {
            throw new InvalidRateLimitError(`${where}: "retryAfter" must be a duration from 0 to 7 d ('30s', or `
                + `milliseconds), got ${JSON.stringify(retryAfter)}`);
        }

        const on = limit === undefined ? '' : ` on ${rateKeyOf(limit).slice(1)}`;

        super('RATE_LIMITED', `Rate limited${on}: retry after ${retryAfterMs} ms`, 'cause' in rest ? rest : undefined);
        this.name = 'RateLimitedError';
        /**
         * @readonly
         * @type {import('./types.js').RateLimit | import('./types.js').RateLimitKey | undefined}
         */
        this.limit = limit;
        /**
         * @readonly
         * @type {import('./types.js').Duration}
         */
        this.retryAfter = /** @type {import('./types.js').Duration} */ (retryAfter);
    }
}

/**
 * `schema.migrate()`, `schema.rollback()` or `schema.drop()` did not get the migration lock in its `lockTimeout`; for
 * `schema.rollback()` and `schema.drop()`, also the lock of a table.
 */
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
