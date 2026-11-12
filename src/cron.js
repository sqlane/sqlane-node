// The cron expressions of schedules: 5 fields, parsed in-house, and their slots in a time zone. See docs/api.md ›
// schedule and docs/design.md › Schedules.
import { offsetAt, resolveWall, transitionNear, wallOf } from './time_zone.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const YEAR_MS = 366 * DAY_MS;
/** The search of a slot at runtime: a spec with no slot within it gives null */
export const RUNTIME_HORIZON_MS = 9 * YEAR_MS;
const MAX_EXPRESSION_LENGTH = 256;
/**
 * For tests: the wall times that nextCronTime() visited, to bound the work of a search. A test hook in the source: one
 * increment per wall time, nothing measurable next to the search itself.
 */
export const cronCounters = { walls: 0 };

const MACROS = new Map([
    ['@yearly', '0 0 1 1 *'],
    ['@annually', '0 0 1 1 *'],
    ['@monthly', '0 0 1 * *'],
    ['@weekly', '0 0 * * 0'],
    ['@daily', '0 0 * * *'],
    ['@midnight', '0 0 * * *'],
    ['@hourly', '0 * * * *'],
]);
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * @typedef {object} FieldRule
 * @property {string} label
 * @property {number} min
 * @property {number} max The largest explicit value. Day of week: 7, which is Sunday.
 * @property {number} starMax The end of `*` and `a/s`. Day of week: 6.
 * @property {readonly string[] | null} names Mapped to min, min + 1...
 */

/** @type {readonly FieldRule[]} */
const FIELDS = [
    { label: 'minute', min: 0, max: 59, starMax: 59, names: null },
    { label: 'hour', min: 0, max: 23, starMax: 23, names: null },
    { label: 'day of month', min: 1, max: 31, starMax: 31, names: null },
    { label: 'month', min: 1, max: 12, starMax: 12, names: MONTH_NAMES },
    { label: 'day of week', min: 0, max: 7, starMax: 6, names: WEEKDAY_NAMES },
];

/**
 * A parsed cron expression. The flags are indexed by value: minutes 0–59, hours 0–23, days 1–31, months 1–12,
 * weekdays 0–6 (7 is folded to 0).
 * @typedef {object} CronSpec
 * @property {Uint8Array} minutes
 * @property {Uint8Array} hours
 * @property {Uint8Array} days
 * @property {Uint8Array} months
 * @property {Uint8Array} weekdays
 * @property {boolean} daysStar The day-of-month field starts with `*`.
 * @property {boolean} weekdaysStar The day-of-week field starts with `*`.
 * @property {boolean} everyHour All 24 hours: the DST rules of elapsed time.
 * @property {string} normalized The canonical form: equal for equal crons.
 */

/**
 * @param {string} text
 * @param {FieldRule} rule
 * @returns {number}
 */
function parseValue(text, rule) {
    if (/^\d{1,2}$/.test(text)) {
        const value = Number(text);

        if (value < rule.min || value > rule.max) {
            throw new Error(`the ${rule.label} field: ${value} is not within ${rule.min}-${rule.max}`);
        }

        return value;
    }

    const index = rule.names?.indexOf(text.toUpperCase()) ?? -1;

    if (index === -1) {
        const unsupported = /[LW#?H]/i.test(text) && !/^[a-z]{3}$/i.test(text);

        throw new Error(unsupported
            ? `the ${rule.label} field: ${JSON.stringify(text)} is not supported (no L, W, #, ? or H)`
            : `the ${rule.label} field: ${JSON.stringify(text)} is not a value`);
    }

    return rule.min + index;
}

/**
 * @param {string} item One item of a comma list.
 * @param {FieldRule} rule
 * @param {Uint8Array} flags Set in place.
 */
function parseItem(item, rule, flags) {
    const [range, stepText, extra] = item.split('/');

    if (extra !== undefined || range === '') {
        throw new Error(`the ${rule.label} field: ${JSON.stringify(item)} is not an item`);
    }

    let step = 1;

    if (stepText !== undefined) {
        if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1) {
            throw new Error(`the ${rule.label} field: the step of ${JSON.stringify(item)} must be at least 1`);
        }

        step = Number(stepText);
    }

    let start;
    let end;

    if (range === '*') {
        start = rule.min;
        end = rule.starMax;
    } else if (range.includes('-')) {
        const [startText, endText, more] = range.split('-');

        if (more !== undefined || !startText || !endText) {
            throw new Error(`the ${rule.label} field: ${JSON.stringify(item)} is not a range`);
        }

        start = parseValue(startText, rule);
        end = parseValue(endText, rule);

        if (start > end) {
            throw new Error(`the ${rule.label} field: the range ${JSON.stringify(range)} goes backwards`);
        }
    } else {
        start = parseValue(range, rule);
        // `a/s` runs from a to the end
        end = stepText === undefined ? start : Math.max(rule.starMax, start);
    }

    for (let value = start; value <= end; value += step) {
        flags[value] = 1;
    }
}

