export type ErrorFields = {
    name?: unknown;
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
     * Prisma: the error of its driver adapter; the code
     * of the database (raw queries).
     */
    meta?: {
        driverAdapterError?: unknown;
        code?: unknown;
    };
    /**
     * Sequelize: the error of the driver.
     */
    original?: unknown;
    /**
     * Sequelize: the error of the driver.
     */
    parent?: unknown;
    /**
     * TypeORM: the error of the driver.
     */
    driverError?: unknown;
};
/**
 * A database error that a retry of the same work can pass: the transaction lost a lock race. Looks through the causes,
 * and through the error of a Prisma driver adapter.
 * @param {unknown} error
 * @returns {boolean}
 */
export declare function isTransientDbError(error: unknown): boolean;
/**
 * A table is missing: `migrate()` has not run.
 * @param {unknown} error
 * @returns {boolean}
 */
export declare function isMissingTableError(error: unknown): boolean;
/**
 * The database cannot be reached, or the pool gives no connection: other work fails the same way.
 * @param {unknown} error
 * @returns {boolean}
 */
export declare function isConnectionError(error: unknown): boolean;
