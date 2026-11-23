import { expect, test } from 'vitest';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
import { defineLane } from './define_lane.js';
import { defineRateLimit } from './define_rate_limit.js';
import { ConfigError } from './errors.js';

test('gives a frozen copy of the options', () => {
    const backoff = /** @type {const} */ ({ type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 });
    const options = {
        name: 'build_report',
        maxAttempts: 5,
        maxStalls: 0,
        backoff,
        retention: { completed: 0, failed: '30d' },
        timeout: '5m',
        globalConcurrencyLimits: () => [],
        failureLane: 'report_failed',
        fairShareWeight: 3,
        localConcurrencyLimits: [defineConcurrencyLimit({ name: 'heavy', max: 2 })],
        globalRateLimits: () => [],
        localRateLimits: [defineRateLimit({ name: 'disk_io', max: 50, per: '1s' })],
    };
    const definition = defineLane(options);

    expect(definition).toStrictEqual(options);
    expect(definition).not.toBe(options);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.backoff)).toBe(true);
    expect(Object.isFrozen(definition.retention)).toBe(true);
    expect(Object.isFrozen(definition.localConcurrencyLimits)).toBe(true);
    expect(definition.localConcurrencyLimits).not.toBe(options.localConcurrencyLimits);
    expect(Object.isFrozen(definition.localRateLimits)).toBe(true);
    expect(definition.localRateLimits).not.toBe(options.localRateLimits);
});

test('accepts a definition as the failure job', () => {
    const reportFailed = defineLane({ name: 'report_failed' });

    expect(defineLane({ name: 'build_report', failureLane: reportFailed }).failureLane).toBe(reportFailed);
});

test.each([
    ['no options', undefined],
    ['no name', {}],
    ['an uppercase name', { name: 'BuildReport' }],
    ['a name with a colon', { name: 'build:report' }],
    ['a name of 129 characters', { name: `a${'b'.repeat(128)}` }],
    ['a name that starts with a digit', { name: '1job' }],
    ['an unknown option', { name: 'a', attempts: 3 }],
    ['maxAttempts 0', { name: 'a', maxAttempts: 0 }],
    ['maxAttempts 1.5', { name: 'a', maxAttempts: 1.5 }],
    ['maxStalls -1', { name: 'a', maxStalls: -1 }],
    ['an unknown backoff type', { name: 'a', backoff: { type: 'linear', delay: '1s' } }],
    ['a backoff without delay', { name: 'a', backoff: { type: 'fixed' } }],
    ['a maxDelay below the delay', { name: 'a', backoff: { type: 'exponential', delay: '1m', maxDelay: '1s' } }],
    ['a maxDelay of a fixed backoff', { name: 'a', backoff: { type: 'fixed', delay: '1s', maxDelay: '1m' } }],
    ['a jitter above 1', { name: 'a', backoff: { type: 'fixed', delay: '1s', jitter: 1.5 } }],
    ['an unknown backoff option', { name: 'a', backoff: { type: 'fixed', delay: '1s', factor: 3 } }],
    ['a bad retention', { name: 'a', retention: { completed: 'soon' } }],
    ['an unknown retention option', { name: 'a', retention: { pending: '1h' } }],
    ['a zero timeout', { name: 'a', timeout: 0 }],
    ['a bad timeout', { name: 'a', timeout: 'later' }],
    ['a timeout with trailing text', { name: 'a', timeout: '1s typo' }],
    ['globalConcurrencyLimits as an array', { name: 'a', globalConcurrencyLimits: [] }],
    ['a bad failure lane name', { name: 'a', failureLane: 'Fail' }],
    ['the job as its own failure job', { name: 'a', failureLane: 'a' }],
    ['fairShareWeight 0', { name: 'a', fairShareWeight: 0 }],
    ['fairShareWeight 1001', { name: 'a', fairShareWeight: 1001 }],
    ['fairShareWeight 1.5', { name: 'a', fairShareWeight: 1.5 }],
    ['a local limit that is not from defineConcurrencyLimit()', { name: 'a', localConcurrencyLimits: [{ name: 'b', max: 1 }] }],
    ['local limits as one limit', { name: 'a', localConcurrencyLimits: defineConcurrencyLimit({ name: 'b', max: 1 }) }],
    ['a local limit twice', {
        name: 'a',
        localConcurrencyLimits: [defineConcurrencyLimit({ name: 'b', max: 1 }), defineConcurrencyLimit({ name: 'b', max: 2 })],
    }],
    ['globalRateLimits as an array', { name: 'a', globalRateLimits: [] }],
    ['a local rate limit that is not from defineRateLimit()', {
        name: 'a',
        localRateLimits: [{ name: 'b', max: 1, per: 1000, burst: 1 }],
    }],
    ['a concurrency limit as a local rate limit', { name: 'a', localRateLimits: [defineConcurrencyLimit({ name: 'b', max: 1 })] }],
    ['a key of a local rate limit', { name: 'a', localRateLimits: [defineRateLimit({ name: 'b', max: 1, per: '1s' }).key('k')] }],
    ['a cost of a local rate limit', { name: 'a', localRateLimits: [defineRateLimit({ name: 'b', max: 2, per: '1s', burst: 2 }).cost(2)] }],
    ['local rate limits as one limit', { name: 'a', localRateLimits: defineRateLimit({ name: 'b', max: 1, per: '1s' }) }],
    ['a local rate limit twice', {
        name: 'a',
        localRateLimits: [defineRateLimit({ name: 'b', max: 1, per: '1s' }), defineRateLimit({ name: 'b', max: 2, per: '1s' })],
    }],
])('rejects %s', (_, options) => {
    expect(() => defineLane(/** @type {any} */ (options))).toThrow(ConfigError);
});
