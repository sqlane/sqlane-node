import parse from 'parse-duration';

/**
 * Parses a duration: milliseconds (a non-negative safe integer), or a string that parse-duration reads, such as
 * `'500ms'`, `'5s'`, `'1.5h'`, `'4m30s'`, `'2 days'`.
 * @param {unknown} value
 * @returns {number | null} The milliseconds, rounded. Null: not a duration, or negative.
 */
export function parseDuration(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }

    if (typeof value !== 'string') {
        return null;
    }

    const ms = parse(value);

    if (typeof ms !== 'number' || !(ms >= 0)) {
        return null;
    }

    const rounded = Math.round(ms);

    return Number.isSafeInteger(rounded) ? rounded : null;
}
