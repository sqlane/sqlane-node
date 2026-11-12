import { describe, expect, test } from 'vitest';
import { cronCounters, latestCronTime, nextCronTime, parseCron, previousCronTime } from './cron.js';
import { offsetAt, wallOf } from './time_zone.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const YEAR_MS = 366 * DAY_MS;

/** @typedef {import('./cron.js').CronSpec} CronSpec */

/**
 * @param {string} text
 * @returns {number}
 */
function at(text) {
    return Date.parse(text);
}

/**
 * @param {number | null} ms
 * @returns {string | null}
 */
function iso(ms) {
    return ms === null ? null : new Date(ms).toISOString();
}

/**
 * @param {Uint8Array} flags
 * @returns {number[]} The set values.
 */
function valuesOf(flags) {
    return [...flags.keys()].filter(index => flags[index]);
}

/**
 * The next slots of a cron, one after the other.
 * @param {string} expression
 * @param {string} timeZone
 * @param {string} after
 * @param {number} count
 * @returns {(string | null)[]}
 */
function chain(expression, timeZone, after, count) {
    const spec = parseCron(expression);
    const slots = [];
    let current = /** @type {number | null} */ (at(after));

    for (let index = 0; index < count && current !== null; index++) {
        current = nextCronTime(spec, timeZone, current);
        slots.push(iso(current));
    }

    return slots;
}

// The oracle: every minute of a window, the plain reading of the rule (see docs/api.md › schedule).

/**
 * @param {CronSpec} spec
 * @param {number} wall
 * @returns {boolean}
 */
function matchesWall(spec, wall) {
    const date = new Date(wall);
    const byDay = spec.days[date.getUTCDate()] === 1;
    const byWeekday = spec.weekdays[date.getUTCDay()] === 1;
    const dayOk = !spec.daysStar && !spec.weekdaysStar ? byDay || byWeekday : byDay && byWeekday;

    return spec.minutes[date.getUTCMinutes()] === 1 && spec.hours[date.getUTCHours()] === 1
        && spec.months[date.getUTCMonth() + 1] === 1 && dayOk;
}

/** @type {Map<string, number>} */
const wallCache = new Map();

/**
 * @param {number} instant
 * @param {string} timeZone
 * @returns {number}
 */
function cachedWallOf(instant, timeZone) {
    const key = `${timeZone} ${instant}`;
    let wall = wallCache.get(key);

    if (wall === undefined) {
        wall = wallOf(instant, timeZone);
        wallCache.set(key, wall);
    }

    return wall;
}

/**
 * @param {CronSpec} spec
 * @param {string} timeZone
 * @param {number} instant A whole minute.
 * @returns {boolean} The instant is a slot.
 */
function oracleFires(spec, timeZone, instant) {
    const wall = cachedWallOf(instant, timeZone);
    const previousWall = cachedWallOf(instant - MINUTE_MS, timeZone);

    // The first instant after a gap: a matching wall time in the gap fires here
    if (wall - previousWall > MINUTE_MS && !spec.everyHour) {
        for (let skipped = previousWall + MINUTE_MS; skipped < wall; skipped += MINUTE_MS) {
            if (matchesWall(spec, skipped)) {
                return true;
            }
        }
    }

    if (!matchesWall(spec, wall)) {
        return false;
    }

    // The second pass of a repeated wall time
    const earlierOffset = cachedWallOf(instant - (2 * HOUR_MS), timeZone) - (instant - (2 * HOUR_MS));
    const shift = earlierOffset - (wall - instant);
    const secondPass = shift > 0 && cachedWallOf(instant - shift, timeZone) === wall;

    return !secondPass || spec.everyHour;
}

/**
 * @param {CronSpec} spec
 * @param {string} timeZone
 * @param {number} fromMs A whole minute.
 * @param {number} toMs
 * @returns {number[]} The slots in [fromMs, toMs].
 */
function oracleSlots(spec, timeZone, fromMs, toMs) {
    const slots = [];

    for (let instant = fromMs; instant <= toMs; instant += MINUTE_MS) {
        if (oracleFires(spec, timeZone, instant)) {
            slots.push(instant);
        }
    }

    return slots;
}

