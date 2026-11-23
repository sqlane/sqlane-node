import { expect, test } from 'vitest';
import { defineRateLimit } from './define_rate_limit.js';
import {
    ClosedError,
    ConfigError,
    DrainTimeoutError,
    FatalJobError,
    InvalidConcurrencyLimitError,
    InvalidOptionsError,
    InvalidRateLimitError,
    JobTimeoutError,
    LeaseLostError,
    MigrationLockTimeoutError,
    MissingPayloadError,
    PayloadTooLargeError,
    RateLimitedError,
    RetryJobError,
    ShutdownError,
    SqlaneError,
    UnknownLaneError,
} from './errors.js';

/** @type {[new (message: string, options?: ErrorOptions) => SqlaneError, string][]} */
const ERRORS = [
    [ClosedError, 'CLOSED'],
    [ConfigError, 'CONFIG'],
    [DrainTimeoutError, 'DRAIN_TIMEOUT'],
    [FatalJobError, 'FATAL_JOB'],
    [InvalidConcurrencyLimitError, 'INVALID_CONCURRENCY_LIMIT'],
    [InvalidOptionsError, 'INVALID_OPTIONS'],
    [InvalidRateLimitError, 'INVALID_RATE_LIMIT'],
    [JobTimeoutError, 'JOB_TIMEOUT'],
    [LeaseLostError, 'LEASE_LOST'],
    [MigrationLockTimeoutError, 'MIGRATION_LOCK_TIMEOUT'],
    [MissingPayloadError, 'MISSING_PAYLOAD'],
    [PayloadTooLargeError, 'PAYLOAD_TOO_LARGE'],
    [ShutdownError, 'SHUTDOWN'],
    [UnknownLaneError, 'UNKNOWN_LANE'],
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

const github = defineRateLimit({ name: 'github', max: 5000, per: '1h' });

test('RateLimitedError keeps its limit and retryAfter; the message names the key', () => {
    const key = github.key('t1');
    const cause = new Error('429');
    const error = new RateLimitedError({ limit: key, retryAfter: '30s', cause });

    expect(error).toBeInstanceOf(SqlaneError);
    const { name, code, message, limit, retryAfter } = error;

    expect({ name, code, message, limit, retryAfter, cause: error.cause })
        .toStrictEqual({
            name: 'RateLimitedError',
            code: 'RATE_LIMITED',
            message: 'Rate limited on github:t1: retry after 30000 ms',
            limit: key,
            retryAfter: '30s',
            cause,
        });
});

test('RateLimitedError: the limit is optional; a limit, a cost of it, 0 and 7 d pass', () => {
    const error = new RateLimitedError({ retryAfter: 0 });

    expect({ message: error.message, limit: error.limit, hasCause: 'cause' in error })
        .toStrictEqual({ message: 'Rate limited: retry after 0 ms', limit: undefined, hasCause: false });
    expect(new RateLimitedError({ limit: github, retryAfter: '7d' }).message).toBe('Rate limited on github: retry after 604800000 ms');
    expect(new RateLimitedError({ limit: github.cost(1), retryAfter: 1 }).limit).toStrictEqual(github.cost(1));
});

test.each([
    ['no options', undefined, 'new RateLimitedError(): options must be an object'],
    ['no retryAfter', {}, '"retryAfter" must be a duration from 0 to 7 d'],
    ['a bad retryAfter', { retryAfter: 'soon' }, '"retryAfter" must be a duration from 0 to 7 d (\'30s\', or milliseconds), got "soon"'],
    ['a retryAfter above 7 d', { retryAfter: '7d 1ms' }, '"retryAfter" must be a duration from 0 to 7 d'],
    ['a stored key as the limit', { limit: '@github:t1', retryAfter: '1s' }, '"limit" must be a limit from defineRateLimit(), its key() or its cost()'],
    ['a copy of a key', { limit: { ...github.key('t1') }, retryAfter: '1s' }, '"limit" must be a limit from defineRateLimit()'],
    ['an unknown option', { retryAfter: '1s', delay: '1s' }, 'new RateLimitedError(): unknown options: delay'],
])('RateLimitedError throws an InvalidRateLimitError for %s', (_, options, message) => {
    expect(() => new RateLimitedError(/** @type {any} */ (options))).toThrow(InvalidRateLimitError);
    expect(() => new RateLimitedError(/** @type {any} */ (options))).toThrow(message);
});
