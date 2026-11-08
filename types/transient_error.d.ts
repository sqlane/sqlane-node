/**
 * A database error that a retry of the same work can pass: the transaction lost a lock race.
 * @param {unknown} error
 * @returns {boolean}
 */
export declare function isTransientDbError(error: unknown): boolean;
