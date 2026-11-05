const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const PART_REGEXP = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gy;

/**
 * Parses a duration: milliseconds (a non-negative safe integer), or a string of parts such as `'500ms'`, `'5s'`,
 * `'1.5h'`, `'4m30s'`.
 * @param {unknown} value
 * @returns {number | null} The milliseconds, rounded. Null: not a duration.
 */
export function parseDuration(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }

    if (typeof value !== 'string' || !value) {
        return null;
    }

    PART_REGEXP.lastIndex = 0;

    let ms = 0;

    while (PART_REGEXP.lastIndex < value.length) {
        const match = PART_REGEXP.exec(value);

        if (!match) {
            return null;
        }

        ms += Number(match[1]) * UNIT_MS[/** @type {keyof typeof UNIT_MS} */ (match[2])];
    }

    const rounded = Math.round(ms);

    return Number.isSafeInteger(rounded) ? rounded : null;
}
