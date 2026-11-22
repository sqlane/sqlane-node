import { describe, expect, test } from 'vitest';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
import { defineJob } from './define_job.js';
import { defineRateLimit } from './define_rate_limit.js';
import { resolveDefaults } from './defaults.js';
import {
    InvalidConcurrencyLimitError,
    InvalidOptionsError,
    InvalidRateLimitError,
    PayloadTooLargeError,
} from './errors.js';
import { buildNewJob } from './new_job.js';

const defaults = resolveDefaults();
const report = defineConcurrencyLimit({ name: 'report', max: 1 });
const reportApi = defineRateLimit({ name: 'report_api', max: 10, per: '1m', burst: 2 });
const buildReport = defineJob({
    name: 'build_report',
    maxAttempts: 5,
    retention: { completed: '10m' },
    globalConcurrencyLimits: ({ payload }) => [report.key(payload.reportId)],
    globalRateLimits: ({ payload }) => [reportApi.key(payload.reportId, { cost: 2 })],
    failureJob: defineJob({ name: 'report_failed' }),
});

/**
 * @param {Partial<import('./new_job.js').NewJobParams>} params
 * @returns {import('./new_job.js').NewJob}
 */
function build(params) {
    return buildNewJob({
        name: 'build_report',
        definition: buildReport,
        defaults,
        payload: { reportId: 'r1' },
        options: undefined,
        maxPayloadBytes: 1024,
        ...params,
    });
}

describe('with a definition', () => {
    test('takes the definition, then the defaults', () => {
        expect(build({})).toStrictEqual({
            id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
            hasJobId: false,
            name: 'build_report',
            payloadJson: '{"reportId":"r1"}',
            limits: [{ key: 'report:r1', max: 1 }],
            rateLimits: [{ key: '@report_api:r1', max: 10, per_us: 60_000_000, burst: 2, cost: 2 }],
            maxAttempts: 5,
            maxStalls: 2,
            completedRetentionMs: 600_000,
            failedRetentionMs: 2_592_000_000,
            failureJob: 'report_failed',
            delayMs: 0,
            runAt: null,
        });
    });

    test('the options override the definition', () => {
        const runAt = new Date('2030-01-01T00:00:00Z');

        expect(build({
            options: {
                dedupeKey: 'r1',
                runAt,
                maxAttempts: 1,
                maxStalls: 0,
                retention: { failed: '1d' },
                failureJob: 'other_failed',
                globalConcurrencyLimits: [],
                globalRateLimits: [],
            },
        })).toMatchObject({
            id: 'build_report:r1',
            hasJobId: true,
            limits: [],
            rateLimits: [],
            maxAttempts: 1,
            maxStalls: 0,
            completedRetentionMs: 600_000,
            failedRetentionMs: 86_400_000,
            failureJob: 'other_failed',
            delayMs: 0,
            runAt,
        });
    });

    test('the global limits come from the payload as JSON gives it back', () => {
        const withKeys = defineJob({ name: 'with_keys', globalConcurrencyLimits: ({ payload }) => [report.key(payload.at)] });
        const at = new Date('2030-01-01T00:00:00Z');

        expect(build({ name: 'with_keys', definition: withKeys, payload: { at } }).limits)
            .toStrictEqual([{ key: 'report:2030-01-01T00:00:00.000Z', max: 1 }]);
    });

    test('the global rate limits: from the payload as JSON gives it back; the option replaces them', () => {
        const withKeys = defineJob({ name: 'with_keys', globalRateLimits: ({ payload }) => [reportApi.key(payload.at)] });
        const at = new Date('2030-01-01T00:00:00Z');

        expect(build({ name: 'with_keys', definition: withKeys, payload: { at } }).rateLimits)
            .toStrictEqual([{ key: '@report_api:2030-01-01T00:00:00.000Z', max: 10, per_us: 60_000_000, burst: 2, cost: 1 }]);
        expect(build({ options: { globalRateLimits: [reportApi] } }).rateLimits)
            .toStrictEqual([{ key: '@report_api', max: 10, per_us: 60_000_000, burst: 2, cost: 1 }]);
    });

    test('10 global keys, concurrency and rate limits together', () => {
        const many = {
            globalConcurrencyLimits: Array.from({ length: 5 }, (_, index) => report.key(index)),
            globalRateLimits: Array.from({ length: 5 }, (_, index) => reportApi.key(index)),
        };

        expect(build({ options: many })).toMatchObject({ limits: { length: 5 }, rateLimits: { length: 5 } });
        expect(() => build({ options: { ...many, globalRateLimits: [...many.globalRateLimits, reportApi] } }))
            .toThrow('enqueue("build_report"): at most 10 global keys, concurrency and rate limits together, got 11');
    });

    test('the mutexKeys of 5.x: an error that names the new option', () => {
        expect(() => build({ options: /** @type {any} */ ({ mutexKeys: ['a'] }) }))
            .toThrow('enqueue("build_report"): "mutexKeys" was removed in 6.0: use "globalConcurrencyLimits"');
    });

    test('the jobId of 7.x: an error that names the new option', () => {
        expect(() => build({ options: /** @type {any} */ ({ jobId: 'r1' }) }))
            .toThrow('enqueue("build_report"): "jobId" was renamed in 8.0: use "dedupeKey"');
        expect(() => build({ options: /** @type {any} */ ({ jobId: undefined }) }))
            .toThrow('enqueue("build_report"): "jobId" was renamed in 8.0: use "dedupeKey"');
    });

    test('a delay', () => {
        expect(build({ options: { delay: '1m30s' } })).toMatchObject({ delayMs: 90_000, runAt: null });
    });
});

