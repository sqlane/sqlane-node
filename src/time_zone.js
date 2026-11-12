// Wall-clock times of an IANA time zone, from Intl: the slots of a cron in a time zone. See docs/design.md › Schedules.

const DAY_MS = 86_400_000;

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();

/**
 * The cached formatter of a zone. `hourCycle: 'h23'`, not `hour12: false`: some ICU versions print midnight as `24`.
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function formatOf(timeZone) {
    let format = formats.get(timeZone);

    if (!format) {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
        });
        formats.set(timeZone, format);
    }

    return format;
}

/**
 * @param {unknown} timeZone
 * @returns {boolean} Intl knows the zone.
 */
export function isTimeZone(timeZone) {
    if (typeof timeZone !== 'string' || !timeZone) {
        return false;
    }

    try {
        formatOf(timeZone);

        return true;
    } catch {
        return false;
    }
}

/**
 * The name of a zone in its usual case: `'utc'` gives `'UTC'`, `'europe/berlin'` gives `'Europe/Berlin'`. The UTC
 * aliases give `'UTC'`, the fast path. Other aliases stay as given: the canonical name of an alias differs between the
 * ICU versions of Node.js, and the spec of a schedule must be the same in every process.
 * @param {string} timeZone Known to Intl.
 * @returns {string}
 */
export function normalizeTimeZoneCase(timeZone) {
    const resolved = formatOf(timeZone).resolvedOptions().timeZone;

    return resolved === 'UTC' || resolved.toLowerCase() === timeZone.toLowerCase() ? resolved : timeZone;
}

/**
 * The wall-clock time of an instant in a zone, as "local milliseconds": `Date.UTC` of its parts.
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
export function wallOf(ms, timeZone) {
    if (timeZone === 'UTC') {
        return ms;
    }

    const seconds = Math.floor(ms / 1000) * 1000;
    let year = 0;
    let month = 0;
    let day = 0;
    let hour = 0;
    let minute = 0;
    let second = 0;

    for (const { type, value } of formatOf(timeZone).formatToParts(seconds)) {
        switch (type) {
            case 'year':
                year = Number(value);
                break;
            case 'month':
                month = Number(value);
                break;
            case 'day':
                day = Number(value);
                break;
            case 'hour':
                hour = Number(value);
                break;
            case 'minute':
                minute = Number(value);
                break;
            case 'second':
                second = Number(value);
                break;
            default:
                break;
        }
    }

    return Date.UTC(year, month - 1, day, hour, minute, second) + (ms - seconds);
}

/**
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number} The offset of the zone at the instant: wall time minus UTC.
 */
export function offsetAt(ms, timeZone) {
    return wallOf(ms, timeZone) - ms;
}

/**
 * The transition near an instant: the first instant of [ms − 1 day, ms + 1 day] that has the offset of ms + 1 day, in
 * whole seconds. The zone has at most one transition in the window.
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
export function transitionNear(ms, timeZone) {
    const offsetAfter = offsetAt(ms + DAY_MS, timeZone);
    let low = ms - DAY_MS;
    let high = ms + DAY_MS;

    while (high - low > 1000) {
        const middle = Math.floor((low + high) / 2000) * 1000;

        if (offsetAt(middle, timeZone) === offsetAfter) {
            high = middle;
        } else {
            low = middle;
        }
    }

    return high;
}

/**
 * The instants of a wall-clock time: one, two in a repeated hour (ascending), or none in a skipped hour. Then
 * `gapEnd` is the first instant after the gap.
 * @param {number} localMs
 * @param {string} timeZone
 * @returns {{ instants: number[] } | { gapEnd: number }}
 */
export function resolveWall(localMs, timeZone) {
    if (timeZone === 'UTC') {
        return { instants: [localMs] };
    }

    const offsetBefore = offsetAt(localMs - DAY_MS, timeZone);
    const offsetAfter = offsetAt(localMs + DAY_MS, timeZone);
    const first = localMs - Math.max(offsetBefore, offsetAfter);
    const second = localMs - Math.min(offsetBefore, offsetAfter);
    const instants = [];

    if (wallOf(first, timeZone) === localMs) {
        instants.push(first);
    }

    if (second !== first && wallOf(second, timeZone) === localMs) {
        instants.push(second);
    }

    if (instants.length) {
        return { instants };
    }

    return { gapEnd: transitionNear(localMs - offsetBefore, timeZone) };
}
