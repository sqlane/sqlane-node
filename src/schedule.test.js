import { describe, expect, test } from 'vitest';
import { parseCron } from './cron.js';
import { defineLane } from './define_lane.js';
import { ConfigError } from './errors.js';
import {
    checkSchedule,
    cyrb53,
    dueOf,
    jitterOffset,
    latestSlot,
    nextSlot,
    pendingSlots,
    previousSlot,
    scheduledAtOf,
    slotDedupeKeyOf,
} from './schedule.js';

const report = defineLane({ name: 'nightly_report' });

describe('checkSchedule', () => {
    test('a cron in a zone', () => {
        const entry = checkSchedule(report, { key: 'nightly', cron: '0 3 * * MON-FRI', timezone: 'Europe/Berlin' });

        expect(entry).toMatchObject({
            id: 'nightly_report:nightly',
            lane: 'nightly_report',
            key: 'nightly',
            spec: 'cron 0 3 * * 1-5 Europe/Berlin',
            payload: {},
            missed: 'once',
            overlap: 'allow',
            nextAt: null,
            retryDelayMs: 0,
        });
    });

    test('an interval with a key, a payload and the options', () => {
        const entry = checkSchedule(defineLane({ name: 'sync_tenant' }), {
            every: '15m',
            key: 'tenant:42',
            payload: { tenantId: 42 },
            missed: 'skip',
            overlap: 'skip',
        });

        expect(entry).toMatchObject({
            id: 'sync_tenant:tenant:42',
            key: 'tenant:42',
            spec: 'every 900000',
            payload: { tenantId: 42 },
            missed: 'skip',
            overlap: 'skip',
        });
    });

    test('the time zone in its usual case: a change of case keeps the spec', () => {
        expect(checkSchedule(report, { key: 'k', cron: '0 3 * * *', timezone: 'europe/berlin' }).spec)
            .toBe('cron 0 3 * * * Europe/Berlin');
        expect(checkSchedule(report, { key: 'k', cron: '0 3 * * *', timezone: 'utc' }).spec).toBe('cron 0 3 * * * UTC');
    });

    test('the cron in UTC by default', () => {
        expect(checkSchedule(report, { key: 'k', cron: '@daily' }).spec).toBe('cron 0 0 * * * UTC');
    });

    test.each([
        ['cron and every', { cron: '* * * * *', every: '1m' }, /"cron" or "every", exactly one/],
        ['neither', {}, /"cron" or "every", exactly one/],
        ['timezone with every', { every: '1m', timezone: 'UTC' }, /"timezone" is only for "cron"/],
        ['every below 1s', { every: '999ms' }, /at least '1s'/],
        ['every over 1d', { every: '2d' }, /at most '1d'/],
        ['every 5h', { every: '5h' }, /must divide 1 day/],
        ['a bad every', { every: 'soon' }, /at least '1s'/],
        ['a bad key', { every: '1m', key: ' a' }, /"key"/],
        ['a long key', { every: '1m', key: 'k'.repeat(65) }, /"key"/],
        ['a bad missed', { every: '1m', missed: 'all' }, /"missed"/],
        ['a bad overlap', { every: '1m', overlap: 'wait' }, /"overlap"/],
        ['an unknown option', { every: '1m', offset: '5m' }, /unknown options: offset/],
        ['a bad zone', { cron: '* * * * *', timezone: 'Mars/Olympus' }, /"timezone"/],
        ['a bad cron', { cron: '* * * *' }, /5 fields/],
        ['seconds', { cron: '0 * * * * *' }, /use "every"/],
        ['a cron that never fires', { cron: '0 0 30 2 *' }, /never fires/],
        ['a jitter of 0', { every: '1h', jitter: 0 }, /"jitter" must be a positive duration/],
        ['a negative jitter', { every: '1h', jitter: -5 }, /"jitter" must be a positive duration/],
        ['a jitter over 1d', { cron: '0 0 * * 1', jitter: '1d 1ms' }, /"jitter" must be a positive duration/],
        ['a jitter that is not a duration', { every: '1h', jitter: 'soon' }, /"jitter" must be a positive duration/],
        ['a jitter of every', { every: '1h', jitter: '1h' }, /"jitter" must be less than "every"/],
    ])('rejects %s', (_, options, message) => {
        expect(() => checkSchedule(report, { key: 'k', ...options })).toThrow(ConfigError);
        expect(() => checkSchedule(report, { key: 'k', ...options })).toThrow(message);
    });

    test('rejects a bad lane name, and a schedule without a key', () => {
        expect(() => checkSchedule(/** @type {any} */ ('report'), { key: 'k', every: '1m' }))
            .toThrow('defineSchedule(""): the lane must be a lane definition');
        expect(() => checkSchedule(report, { every: '1m' })).toThrow('"key" is required');
    });

    test('accepts the intervals that divide a day, and any interval up to 1 hour', () => {
        for (const every of ['1s', '1500ms', '7m', '1h', '2h', '3h', '8h', '12h', '1d']) {
            expect(checkSchedule(report, { key: 'k', every }).timing).toMatchObject({ kind: 'every' });
        }
    });
});