describe('parseCron', () => {
    test('accepts each item form', () => {
        const spec = parseCron('5,10-12,*/20,40-50/5,57/1 */6 1/10 JAN-mar,6 mon-FRI');

        expect(valuesOf(spec.minutes)).toStrictEqual([0, 5, 10, 11, 12, 20, 40, 45, 50, 57, 58, 59]);
        expect(valuesOf(spec.hours)).toStrictEqual([0, 6, 12, 18]);
        expect(valuesOf(spec.days)).toStrictEqual([1, 11, 21, 31]);
        expect(valuesOf(spec.months)).toStrictEqual([1, 2, 3, 6]);
        expect(valuesOf(spec.weekdays)).toStrictEqual([1, 2, 3, 4, 5]);
    });

    test('expands the macros', () => {
        expect(parseCron('@yearly').normalized).toBe('0 0 1 1 *');
        expect(parseCron('@annually').normalized).toBe('0 0 1 1 *');
        expect(parseCron('@monthly').normalized).toBe('0 0 1 * *');
        expect(parseCron('@weekly').normalized).toBe('0 0 * * 0');
        expect(parseCron('@daily').normalized).toBe('0 0 * * *');
        expect(parseCron('@midnight').normalized).toBe('0 0 * * *');
        expect(parseCron('@hourly').normalized).toBe('0 * * * *');
    });

    test('normalizes equal crons to one form', () => {
        expect(parseCron('0 9 * * MON-FRI').normalized).toBe('0 9 * * 1-5');
        expect(parseCron(' 0\t9 * * mon-fri ').normalized).toBe('0 9 * * 1-5');
        expect(parseCron('0 9 * * 1-5').normalized).toBe('0 9 * * 1-5');
        expect(parseCron('*/15 0-23 * 1-12 *').normalized).toBe('0,15,30,45 * * * *');
        expect(parseCron('0 0 * * 0').normalized).toBe(parseCron('0 0 * * 7').normalized);
    });

    test('keeps the * marker of the day fields: the day rule depends on it', () => {
        expect(parseCron('0 0 */2 * *').normalized).toBe('0 0 */2 * *');
        expect(parseCron('0 0 * * */2').normalized).toBe('0 0 * * */2');
        expect(parseCron('0 0 1-31 * *').normalized).toBe('0 0 1-31 * *');
        expect(parseCron('0 0 */3,2 * *').normalized).toBe('0 0 *:1-2,4,7,10,13,16,19,22,25,28,31 * *');
    });

    test('day of week: * and a/s over 0–6, 7 only as a value or the end of a range', () => {
        expect(valuesOf(parseCron('0 0 * * 1/2').weekdays)).toStrictEqual([1, 3, 5]);
        expect(valuesOf(parseCron('0 0 * * */2').weekdays)).toStrictEqual([0, 2, 4, 6]);
        expect(valuesOf(parseCron('0 0 * * 5-7').weekdays)).toStrictEqual([0, 5, 6]);
        expect(valuesOf(parseCron('0 0 * * */7').weekdays)).toStrictEqual([0]);
        expect(valuesOf(parseCron('0 0 * * 7').weekdays)).toStrictEqual([0]);
    });

    test('every hour: all 24 hours', () => {
        expect(parseCron('0 * * * *').everyHour).toBe(true);
        expect(parseCron('0 0-23 * * *').everyHour).toBe(true);
        expect(parseCron('0 */1 * * *').everyHour).toBe(true);
        expect(parseCron('0 */2 * * *').everyHour).toBe(false);
        expect(parseCron('0 0-22 * * *').everyHour).toBe(false);
    });

    test.each([
        ['', /1 to 256 characters/],
        ['* * * *', /5 fields/],
        ['* * * * * *', /seconds are not supported: use "every"/],
        ['* * * * * * *', /5 fields/],
        ['60 * * * *', /minute field/],
        ['* 24 * * *', /hour field/],
        ['* * 0 * *', /day of month field/],
        ['* * * 13 *', /month field/],
        ['* * * * 8', /day of week field/],
        ['5-1 * * * *', /minute field: the range "5-1" goes backwards/],
        ['*/0 * * * *', /minute field: the step/],
        ['* * L * *', /day of month field: "L" is not supported/],
        ['* * 15W * *', /day of month field: "15W" is not supported/],
        ['* * * * 1#2', /day of week field: "1#2" is not supported/],
        ['* * ? * *', /day of month field: "\?" is not supported/],
        ['H * * * *', /minute field: "H" is not supported/],
        ['@reboot', /macro "@reboot" is not supported/],
        ['* * * JAN- *', /month field/],
        ['* * * * 1x', /day of week field/],
        ['1,,2 * * * *', /minute field/],
        ['*/5/2 * * * *', /minute field/],
        [`${'0,'.repeat(130)}0 * * * *`, /1 to 256 characters/],
    ])('rejects %j', (expression, message) => {
        expect(() => parseCron(expression)).toThrow(message);
    });
});

