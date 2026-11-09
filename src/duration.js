const UNITS = /** @type {const} */ ({ w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 });

/**
 * Parses non-negative safe integer milliseconds, or decimal quantities with lowercase units in descending order
 * (`w`, `d`, `h`, `m`, `s`, `ms`), such as `'1.5h'`, `'4m30s'` or `'1d 1h 1ms'`. Spaces separate components only.
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

    const token = / *(\d+(?:\.\d+)?|\.\d+)(ms|[wdhms]) */y;
    let cursor = 0;
    let previousUnit = Infinity;
    let ms = 0;

    do {
        token.lastIndex = cursor;
        const match = token.exec(value);

        if (!match) {
            return null;
        }

        const unit = UNITS[/** @type {keyof typeof UNITS} */ (match[2])];

        if (unit >= previousUnit) {
            return null;
        }

        ms += Number(match[1]) * unit;
        previousUnit = unit;
        cursor = token.lastIndex;
    }
    while (cursor < value.length);

    const rounded = Math.round(ms);

    return Number.isSafeInteger(rounded) ? rounded : null;
}
