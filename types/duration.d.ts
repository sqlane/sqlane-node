/**
 * Parses non-negative safe integer milliseconds, or decimal quantities with lowercase units in descending order
 * (`w`, `d`, `h`, `m`, `s`, `ms`), such as `'1.5h'`, `'4m30s'` or `'1d 1h 1ms'`. Spaces separate components only.
 * @param {unknown} value
 * @returns {number | null} The milliseconds, rounded. Null: not a duration, or negative.
 */
export declare function parseDuration(value: unknown): number | null;