/**
 * @param {Uint8Array} flags
 * @param {number} min
 * @param {number} max
 * @returns {string} A sorted comma list of values and ranges.
 */
function listOf(flags, min, max) {
    const parts = [];

    for (let value = min; value <= max; value++) {
        if (!flags[value]) {
            continue;
        }

        let end = value;

        while (end < max && flags[end + 1]) {
            end++;
        }

        parts.push(end === value ? String(value) : `${value}-${end}`);
        value = end;
    }

    return parts.join(',');
}

/**
 * @param {Uint8Array} flags
 * @param {number} min
 * @param {number} max
 * @returns {number} The step s when the values are exactly min, min + s, min + 2s...; else 0.
 */
function stepOf(flags, min, max) {
    let step = 0;

    for (let value = min + 1; value <= max; value++) {
        if (flags[value]) {
            step = value - min;
            break;
        }
    }

    if (!flags[min] || step < 2) {
        return 0;
    }

    for (let value = min; value <= max; value++) {
        if (Boolean(flags[value]) !== ((value - min) % step === 0)) {
            return 0;
        }
    }

    return step;
}

/**
 * @param {Uint8Array} flags
 * @param {FieldRule} rule
 * @param {boolean} dayField
 * @param {boolean} star The field starts with `*`.
 * @returns {string} The canonical form of the field. A day field keeps its `*` marker: the day rule depends on it.
 */
function normalizeField(flags, rule, dayField, star) {
    const max = rule.starMax;
    const list = listOf(flags, rule.min, max);
    const full = list === `${rule.min}-${max}`;

    if (!dayField) {
        return full ? '*' : list;
    }

    if (!star) {
        return list;
    }

    if (full) {
        return '*';
    }

    const step = stepOf(flags, rule.min, max);

    return step ? `*/${step}` : `*:${list}`;
}

/**
 * Parses a cron expression of 5 fields: minute, hour, day of month, month, day of week.
 * @param {string} expression
 * @returns {CronSpec}
 * @throws {Error} Its message names the field.
 */
