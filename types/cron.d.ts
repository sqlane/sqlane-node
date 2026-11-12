/** The search of a slot at runtime: a spec with no slot within it gives null */
export declare const RUNTIME_HORIZON_MS: number;
/**
 * For tests: the wall times that nextCronTime() visited, to bound the work of a search. A test hook in the source: one
 * increment per wall time, nothing measurable next to the search itself.
 */
export declare const cronCounters: {
    walls: number;
};
export type FieldRule = {
    label: string;
    min: number;
    /**
     * The largest explicit value. Day of week: 7, which is Sunday.
     */
    max: number;
    /**
     * The end of `*` and `a/s`. Day of week: 6.
     */
    starMax: number;
    /**
     * Mapped to min, min + 1...
     */
    names: readonly string[] | null;
};
export type CronSpec = {
    minutes: Uint8Array;
    hours: Uint8Array;
    days: Uint8Array;
    months: Uint8Array;
    weekdays: Uint8Array;
    /**
     * The day-of-month field starts with `*`.
     */
    daysStar: boolean;
    /**
     * The day-of-week field starts with `*`.
     */
    weekdaysStar: boolean;
    /**
     * All 24 hours: the DST rules of elapsed time.
     */
    everyHour: boolean;
    /**
     * The canonical form: equal for equal crons.
     */
    normalized: string;
};
/**
 * Parses a cron expression of 5 fields: minute, hour, day of month, month, day of week.
 * @param {string} expression
 * @returns {CronSpec}
 * @throws {Error} Its message names the field.
 */
export declare function parseCron(expression: string): CronSpec;
/**
 * The first slot after an instant.
 * @param {CronSpec} spec
 * @param {string} timeZone
 * @param {number} afterMs
 * @param {number} [horizonMs] Null when no slot comes within it. Default: 9 years.
 * @returns {number | null}
 */
export declare function nextCronTime(spec: CronSpec, timeZone: string, afterMs: number, horizonMs?: number): number | null;
/**
 * The last slot at or before an instant.
 * @param {CronSpec} spec
 * @param {string} timeZone
 * @param {number} atMs
 * @returns {number | null}
 */
export declare function latestCronTime(spec: CronSpec, timeZone: string, atMs: number): number | null;
/**
 * The slot before a slot: the catch-up reach counts from it.
 * @param {CronSpec} spec
 * @param {string} timeZone
 * @param {number} slotMs
 * @returns {number | null}
 */
export declare function previousCronTime(spec: CronSpec, timeZone: string, slotMs: number): number | null;
