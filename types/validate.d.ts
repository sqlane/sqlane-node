/** A name of a lane or of a limit: no `:` (the job id is `<lane>:<dedupeKey>`), lowercase. */
export declare const NAME_REGEXP: RegExp;
/** A table prefix: the longest table name, `<prefix>migrations`, stays within the 63 characters of PostgreSQL. */
export declare const TABLE_PREFIX_REGEXP: RegExp;
/** Printable ASCII, no space at the ends: MySQL `ascii_bin` ignores trailing spaces in comparisons. */
export declare const PRINTABLE_ID_REGEXP: RegExp;
export type Scope = {
    /**
     * E.g. `defineLane("build_report")`.
     */
    where: string;
    ErrorClass: new (message: string) => Error;
};
/**
 * Where a check runs: for the error message and its class.
 * @typedef {object} Scope
 * @property {string} where E.g. `defineLane("build_report")`.
 * @property {new (message: string) => Error} ErrorClass
 */
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
/**
 * Throws if the value is not an object with only the allowed keys.
 * @param {unknown} value
 * @param {readonly string[]} allowedKeys
 * @param {string} label E.g. `"options"`.
 * @param {Scope} scope
 * @returns {Record<string, unknown>}
 */
export declare function checkObject(value: unknown, allowedKeys: readonly string[], label: string, { where, ErrorClass }: Scope): Record<string, unknown>;
/**
 * @param {unknown} value
 * @param {string} label
 * @param {Scope} scope
 * @param {number} [min] Default: 1.
 */
export declare function checkInteger(value: unknown, label: string, { where, ErrorClass }: Scope, min?: number): void;
/**
 * @param {unknown} value
 * @param {string} label
 * @param {Scope} scope
 * @param {boolean} [positive] Default: false: 0 is a duration.
 * @returns {number} Milliseconds.
 */
export declare function checkDuration(value: unknown, label: string, { where, ErrorClass }: Scope, positive?: boolean): number;
/**
 * @param {unknown} value
 * @param {Scope} scope
 */
export declare function checkBackoff(value: unknown, scope: Scope): void;
/**
 * @param {unknown} value
 * @param {Scope} scope
 */
export declare function checkRetention(value: unknown, scope: Scope): void;
/**
 * Checks the options that a definition, the instance defaults and an enqueue share.
 * @param {Record<string, unknown>} options
 * @param {Scope} scope
 */
export declare function checkOptionFields(options: Record<string, unknown>, scope: Scope): void;
/**
 * @param {unknown} value A name, or a definition.
 * @param {string} lane The lane that names it.
 * @param {Scope} scope
 * @returns {string} The failure lane.
 */
export declare function checkFailureLane(value: unknown, lane: string, { where, ErrorClass }: Scope): string;
/**
 * @param {unknown} tablePrefix
 * @param {Scope} scope
 */
export declare function checkTablePrefix(tablePrefix: unknown, { where, ErrorClass }: Scope): void;