describe('nextCronTime in UTC', () => {
    test('every minute, every 15 minutes', () => {
        expect(chain('* * * * *', 'UTC', '2026-01-01T00:00:30Z', 2))
            .toStrictEqual(['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z']);
        expect(chain('*/15 * * * *', 'UTC', '2026-01-01T00:00:00Z', 2))
            .toStrictEqual(['2026-01-01T00:15:00.000Z', '2026-01-01T00:30:00.000Z']);
    });

    test('weekdays skip the weekend', () => {
        // 2026-01-02 is a Friday
        expect(chain('0 9 * * 1-5', 'UTC', '2026-01-02T09:00:00Z', 1)).toStrictEqual(['2026-01-05T09:00:00.000Z']);
    });

    test('day 31 skips the short months', () => {
        expect(chain('0 0 31 * *', 'UTC', '2026-01-31T00:00:00Z', 2))
            .toStrictEqual(['2026-03-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z']);
    });

    test('February 29: the leap years, and none in 2100', () => {
        expect(chain('0 0 29 2 *', 'UTC', '2026-01-01T00:00:00Z', 1)).toStrictEqual(['2028-02-29T00:00:00.000Z']);
        expect(chain('0 0 29 2 *', 'UTC', '2097-01-01T00:00:00Z', 1)).toStrictEqual(['2104-02-29T00:00:00.000Z']);
    });

    test('both day fields restricted: either matches; one with *: both', () => {
        // The 13th, or a Friday
        expect(chain('0 0 13 * 5', 'UTC', '2026-02-01T00:00:00Z', 3)).toStrictEqual([
            '2026-02-06T00:00:00.000Z', '2026-02-13T00:00:00.000Z', '2026-02-20T00:00:00.000Z',
        ]);
        // An odd day that is a Monday
        expect(chain('0 0 */2 * 1', 'UTC', '2026-01-01T00:00:00Z', 2))
            .toStrictEqual(['2026-01-05T00:00:00.000Z', '2026-01-19T00:00:00.000Z']);
    });

    test('a cron that never fires gives null', () => {
        expect(nextCronTime(parseCron('0 0 30 2 *'), 'UTC', at('2026-01-01T00:00:00Z'), 50 * YEAR_MS)).toBeNull();
    });

    test('no slot within the horizon gives null', () => {
        const spec = parseCron('0 0 29 2 *');

        expect(nextCronTime(spec, 'UTC', at('2096-03-01T00:00:00Z'), YEAR_MS)).toBeNull();
        expect(nextCronTime(spec, 'UTC', at('2096-03-01T00:00:00Z'))).toBe(at('2104-02-29T00:00:00Z'));
    });
});

