import { describe, expect, test } from 'vitest';
import { defineConcurrencyLimit } from './define_concurrency_limit.js';
import { defineLane } from './define_lane.js';
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
const buildReport = defineLane({
    name: 'build_report',
    maxAttempts: 5,
    retention: { completed: '10m' },
    globalConcurrencyLimits: ({ payload }) => [report.key(payload.reportId)],
    globalRateLimits: ({ payload }) => [reportApi.key(payload.reportId, { cost: 2 })],
    failureLane: defineLane({ name: 'report_failed' }),
});

/**
 * @param {Partial<import('./new_job.js').NewJobParams>} params
 * @returns {import('./new_job.js').NewJob}
 */
function build(params) {
    return buildNewJob({
        lane: 'build_report',
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
            lane: 'build_report',
            payloadJson: '{"reportId":"r1"}',
            limits: [{ key: 'report:r1', max: 1 }],
            rateLimits: [{ key: '@report_api:r1', max: 10, per_us: 60_000_000, burst: 2, cost: 2 }],
            maxAttempts: 5,
            maxStalls: 2,
            completedRetentionMs: 600_000,
            failedRetentionMs: 2_592_000_000,
            delayMs: 0,
            runAt: null,
            fairGroup: null,
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
            delayMs: 0,
            runAt,
        });
    });

    test('the global limits come from the payload as JSON gives it back', () => {
        const withKeys = defineLane({ name: 'with_keys', globalConcurrencyLimits: ({ payload }) => [report.key(payload.at)] });
        const at = new Date('2030-01-01T00:00:00Z');

        expect(build({ lane: 'with_keys', definition: withKeys, payload: { at } }).limits)
            .toStrictEqual([{ key: 'report:2030-01-01T00:00:00.000Z', max: 1 }]);
    });

    test('the global rate limits: from the payload as JSON gives it back; the option replaces them', () => {
        const withKeys = defineLane({ name: 'with_keys', globalRateLimits: ({ payload }) => [reportApi.key(payload.at)] });
        const at = new Date('2030-01-01T00:00:00Z');

        expect(build({ lane: 'with_keys', definition: withKeys, payload: { at } }).rateLimits)
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

    test('jobId is an unknown option', () => {
        expect(() => build({ options: /** @type {any} */ ({ jobId: 'r1' }) }))
            .toThrow('enqueue("build_report"): unknown options: jobId');
    });

    test('failureLane is an unknown option: the definition of the process that fails the job decides', () => {
        expect(() => build({ options: /** @type {any} */ ({ failureLane: 'other_failed' }) }))
            .toThrow('enqueue("build_report"): unknown options: failureLane');
    });

    test('a delay', () => {
        expect(build({ options: { delay: '1m30s' } })).toMatchObject({ delayMs: 90_000, runAt: null });
    });
});

test('an unknown name takes the defaults', () => {
    expect(build({ lane: 'send_email', definition: defineLane({ name: 'send_email' }), options: { dedupeKey: 'e1' } })).toMatchObject({
        id: 'send_email:e1',
        limits: [],
        rateLimits: [],
        maxAttempts: 3,
        maxStalls: 2,
        completedRetentionMs: 3_600_000,
        failedRetentionMs: 2_592_000_000,
    });
});

