import { expect, test } from 'vitest';
import { defineLane } from './define_lane.js';
import { defineSchedule, isScheduleDefinition, scheduleEntryOf } from './define_schedule.js';
import { ConfigError } from './errors.js';

const report = defineLane({ name: 'report' });

test('gives a frozen schedule with the id <lane>:<key>, its options, and a frozen copy of its payload', () => {
    const payload = { kind: 'full', pages: [1, 2] };
    const schedule = defineSchedule(report, {
        key: 'full',
        cron: '0 6 * * *',
        timezone: 'Europe/Berlin',
        payload,
        missed: 'skip',
        overlap: 'skip',
        jitter: '1m',
    });

    expect(schedule).toStrictEqual({
        id: 'report:full',
        lane: report,
        key: 'full',
        cron: '0 6 * * *',
        timezone: 'Europe/Berlin',
        payload,
        missed: 'skip',
        overlap: 'skip',
        jitter: '1m',
    });
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(schedule.payload).not.toBe(payload);
    expect(Object.isFrozen(schedule.payload)).toBe(true);
    expect(Object.isFrozen(schedule.payload.pages)).toBe(true);
    expect(isScheduleDefinition(schedule)).toBe(true);
});

test('the defaults: payload {}, missed once, overlap allow; every in UTC', () => {
    expect(defineSchedule(report, { key: 'tick', every: '1m' })).toStrictEqual({
        id: 'report:tick',
        lane: report,
        key: 'tick',
        every: '1m',
        payload: {},
        missed: 'once',
        overlap: 'allow',
    });
});

test('a key with a colon: the id keeps it', () => {
    expect(defineSchedule(report, { key: 'eu:full', every: '1h' }).id).toBe('report:eu:full');
});

test('scheduleEntryOf: a new entry of the schedule each time, with its definition, as the scheduler takes it', () => {
    const schedule = defineSchedule(report, { key: 'tick', every: '1m', payload: { a: 1 } });
    const entry = scheduleEntryOf(schedule);

    expect(entry).toMatchObject({
        id: 'report:tick',
        lane: 'report',
        key: 'tick',
        spec: 'every 60000',
        payload: { a: 1 },
        definition: report,
        nextAt: null,
    });
    expect(scheduleEntryOf(schedule)).not.toBe(entry);
});

test('isScheduleDefinition: false for a copy that is not frozen, a lane, null', () => {
    const schedule = defineSchedule(report, { key: 'tick', every: '1m' });

    expect(isScheduleDefinition({ ...schedule })).toBe(false);
    expect(isScheduleDefinition(report)).toBe(false);
    expect(isScheduleDefinition(null)).toBe(false);
});

test.each([
    ['a lane name', () => defineSchedule(/** @type {any} */ ('report'), /** @type {any} */ ({ key: 'a', every: '1m' })),
        'the lane must be a lane definition'],
    ['no key', () => defineSchedule(report, /** @type {any} */ ({ every: '1m' })), '"key" is required'],
    ['an empty key', () => defineSchedule(report, { key: '', every: '1m' }), '"key" must have 1 to 64'],
    ['a key of 65 characters', () => defineSchedule(report, { key: 'k'.repeat(65), every: '1m' }), '"key"'],
    ['a key with a space at its end', () => defineSchedule(report, { key: 'a ', every: '1m' }), '"key"'],
    ['cron and every', () => defineSchedule(report, /** @type {any} */ ({ key: 'a', every: '1m', cron: '* * * * *' })),
        '"cron" or "every", exactly one'],
    ['a bad cron', () => defineSchedule(report, { key: 'a', cron: '61 * * * *' }), 'defineSchedule("report")'],
    ['a bad time zone', () => defineSchedule(report, { key: 'a', cron: '* * * * *', timezone: 'Mars/Base' }),
        '"timezone" must be an IANA time zone'],
    ['every below 1s', () => defineSchedule(report, { key: 'a', every: 500 }), '"every" must be a duration'],
    ['a jitter not below every', () => defineSchedule(report, { key: 'a', every: '1m', jitter: '1m' }),
        '"jitter" must be less than "every"'],
    ['a bad missed', () => defineSchedule(report, /** @type {any} */ ({ key: 'a', every: '1m', missed: 'all' })),
        '"missed"'],
    ['an unknown option', () => defineSchedule(report, /** @type {any} */ ({ key: 'a', every: '1m', at: 1 })),
        'unknown options: at'],
    ['a payload that is not JSON', () => defineSchedule(report, /** @type {any} */ ({ key: 'a', every: '1m', payload: { at: 1n } })),
        'the payload is not JSON'],
])('rejects %s with a ConfigError', (_, func, message) => {
    expect(func).toThrow(ConfigError);
    expect(func).toThrow(message);
});
