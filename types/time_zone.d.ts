/**
 * @param {unknown} timeZone
 * @returns {boolean} Intl knows the zone.
 */
export declare function isTimeZone(timeZone: unknown): boolean;
/**
 * The name of a zone in its usual case: `'utc'` gives `'UTC'`, `'europe/berlin'` gives `'Europe/Berlin'`. The UTC
 * aliases give `'UTC'`, the fast path. Other aliases stay as given: the canonical name of an alias differs between the
 * ICU versions of Node.js, and the spec of a schedule must be the same in every process.
 * @param {string} timeZone Known to Intl.
 * @returns {string}
 */
export declare function normalizeTimeZoneCase(timeZone: string): string;
/**
 * The wall-clock time of an instant in a zone, as "local milliseconds": `Date.UTC` of its parts.
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
export declare function wallOf(ms: number, timeZone: string): number;
/**
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number} The offset of the zone at the instant: wall time minus UTC.
 */
export declare function offsetAt(ms: number, timeZone: string): number;
/**
 * The transition near an instant: the first instant of [ms − 1 day, ms + 1 day] that has the offset of ms + 1 day, in
 * whole seconds. The zone has at most one transition in the window.
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
export declare function transitionNear(ms: number, timeZone: string): number;
/**
 * The instants of a wall-clock time: one, two in a repeated hour (ascending), or none in a skipped hour. Then
 * `gapEnd` is the first instant after the gap.
 * @param {number} localMs
 * @param {string} timeZone
 * @returns {{ instants: number[] } | { gapEnd: number }}
 */
export declare function resolveWall(localMs: number, timeZone: string): {
    instants: number[];
} | {
    gapEnd: number;
};
