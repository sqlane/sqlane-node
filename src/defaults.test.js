import { expect, test } from 'vitest';
import { resolveDefaults } from './defaults.js';
import { ConfigError } from './errors.js';

test('the built-in defaults', () => {
    expect(resolveDefaults()).toStrictEqual({
        maxAttempts: 3,
        maxStalls: 2,
        backoff: { type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 },
        retention: { completedMs: 3_600_000, failedMs: 2_592_000_000 },
        timeoutMs: null,
    });
});

test('the instance defaults override the built-in ones, field by field', () => {
    expect(resolveDefaults({ maxAttempts: 5, retention: { failed: '1d' }, timeout: '10m' })).toMatchObject({
        maxAttempts: 5,
        maxStalls: 2,
        retention: { completedMs: 3_600_000, failedMs: 86_400_000 },
        timeoutMs: 600_000,
    });
});

test.each([
    ['an unknown option', { attempts: 3 }],
    ['a bad maxAttempts', { maxAttempts: 0 }],
    ['a zero timeout', { timeout: '0s' }],
    ['a rounded zero timeout', { timeout: '0.0004s' }],
    ['full duration names', { retention: { failed: '2 days' } }],
    ['unordered backoff units', { backoff: { type: 'fixed', delay: '1ms 1s' } }],
    ['a bad backoff', { backoff: { type: 'fixed', delay: 'soon' } }],
])('rejects %s', (_, defaults) => {
    expect(() => resolveDefaults(/** @type {any} */ (defaults))).toThrow(ConfigError);
});
