import { expect, test } from 'vitest';
import {
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

/** @type {[new (message: string, options?: ErrorOptions) => SqlaneError, string][]} */
const ERRORS = [
    [ClosedError, 'CLOSED'],
    [ConfigError, 'CONFIG'],
    [DrainTimeoutError, 'DRAIN_TIMEOUT'],
    [FatalJobError, 'FATAL_JOB'],
    [InvalidMutexKeyError, 'INVALID_MUTEX_KEY'],
    [InvalidOptionsError, 'INVALID_OPTIONS'],
    [JobTimeoutError, 'JOB_TIMEOUT'],
    [LeaseLostError, 'LEASE_LOST'],
    [MigrationLockTimeoutError, 'MIGRATION_LOCK_TIMEOUT'],
    [MissingPayloadError, 'MISSING_PAYLOAD'],
    [PayloadTooLargeError, 'PAYLOAD_TOO_LARGE'],
    [ShutdownError, 'SHUTDOWN'],
    [UnknownJobError, 'UNKNOWN_JOB'],
];

test.each(ERRORS)('%o has its name and code, and extends SqlaneError', (ErrorClass, code) => {
    const cause = new Error('cause');
    const error = new ErrorClass('message', { cause });

    expect(error).toBeInstanceOf(SqlaneError);
    expect({ name: error.name, code: error.code, message: error.message, cause: error.cause })
        .toStrictEqual({ name: ErrorClass.name, code, message: 'message', cause });
});

test('RetryJobError keeps its delay', () => {
    const error = new RetryJobError('rate limited', { delay: '1m' });

    expect({ name: error.name, code: error.code, delay: error.delay })
        .toStrictEqual({ name: 'RetryJobError', code: 'RETRY_JOB', delay: '1m' });
});