describe('nextCronTime in Europe/Berlin, 2026', () => {
    const berlin = 'Europe/Berlin';

    test('spring forward: a time in the gap fires once, at the end of the gap', () => {
        expect(chain('30 2 * * *', berlin, '2026-03-28T12:00:00Z', 2))
            .toStrictEqual(['2026-03-29T01:00:00.000Z', '2026-03-30T00:30:00.000Z']);
    });

    test('spring forward: an every-hour spec skips the gap', () => {
        expect(chain('*/15 * * * *', berlin, '2026-03-29T00:30:00Z', 3))
            .toStrictEqual(['2026-03-29T00:45:00.000Z', '2026-03-29T01:00:00.000Z', '2026-03-29T01:15:00.000Z']);
        expect(chain('5 * * * *', berlin, '2026-03-29T00:00:00Z', 2))
            .toStrictEqual(['2026-03-29T00:05:00.000Z', '2026-03-29T01:05:00.000Z']);
    });

    test('fall back: an appointment fires at the first pass only', () => {
        expect(chain('30 2 * * *', berlin, '2026-10-24T12:00:00Z', 2))
            .toStrictEqual(['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
    });

    test('fall back: an every-hour spec fires at both passes', () => {
        expect(chain('30 * * * *', berlin, '2026-10-24T23:45:00Z', 2))
            .toStrictEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
        // From inside the second pass
        expect(chain('30 * * * *', berlin, '2026-10-25T01:10:00Z', 1)).toStrictEqual(['2026-10-25T01:30:00.000Z']);
    });

    test('fall back: */15 0-22 is not every hour: its 02:xx times run once', () => {
        expect(chain('*/15 0-22 * * *', berlin, '2026-10-24T23:50:00Z', 6)).toStrictEqual([
            '2026-10-25T00:00:00.000Z', '2026-10-25T00:15:00.000Z', '2026-10-25T00:30:00.000Z',
            '2026-10-25T00:45:00.000Z', '2026-10-25T02:00:00.000Z', '2026-10-25T02:15:00.000Z',
        ]);
    });
});

describe('nextCronTime in more zones', () => {
    test.each([
        ['0 9 * * *', 'America/New_York', '2026-03-07T15:00:00Z', ['2026-03-08T13:00:00.000Z']],
        ['30 2 * * *', 'America/New_York', '2026-03-08T00:00:00Z', ['2026-03-08T07:00:00.000Z']],
        ['0 9 * * *', 'Australia/Sydney', '2026-04-04T00:00:00Z', ['2026-04-04T23:00:00.000Z']],
        ['15 1 * * *', 'Australia/Lord_Howe', '2026-04-04T12:00:00Z', ['2026-04-04T14:15:00.000Z']],
        ['0 0 * * *', 'America/Santiago', '2026-09-05T12:00:00Z', ['2026-09-06T04:00:00.000Z']],
        ['45 2 * * *', 'Pacific/Chatham', '2026-09-26T00:00:00Z', ['2026-09-26T14:00:00.000Z']],
        ['0 9 * * *', 'Asia/Tokyo', '2026-01-01T00:00:00Z', ['2026-01-02T00:00:00.000Z']],
        ['0 9 * * *', 'UTC', '2026-01-01T00:00:00Z', ['2026-01-01T09:00:00.000Z']],
    ])('%s in %s after %s', (expression, timeZone, after, expected) => {
        expect(chain(expression, timeZone, after, 1)).toStrictEqual(expected);
    });
});

const PROPERTY_ZONES = [
    'Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe', 'America/Santiago', 'America/Havana',
    'America/Asuncion', 'Africa/Cairo', 'Antarctica/Troll', 'Pacific/Chatham', 'Australia/Sydney',
];
const PROPERTY_SPECS = [
    '30 2 * * *', '*/15 * * * *', '* * * * *', '0 * * * *', '*/30 * * * *', '0 */2 * * *', '45 1 * * *',
    '0 0 * * *', '30 23 * * *', '15 0 * * *', '0 3 * * 0', '*/7 1-3 * * *', '0,30 0-22 * * *', '59 23 * * *',
];

/**
 * @param {string} timeZone
 * @returns {number[]} The hours of 2026 that end with a change of the offset.
 */
function transitionsOf(timeZone) {
    const found = [];

    for (let hour = at('2026-01-01T00:00:00Z'); hour < at('2027-01-01T00:00:00Z'); hour += HOUR_MS) {
        if (offsetAt(hour, timeZone) !== offsetAt(hour + HOUR_MS, timeZone)) {
            found.push(hour);
        }
    }

    return found;
}

/**
 * @param {number[]} sorted
 * @param {number} after
 * @returns {number | null} The first value after `after`.
 */
function firstAfter(sorted, after) {
    let low = 0;
    let high = sorted.length;

    while (low < high) {
        const middle = (low + high) >> 1;

        if (sorted[middle] > after) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }

    return sorted[low] ?? null;
}

/**
 * Compares nextCronTime() with the oracle around each transition of 2026 in a zone: random starts within 2 days, and
 * the chain of slots over ±3 days (seeded).
 * @param {string} timeZone
 * @returns {{ mismatches: (string | null)[][], maxWalls: number }}
 */
function checkZone(timeZone) {
    /** @type {(string | null)[][]} */
    const mismatches = [];
    let maxWalls = 0;
    let seed = 11;
    const random = () => {
        seed = ((seed * 1_103_515_245) + 12_345) % (2 ** 31);

        return seed / (2 ** 31);
    };
    /**
     * @param {string} expression
     * @param {number[]} expected
     * @param {number} after
     * @param {number | null} got
     */
    const check = (expression, expected, after, got) => {
        const want = firstAfter(expected, after);

        if (want !== null && got !== want) {
            mismatches.push([expression, timeZone, iso(after), iso(got), iso(want)]);
        }
    };

    for (const transition of transitionsOf(timeZone)) {
        const from = transition - (3 * DAY_MS);

        for (const expression of PROPERTY_SPECS) {
            const spec = parseCron(expression);
            const expected = oracleSlots(spec, timeZone, from, transition + (3 * DAY_MS));

            for (let index = 0; index < 20; index++) {
                const after = transition - (2 * DAY_MS) + Math.floor(random() * 4 * DAY_MS);

                cronCounters.walls = 0;
                check(expression, expected, after, nextCronTime(spec, timeZone, after));
                maxWalls = Math.max(maxWalls, cronCounters.walls);
            }

            // Every minute: the random starts only, its chain is slow (8640 slots)
            if (expression === '* * * * *') {
                continue;
            }

            for (let current = from; firstAfter(expected, current) !== null;) {
                const got = nextCronTime(spec, timeZone, current);

                check(expression, expected, current, got);
                current = got === firstAfter(expected, current) ? /** @type {number} */ (got) : Infinity;
            }
        }
    }

    return { mismatches, maxWalls };
}

describe('property: the oracle around each transition of 2026', () => {
    test.each(PROPERTY_ZONES)('%s', (timeZone) => {
        const { mismatches, maxWalls } = checkZone(timeZone);

        expect(mismatches).toStrictEqual([]);
        expect(maxWalls).toBeLessThanOrEqual(150);
    }, 30_000);
});

/**
 * @param {string} expression
 * @param {string} timeZone
 * @param {number} from
 * @param {number} to
 * @returns {number[]} The slots of the chain of nextCronTime() from `from`, up to `to`.
 */
function slotsOf(expression, timeZone, from, to) {
    const spec = parseCron(expression);
    const slots = [];

    for (let current = from; current < to;) {
        current = /** @type {number} */ (nextCronTime(spec, timeZone, current));
        slots.push(current);
    }

    return slots;
}

describe('latestCronTime', () => {
    test.each([
        ['*/15 * * * *', 'UTC', '2026-01-01T10:20:00Z', '2026-01-01T10:15:00.000Z'],
        ['*/15 * * * *', 'UTC', '2026-01-01T10:15:00Z', '2026-01-01T10:15:00.000Z'],
        ['0 3 * * *', 'Europe/Berlin', '2026-06-10T00:00:00Z', '2026-06-09T01:00:00.000Z'],
        ['0 0 1 1 *', 'UTC', '2026-06-10T00:00:00Z', '2026-01-01T00:00:00.000Z'],
        ['0 0 29 2 *', 'UTC', '2027-06-10T00:00:00Z', '2024-02-29T00:00:00.000Z'],
        ['30 * * * *', 'Europe/Berlin', '2026-10-25T01:40:00Z', '2026-10-25T01:30:00.000Z'],
        ['30 2 * * *', 'Europe/Berlin', '2026-03-29T01:00:00Z', '2026-03-29T01:00:00.000Z'],
    ])('%s in %s at %s', (expression, timeZone, atIso, expected) => {
        expect(iso(latestCronTime(parseCron(expression), timeZone, at(atIso)))).toBe(expected);
    });

    test.each(['30 * * * *', '*/7 1-3 * * *', '30 2 * * *', '0 0 * * *'])(
        '%s: equals the last slot of the next chain, in Berlin around fall back',
        (expression) => {
            const spec = parseCron(expression);
            const slots = slotsOf(expression, 'Europe/Berlin', at('2026-10-23T00:00:00Z'), at('2026-10-27T00:00:00Z'));
            const checks = Array.from({ length: 412 }, (_, index) => at('2026-10-24T00:00:00Z') + (index * 7 * MINUTE_MS));

            expect(checks.map(atMs => latestCronTime(spec, 'Europe/Berlin', atMs)))
                .toStrictEqual(checks.map(atMs => slots.findLast(slot => slot <= atMs)));
            expect(previousCronTime(spec, 'Europe/Berlin', slots[2])).toBe(slots[1]);
        },
    );

    test('null when no slot is within the horizon', () => {
        expect(latestCronTime(parseCron('0 0 30 2 *'), 'UTC', at('2026-01-01T00:00:00Z'))).toBeNull();
    });
});