test('an unknown name takes the defaults', () => {
    expect(build({ name: 'send_email', definition: null, options: { dedupeKey: 'e1' } })).toMatchObject({
        id: 'send_email:e1',
        limits: [],
        rateLimits: [],
        maxAttempts: 3,
        maxStalls: 2,
        completedRetentionMs: 3_600_000,
        failedRetentionMs: 2_592_000_000,
        failureJob: null,
    });
});

test.each([
    ['a bad name', { name: 'Build' }, InvalidOptionsError],
    ['an unknown option', { options: { attempts: 3 } }, InvalidOptionsError],
    ['delay and runAt', { options: { delay: '1s', runAt: new Date() } }, InvalidOptionsError],
    ['an invalid runAt', { options: { runAt: new Date('nope') } }, InvalidOptionsError],
    ['a runAt that is not a Date', { options: { runAt: '2030-01-01' } }, InvalidOptionsError],
    ['a bad delay', { options: { delay: -1 } }, InvalidOptionsError],
    ['unordered delay units', { options: { delay: '1ms 1d' } }, InvalidOptionsError],
    ['full retention units', { options: { retention: { completed: '1 days' } } }, InvalidOptionsError],
    ['a bad maxAttempts', { options: { maxAttempts: 0 } }, InvalidOptionsError],
    ['the job as its own failure job', { options: { failureJob: 'build_report' } }, InvalidOptionsError],
    ['a payload that is not JSON', { payload: undefined }, InvalidOptionsError],
    ['a payload above the limit', { maxPayloadBytes: 10 }, PayloadTooLargeError],
    ['a bad key of a limit', { options: { globalConcurrencyLimits: [report.key(' a')] } }, InvalidConcurrencyLimitError],
    ['a key that is not of a limit', { options: { globalConcurrencyLimits: ['report:1'] } }, InvalidConcurrencyLimitError],
    ['a bad key of a rate limit', { options: { globalRateLimits: [reportApi.key('a ')] } }, InvalidRateLimitError],
    ['a concurrency limit as a rate limit', { options: { globalRateLimits: [report] } }, InvalidRateLimitError],
    ['a rate limit as a concurrency limit', { options: { globalConcurrencyLimits: [reportApi] } }, InvalidConcurrencyLimitError],
    ['a slot without at', { options: { slot: {} } }, InvalidOptionsError],
    ['a slot at an invalid Date', { options: { slot: { at: new Date('nope') } } }, InvalidOptionsError],
    ['a slot before 1970', { options: { slot: { at: new Date('1969-12-31T23:59:59Z') } } }, InvalidOptionsError],
    ['a slot after 9999', { options: { slot: { at: new Date('+010000-01-01T00:00:00Z') } } }, InvalidOptionsError],
    ['a slot with a bad key', { options: { slot: { at: new Date(), key: 'a ' } } }, InvalidOptionsError],
    ['a slot with an unknown option', { options: { slot: { at: new Date(), id: 'x' } } }, InvalidOptionsError],
])('rejects %s', (_, params, ErrorClass) => {
    expect(() => build(/** @type {any} */ (params))).toThrow(ErrorClass);
});

