/**
 * The version of this package. Read from its package.json on the first call, never at import.
 * @returns {string}
 */
export declare function installedVersion(): string;
/**
 * @param {unknown} value
 * @returns {number[] | null} The major, minor and patch. Null: not 'X.Y.Z'.
 */
export declare function parseVersion(value: unknown): number[] | null;
/**
 * @param {string} a 'X.Y.Z'.
 * @param {string} b 'X.Y.Z'.
 * @returns {number} Negative: a is below b; 0: equal; positive: a is above b.
 */
export declare function compareVersions(a: string, b: string): number;
/**
 * An installed pre-release counts as its base version: `8.0.0-rc.1` is `8.0.0`.
 * @param {string} version
 * @returns {string}
 */
export declare function baseVersion(version: string): string;