test.each([
    ['a bad name', { lane: 'Build' }, InvalidOptionsError],
    ['an unknown option', { options: { attempts: 3 } }, InvalidOptionsError],
    ['delay and runAt', { options: { delay: '1s', runAt: new Date() } }, InvalidOptionsError],
    ['an invalid runAt', { options: { runAt: new Date('nope') } }, InvalidOptionsError],
    ['a runAt that is not a Date', { options: { runAt: '2030-01-01' } }, InvalidOptionsError],
    ['a bad delay', { options: { delay: -1 } }, InvalidOptionsError],
    ['unordered delay units', { options: { delay: '1ms 1d' } }, InvalidOptionsError],
    ['full retention units', { options: { retention: { completed: '1 days' } } }, InvalidOptionsError],
    ['a bad maxAttempts', { options: { maxAttempts: 0 } }, InvalidOptionsError],
    ['a payload that is not JSON', { payload: undefined }, InvalidOptionsError],
    ['a payload above the limit', { maxPayloadBytes: 10 }, PayloadTooLargeError],
    ['a bad key of a limit', { options: { globalConcurrencyLimits: [report.key(' a')] } }, InvalidConcurrencyLimitError],
    ['a key that is not of a limit', { options: { globalConcurrencyLimits: ['report:1'] } }, InvalidConcurrencyLimitError],
    ['a bad key of a rate limit', { options: { globalRateLimits: [reportApi.key('a ')] } }, InvalidRateLimitError],
    ['a concurrency limit as a rate limit', { options: { globalRateLimits: [report] } }, InvalidRateLimitError],
    ['a rate limit as a concurrency limit', { options: { globalConcurrencyLimits: [reportApi] } }, InvalidConcurrencyLimitError],
    ['the slot option of 9.x', { options: { slot: { at: new Date() } } }, InvalidOptionsError],
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
    ['slot of 9.x', { slot: { at: new Date() } }, 'unknown options: slot'],
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

describe('the job of a slot (the scheduler, schedules.runSlot)', () => {
    const at = Date.parse('2026-11-11T02:00:00.000Z');

    test('gets the dedupe key of the slot, with the key of its schedule, due now', () => {
        expect(build({ slot: { at, key: 'tenant:42' } })).toMatchObject({
            id: 'build_report:schedule:tenant:42:2026-11-11T02:00:00.000Z',
            hasJobId: true,
            delayMs: 0,
            runAt: null,
        });
    });

    test('with a delay or a runAt', () => {
        expect(build({ slot: { at, key: 'k' }, options: { delay: '1m' } })).toMatchObject({ delayMs: 60_000 });
        expect(build({ slot: { at, key: 'k' }, options: { runAt: new Date(at) } })).toMatchObject({ runAt: new Date(at) });
    });

    test('the years 1970 and 9999', () => {
        expect(build({ slot: { at: 0, key: 'k' } }).id).toBe('build_report:schedule:k:1970-01-01T00:00:00.000Z');
        expect(build({ slot: { at: Date.parse('9999-12-31T23:59:59.999Z'), key: 'k' } }).id)
            .toBe('build_report:schedule:k:9999-12-31T23:59:59.999Z');
    });
});

describe('the fair group', () => {
    const convert = defineLane({ name: 'convert', fairGroup: ({ payload }) => payload.queue });

    /**
     * @param {unknown} payload
     * @param {import('./types.js').EnqueueOptions} [options]
     * @returns {import('./new_job.js').NewJob}
     */
    const buildGroup = (payload, options) => buildNewJob({
        lane: 'convert', definition: convert, defaults, payload, options, maxPayloadBytes: 1000,
    });

    test('from the payload as JSON gives it back', () => {
        /** @type {unknown[]} */
        const seen = [];
        const lane = defineLane({ name: 'convert', fairGroup: ({ payload }) => {
            seen.push(payload);

            return 'g';
        } });

        expect(buildNewJob({ lane: 'convert', definition: lane, defaults, payload: { at: new Date(0) },
            options: undefined, maxPayloadBytes: 1000 }).fairGroup).toBe('g');
        expect(seen).toStrictEqual([{ at: '1970-01-01T00:00:00.000Z' }]);
    });

    test.each([
        ['a group', 'backend-1:out', 'backend-1:out'],
        ['255 characters', 'g'.repeat(255), 'g'.repeat(255)],
        ['null: no group', null, null],
        ['undefined: no group', undefined, null],
    ])('%s', (_, queue, fairGroup) => {
        expect(buildGroup({ queue }).fairGroup).toBe(fairGroup);
    });

    test('a lane without fairGroup: null', () => {
        expect(build({}).fairGroup).toBeNull();
    });

    test.each([
        ['an empty string', ''],
        ['256 characters', 'g'.repeat(256)],
        ['a space at the end', 'g '],
        ['a non-ASCII character', 'é'],
        ['a number', 42],
    ])('rejects %s: an InvalidOptionsError', (_, queue) => {
        expect(() => buildGroup({ queue })).toThrow(new InvalidOptionsError('enqueue("convert"): a fair group has 1 '
            + `to 255 printable ASCII characters, without spaces at the ends: ${JSON.stringify(queue)}`));
    });

    test('a function that throws: its error, as it is', () => {
        const error = new Error('no queue');
        const lane = defineLane({ name: 'convert', fairGroup: () => {
            throw error;
        } });

        expect(() => buildNewJob({ lane: 'convert', definition: lane, defaults, payload: {}, options: undefined,
            maxPayloadBytes: 1000 })).toThrow(error);
    });

    test.each([
        ['globalConcurrencyLimits', { globalConcurrencyLimits: [report.key('r1')] }],
        ['globalRateLimits', { globalRateLimits: [reportApi.key('r1')] }],
    ])('the enqueue option %s on a lane with fairGroup: an InvalidOptionsError', (name, options) => {
        expect(() => buildGroup({ queue: 'a' }, options)).toThrow(new InvalidOptionsError(`enqueue("convert"): `
            + `"${name}" does not combine with the "fairGroup" of the lane: only [] is allowed`));
    });

    test('the enqueue options [] and undefined of the limits: accepted', () => {
        expect(buildGroup({ queue: 'a' }, { globalConcurrencyLimits: [], globalRateLimits: undefined }))
            .toMatchObject({ fairGroup: 'a', limits: [], rateLimits: [] });
    });
});