export function parseCron(expression) {
    if (typeof expression !== 'string') {
        throw new TypeError('the cron must be a string');
    }

    const trimmed = expression.trim();

    if (!trimmed || trimmed.length > MAX_EXPRESSION_LENGTH) {
        throw new Error(`the cron must have 1 to ${MAX_EXPRESSION_LENGTH} characters`);
    }

    let text = trimmed;

    if (text.startsWith('@')) {
        const macro = MACROS.get(text.toLowerCase());

        if (!macro) {
            throw new Error(`the macro ${JSON.stringify(text)} is not supported`);
        }

        text = macro;
    }

    const fields = text.split(/[ \t]+/);

    if (fields.length === 6) {
        throw new Error('seconds are not supported: use "every" for less than a minute');
    }

    if (fields.length !== 5) {
        throw new Error(`the cron must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
    }

    const flags = FIELDS.map((rule, index) => {
        const field = new Uint8Array(rule.max + 1);

        for (const item of fields[index].split(',')) {
            parseItem(item, rule, field);
        }

        return field;
    });
    const [minutes, hours, days, months, weekdays] = flags;

    // Sunday: 0 and 7
    if (weekdays[7]) {
        weekdays[0] = 1;
    }

    const daysStar = fields[2].startsWith('*');
    const weekdaysStar = fields[4].startsWith('*');
    const normalized = FIELDS
        .map((rule, index) => normalizeField(flags[index], rule, index === 2 || index === 4, fields[index].startsWith('*')))
        .join(' ');

    return {
        minutes,
        hours,
        days,
        months,
        weekdays: weekdays.subarray(0, 7),
        daysStar,
        weekdaysStar,
        everyHour: hours.every(Boolean),
        normalized,
    };
}

/**
 * @param {Uint8Array} flags
 * @param {number} from
 * @param {number} max
 * @returns {number} The first set value from `from`, or -1.
 */
function nextSet(flags, from, max) {
    for (let value = from; value <= max; value++) {
        if (flags[value]) {
            return value;
        }
    }

    return -1;
}

/**
 * The day rule: with both day fields restricted (no leading `*`), either one matches; else both.
 * @param {CronSpec} spec
 * @param {number} year
 * @param {number} month 1–12.
 * @param {number} day
 * @returns {boolean}
 */
function dayMatches(spec, year, month, day) {
    const weekday = (Math.floor(Date.UTC(year, month - 1, day) / DAY_MS) + 4) % 7;
    const byDay = spec.days[day] === 1;
    const byWeekday = spec.weekdays[(weekday + 7) % 7] === 1;

    if (!spec.daysStar && !spec.weekdaysStar) {
        return byDay || byWeekday;
    }

    return byDay && byWeekday;
}

/**
 * @param {number} year
 * @param {number} month 1–12.
 * @returns {number}
 */
function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The first matching wall time at or after L, in whole minutes: the carry search over the fields.
 * @param {CronSpec} spec
 * @param {number} localMs
 * @param {number} limitMs Null past this wall time.
 * @returns {number | null}
 */
function nextWall(spec, localMs, limitMs) {
    const start = new Date(Math.ceil(localMs / MINUTE_MS) * MINUTE_MS);
    let year = start.getUTCFullYear();
    let month = start.getUTCMonth() + 1;
    let day = start.getUTCDate();
    let hour = start.getUTCHours();
    let minute = start.getUTCMinutes();

    for (;;) {
        if (Date.UTC(year, month - 1, day, hour, minute) > limitMs) {
            return null;
        }

        const nextMonth = nextSet(spec.months, month, 12);

        if (nextMonth === -1) {
            year++;
            month = 1;
            day = 1;
            hour = 0;
            minute = 0;
            continue;
        }

        if (nextMonth !== month) {
            month = nextMonth;
            day = 1;
            hour = 0;
            minute = 0;
        }

        if (day > daysInMonth(year, month)) {
            month++;

            if (month > 12) {
                month = 1;
                year++;
            }

            day = 1;
            hour = 0;
            minute = 0;
            continue;
        }

        if (!dayMatches(spec, year, month, day)) {
            day++;
            hour = 0;
            minute = 0;
            continue;
        }

        const nextHour = nextSet(spec.hours, hour, 23);

        if (nextHour === -1) {
            day++;
            hour = 0;
            minute = 0;
            continue;
        }

        if (nextHour !== hour) {
            hour = nextHour;
            minute = 0;
        }

        const nextMinute = nextSet(spec.minutes, minute, 59);

        if (nextMinute === -1) {
            hour++;
            minute = 0;

            if (hour > 23) {
                hour = 0;
                day++;
            }

            continue;
        }

        return Date.UTC(year, month - 1, day, hour, nextMinute);
    }
}

/**
 * The instants of a matching wall time, by the sqlane rule: a spec of every hour fires at both passes of a repeated
 * hour and skips a skipped one; any other spec fires at the first pass, and at the end of a skipped hour.
 * @param {CronSpec} spec
 * @param {number} wall
 * @param {string} timeZone
 * @returns {number[]}
 */
function slotsOfWall(spec, wall, timeZone) {
    const resolved = resolveWall(wall, timeZone);

    if ('gapEnd' in resolved) {
        return spec.everyHour ? [] : [resolved.gapEnd];
    }

    return spec.everyHour ? resolved.instants : [resolved.instants[0]];
}

/**
 * The first slot after an instant.
 * @param {CronSpec} spec
 * @param {string} timeZone
 * @param {number} afterMs
 * @param {number} [horizonMs] Null when no slot comes within it. Default: 9 years.
 * @returns {number | null}
 */
export function nextCronTime(spec, timeZone, afterMs, horizonMs = RUNTIME_HORIZON_MS) {
    const start = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS;
    const utc = timeZone === 'UTC';
    const offsetBefore = utc ? 0 : offsetAt(start - DAY_MS, timeZone);
    const offsetAfter = utc ? 0 : offsetAt(start + DAY_MS, timeZone);
    const maxOffset = Math.max(offsetBefore, offsetAfter);
    let back = 0;

    // A fall-back is near. Inside its repeated period, the walls of the second pass come before the start wall.
    if (offsetBefore > offsetAfter && Math.abs(start - transitionNear(start, timeZone)) < offsetBefore - offsetAfter) {
        back = offsetBefore - offsetAfter;
    }

    const limit = wallOf(afterMs, timeZone) + horizonMs;
    let localMs = wallOf(start, timeZone) - back;
    /** @type {number | null} */
    let best = null;

    for (;;) {
        cronCounters.walls++;

        const wall = nextWall(spec, localMs, limit);

        if (wall === null || (best !== null && wall - maxOffset > best)) {
            return best;
        }

        for (const slot of utc ? [wall] : slotsOfWall(spec, wall, timeZone)) {
            if (slot > afterMs && (best === null || slot < best)) {
                best = slot;
            }
        }

        if (best !== null && utc) {
            return best;
        }

        localMs = wall + MINUTE_MS;
    }
}

/** The windows of latestCronTime(), widened one after the other */
const LATEST_WINDOWS_MS = [MINUTE_MS, 3_600_000, DAY_MS, 32 * DAY_MS, YEAR_MS, RUNTIME_HORIZON_MS];

/**
 * The last slot at or before an instant.
 * @param {CronSpec} spec
 * @param {string} timeZone
 * @param {number} atMs
 * @returns {number | null}
 */
export function latestCronTime(spec, timeZone, atMs) {
    for (const windowMs of LATEST_WINDOWS_MS) {
        const horizonMs = windowMs + DAY_MS;
        let low = atMs - windowMs;

        if (!(Number(nextCronTime(spec, timeZone, low, horizonMs) ?? Infinity) <= atMs)) {
            continue;
        }

        // A slot is in (low, high]: narrow it down to one minute, which holds at most one slot
        let high = atMs;

        while (high - low > MINUTE_MS) {
            const middle = Math.floor((low + high) / 2);

            if (Number(nextCronTime(spec, timeZone, middle, horizonMs) ?? Infinity) <= atMs) {
                low = middle;
            } else {
                high = middle;
            }
        }

        let slot = /** @type {number} */ (nextCronTime(spec, timeZone, low, horizonMs));

        for (;;) {
            const next = nextCronTime(spec, timeZone, slot, horizonMs);

            if (next === null || next > atMs) {
                return slot;
            }

            slot = next;
        }
    }

    return null;
}

/**
 * The slot before a slot: the catch-up reach counts from it.
 * @param {CronSpec} spec
 * @param {string} timeZone
 * @param {number} slotMs
 * @returns {number | null}
 */
export function previousCronTime(spec, timeZone, slotMs) {
    return latestCronTime(spec, timeZone, slotMs - 1);
}