describe('slots', () => {
    test('every: from the Unix epoch', () => {
        const entry = checkSchedule(report, { key: 'k', every: '6h' });

        expect(nextSlot(entry, Date.parse('2026-01-01T05:00:00Z'))).toBe(Date.parse('2026-01-01T06:00:00Z'));
        expect(nextSlot(entry, Date.parse('2026-01-01T06:00:00Z'))).toBe(Date.parse('2026-01-01T12:00:00Z'));
        expect(latestSlot(entry, Date.parse('2026-01-01T06:00:00Z'))).toBe(Date.parse('2026-01-01T06:00:00Z'));
        expect(previousSlot(entry, Date.parse('2026-01-01T06:00:00Z'))).toBe(Date.parse('2026-01-01T00:00:00Z'));
    });

    test('every 1500ms: slots with milliseconds', () => {
        const entry = checkSchedule(report, { key: 'k', every: '1500ms' });

        expect(nextSlot(entry, 1_000_000)).toBe(1_000_500);
        expect(slotDedupeKeyOf(entry.key, 1_000_500)).toBe('schedule:k:1970-01-01T00:16:40.500Z');
    });

    test('cron: next, latest, previous', () => {
        const entry = checkSchedule(report, { key: 'k', cron: '0 3 * * *', timezone: 'Europe/Berlin' });

        expect(nextSlot(entry, Date.parse('2026-06-10T00:00:00Z'))).toBe(Date.parse('2026-06-10T01:00:00Z'));
        expect(latestSlot(entry, Date.parse('2026-06-10T00:00:00Z'))).toBe(Date.parse('2026-06-09T01:00:00Z'));
        expect(previousSlot(entry, Date.parse('2026-06-10T01:00:00Z'))).toBe(Date.parse('2026-06-09T01:00:00Z'));
    });
});

describe('job ids of slots', () => {
    const slot = Date.parse('2026-11-11T02:00:00Z');

    test.each([
        ['with a key', { every: '1h', key: 'tenant-42' }, 'schedule:tenant-42:2026-11-11T02:00:00.000Z'],
        ['with a key that has :', { every: '1h', key: 'a:b:2026' }, 'schedule:a:b:2026:2026-11-11T02:00:00.000Z'],
    ])('round trip %s', (_, options, jobId) => {
        const entry = checkSchedule(report, options);

        expect(slotDedupeKeyOf(entry.key, slot)).toBe(jobId);
        expect(scheduledAtOf(`nightly_report:${jobId}`)).toStrictEqual(new Date(slot));
    });

    test('the job id of a slot of a keyless schedule of 9.x still gives its slot', () => {
        expect(scheduledAtOf('nightly_report:schedule:2026-11-11T02:00:00.000Z')).toStrictEqual(new Date(slot));
    });

    test.each([
        '01J0000000000000000000000Z',
        'nightly_report:my-id',
        'nightly_report:x:schedule:soon',
        'nightly_report:schedule:2026-11-11T02:00:00Z',
    ])('%s is not the job of a slot', (id) => {
        expect(scheduledAtOf(id)).toBeNull();
    });
});

/**
 * @param {import('./schedule.js').ScheduleEntry} entry
 * @param {string} from
 * @returns {number[][]} The slots of 750 that break slot ≤ due < next slot.
 */
function orderViolations(entry, from) {
    const violations = [];
    let slot = /** @type {number} */ (nextSlot(entry, Date.parse(from)));

    for (let index = 0; index < 750; index++) {
        const next = /** @type {number} */ (nextSlot(entry, slot));
        const due = dueOf(entry, slot);

        if (!(slot <= due && due < next)) {
            violations.push([slot, due, next]);
        }

        slot = next;
    }

    return violations;
}

const hourly = checkSchedule(defineLane({ name: 'sync' }), { key: 'k', every: '1h', jitter: '10m' });

/**
 * @param {number} index
 * @returns {number} The offset of the slot `index` hours after the epoch.
 */
function offsetOf(index) {
    return jitterOffset(hourly, index * 3_600_000, (index + 1) * 3_600_000);
}