const BAD_DEDUPE_KEY = '"dedupeKey" must have 1 to 120 printable ASCII characters';

test.each([
    ['a numeric dedupeKey', { dedupeKey: 42 }, BAD_DEDUPE_KEY],
    ['an empty dedupeKey', { dedupeKey: '' }, BAD_DEDUPE_KEY],
    ['a dedupeKey with a space at the end', { dedupeKey: 'r1 ' }, BAD_DEDUPE_KEY],
    ['a dedupeKey of 121 characters', { dedupeKey: 'x'.repeat(121) }, BAD_DEDUPE_KEY],
    ['a dedupeKey with the reserved prefix', { dedupeKey: 'schedule:2026' }, 'the "dedupeKey" prefix "schedule:" is reserved'],
    ['slot with dedupeKey', { slot: { at: new Date() }, dedupeKey: 'r1' }, '"slot" or "dedupeKey", not both'],
])('rejects %s', (_, options, message) => {
    const bad = () => build({ options: /** @type {any} */ (options) });

    expect(bad).toThrow(InvalidOptionsError);
    expect(bad).toThrow(`enqueue("build_report"): ${message}`);
});

test('accepts a dedupeKey of 120 characters', () => {
    expect(build({ options: { dedupeKey: 'x'.repeat(120) } }).id).toBe(`build_report:${'x'.repeat(120)}`);
});

test('accepts a dedupeKey with schedule: after its start', () => {
    expect(build({ options: { dedupeKey: 'x:schedule:1' } }).id).toBe('build_report:x:schedule:1');
});

describe('a slot run by hand', () => {
    const at = new Date('2026-11-11T02:00:00.000Z');

    test('gets the dedupe key of the slot, due now', () => {
        expect(build({ options: { slot: { at } } })).toMatchObject({
            id: 'build_report:schedule:2026-11-11T02:00:00.000Z',
            hasJobId: true,
            delayMs: 0,
            runAt: null,
        });
    });

    test('with a key', () => {
        expect(build({ options: { slot: { at, key: 'tenant:42' } } }).id)
            .toBe('build_report:schedule:tenant:42:2026-11-11T02:00:00.000Z');
    });

    test('with a delay or a runAt', () => {
        expect(build({ options: { slot: { at }, delay: '1m' } })).toMatchObject({ delayMs: 60_000 });
        expect(build({ options: { slot: { at }, runAt: at } })).toMatchObject({ runAt: at });
    });

    test('the years 1970 and 9999', () => {
        expect(build({ options: { slot: { at: new Date(0) } } }).id).toBe('build_report:schedule:1970-01-01T00:00:00.000Z');
        expect(build({ options: { slot: { at: new Date('9999-12-31T23:59:59.999Z') } } }).id)
            .toBe('build_report:schedule:9999-12-31T23:59:59.999Z');
    });
});
