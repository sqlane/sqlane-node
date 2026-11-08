/**
 * Parses a duration: milliseconds (a non-negative safe integer), or a string that parse-duration reads, such as
 * `'500ms'`, `'5s'`, `'1.5h'`, `'4m30s'`, `'2 days'`.
 * @param {unknown} value
 * @returns {number | null} The milliseconds, rounded. Null: not a duration, or negative.
 */
export declare function parseDuration(value: unknown): number | null;