describe('jitter', () => {
    test('cyrb53: the reference value', () => {
        expect(cyrb53('a')).toBe(7_929_297_801_672_961);
    });

    // The input of the hash is `${scheduleId}|${slotMs}`: a change of it changes every offset
    test.each([
        ['2026-01-01T00:00:00Z', 5000],
        ['2026-01-01T01:00:00Z', 324_000],
        ['2026-06-01T12:00:00Z', 456_000],
    ])('pinned: every 1h, jitter 10m, the slot %s', (slot, offset) => {
        expect(jitterOffset(hourly, Date.parse(slot), Date.parse(slot) + 3_600_000)).toBe(offset);
    });

    test('pinned: a gap of 5 minutes, below the jitter of 10: the offsets stay below the gap', () => {
        const entry = checkSchedule(defineLane({ name: 'report' }), { key: 'k', cron: '0,5 * * * *', jitter: '10m' });
        const slot = Date.parse('2026-01-01T00:00:00Z');

        expect(dueOf(entry, slot) - slot).toBe(176_000);
        expect(dueOf(entry, slot + 300_000) - slot - 300_000).toBe(120_000);
    });

    test('deterministic, in [0, jitter), whole seconds; milliseconds below 1 s', () => {
        const offsets = Array.from({ length: 1000 }, (_, index) => offsetOf(index));
        const subSecond = checkSchedule(defineLane({ name: 'fast' }), { key: 'k', every: '1s', jitter: '500ms' });

        expect(offsets).toStrictEqual(Array.from({ length: 1000 }, (_, index) => offsetOf(index)));
        expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...offsets)).toBeLessThan(600_000);
        expect(offsets.filter(offset => offset % 1000)).toStrictEqual([]);
        expect(jitterOffset(subSecond, 1000, 2000)).toBeLessThan(500);
    });

    test('no jitter: the due time is the slot, nothing is cached', () => {
        const entry = checkSchedule(defineLane({ name: 'plain' }), { key: 'k', every: '1h' });

        expect(dueOf(entry, 3_600_000)).toBe(3_600_000);
        expect(entry.dueCache).toBeNull();
    });

    test('roughly uniform: χ² over 10 buckets', () => {
        const buckets = Array.from({ length: 10 }, () => 0);

        for (let index = 0; index < 1000; index++) {
            const entry = checkSchedule(defineLane({ name: `job_${index}` }), { key: 'k', every: '1h', jitter: '10m' });

            buckets[Math.floor(jitterOffset(entry, 0, 3_600_000) / 60_000)]++;
        }

        let chiSquare = 0;

        for (const count of buckets) {
            chiSquare += ((count - 100) ** 2) / 100;
        }

        expect(chiSquare).toBeLessThan(30);
    });

    test.each([
        ['0,5 * * * *', 'UTC', '10m'],
        ['*/15 * * * *', 'Europe/Berlin', '1h'],
        ['30 2 * * *', 'Europe/Berlin', '1d'],
        ['5 * * * *', 'America/New_York', '2h'],
    ])('%s in %s, jitter %s: slot ≤ due < next slot, across both transitions of 2026', (cron, timezone, jitter) => {
        const entry = checkSchedule(defineLane({ name: 'ordered' }), { key: 'k', cron, timezone, jitter });

        expect([...orderViolations(entry, '2026-03-07T00:00:00Z'), ...orderViolations(entry, '2026-10-24T00:00:00Z')])
            .toStrictEqual([]);
    });

    describe('pendingSlots', () => {
        const entry = checkSchedule(defineLane({ name: 'job_0' }), { key: 'k', every: '1h', jitter: '59m' });
        // Offset of the slot 10:00: 55 min 48 s
        const slot = Date.parse('2026-06-01T10:00:00Z');

        test('the due time of the latest slot has come', () => {
            expect(pendingSlots(entry, slot + (56 * 60_000))).toStrictEqual({ latest: slot, nextAt: slot + 3_600_000 });
        });

        test('the latest slot has come, its due time has not: the slot before is the latest due one', () => {
            expect(dueOf(entry, slot) - slot).toBe(3_348_000);
            expect(pendingSlots(entry, slot + (20 * 60_000))).toStrictEqual({ latest: slot - 3_600_000, nextAt: slot });
        });

        test('no slot', () => {
            const never = checkSchedule(defineLane({ name: 'never' }), { key: 'k', cron: '0 0 1 1 *', jitter: '1h' });

            // As if the cron had no slot within the horizon
            Object.assign(never.timing, { cron: parseCron('0 0 30 2 *') });

            expect(pendingSlots(never, slot)).toStrictEqual({ latest: null, nextAt: null });
        });
    });
});
