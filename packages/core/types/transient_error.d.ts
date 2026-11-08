export type ErrorFields = {
    code?: unknown;
    errno?: unknown;
    /**
     * Prisma: the code of the database.
     */
    originalCode?: unknown;
    /**
     * Prisma: the kind of the error of its driver adapter.
     */
    kind?: unknown;
    cause?: unknown;
    /**
     * Prisma: the error of its driver adapter.
     */
    meta?: {
        driverAdapterError?: unknown;
    };
};
/**
 * @typedef {object} ErrorFields
 * @property {unknown} [code]
 * @property {unknown} [errno]
 * @property {unknown} [originalCode] Prisma: the code of the database.
 * @property {unknown} [kind] Prisma: the kind of the error of its driver adapter.
 * @property {unknown} [cause]
 * @property {{ driverAdapterError?: unknown }} [meta] Prisma: the error of its driver adapter.
 */
/**
 * A database error that a retry of the same work can pass: the transaction lost a lock race. Looks through the causes,
 * and through the error of a Prisma driver adapter.
 * @param {unknown} error
 * @returns {boolean}
 */
export declare function isTransientDbError(error: unknown): boolean;
