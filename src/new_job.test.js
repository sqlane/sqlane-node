import { describe, expect, test } from 'vitest';
import { defineJob } from './define_job.js';
import { resolveDefaults } from './defaults.js';
import { InvalidMutexKeyError, InvalidOptionsError, PayloadTooLargeError } from './errors.js';
import { buildNewJob } from './new_job.js';

const defaults = resolveDefaults();
const buildReport = defineJob({
    name: 'build_report',
    maxAttempts: 5,
    retention: { completed: '10m' },
    mutexKeys: payload => [`report:${payload.reportId}`],
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
            mutexKeys: ['report:r1'],
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
                jobId: 'r1',
                runAt,
                maxAttempts: 1,
                maxStalls: 0,
                retention: { failed: '1d' },
                failureJob: 'other_failed',
                mutexKeys: [],
            },
        })).toMatchObject({
            id: 'build_report:r1',
            hasJobId: true,
            mutexKeys: [],
            maxAttempts: 1,
            maxStalls: 0,
            completedRetentionMs: 600_000,
            failedRetentionMs: 86_400_000,
            failureJob: 'other_failed',
            delayMs: 0,
            runAt,
        });
    });

    test('the mutex keys come from the payload as JSON gives it back', () => {
        const keyed = defineJob({ name: 'keyed', mutexKeys: payload => [String(payload.at)] });
        const at = new Date('2030-01-01T00:00:00Z');

        expect(build({ name: 'keyed', definition: keyed, payload: { at } }).mutexKeys)
            .toStrictEqual(['2030-01-01T00:00:00.000Z']);
    });

    test('a delay', () => {
        expect(build({ options: { delay: '1m30s' } })).toMatchObject({ delayMs: 90_000, runAt: null });
    });
});

test('an unknown name takes the defaults', () => {
    expect(build({ name: 'send_email', definition: null, options: { jobId: 'e1' } })).toMatchObject({
        id: 'send_email:e1',
        mutexKeys: [],
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
    ['a numeric jobId', { options: { jobId: 42 } }, InvalidOptionsError],
    ['an empty jobId', { options: { jobId: '' } }, InvalidOptionsError],
    ['a jobId with a space at the end', { options: { jobId: 'r1 ' } }, InvalidOptionsError],
    ['a jobId of 121 characters', { options: { jobId: 'x'.repeat(121) } }, InvalidOptionsError],
    ['a bad maxAttempts', { options: { maxAttempts: 0 } }, InvalidOptionsError],
    ['the job as its own failure job', { options: { failureJob: 'build_report' } }, InvalidOptionsError],
    ['a payload that is not JSON', { payload: undefined }, InvalidOptionsError],
    ['a payload above the limit', { maxPayloadBytes: 10 }, PayloadTooLargeError],
    ['a bad mutex key', { options: { mutexKeys: [' a'] } }, InvalidMutexKeyError],
])('rejects %s', (_, params, ErrorClass) => {
    expect(() => build(/** @type {any} */ (params))).toThrow(ErrorClass);
});

test('accepts a jobId of 120 characters', () => {
    expect(build({ options: { jobId: 'x'.repeat(120) } }).id).toBe(`build_report:${'x'.repeat(120)}`);
});
