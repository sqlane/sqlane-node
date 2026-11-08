/** MySQL: deadlock, lock wait timeout. PostgreSQL: serialization failure, deadlock. Prisma: a conflict, a deadlock. */
const TRANSIENT_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', '40001', '40P01', 'P2034']);
const TRANSIENT_ERRNOS = new Set([1205, 1213]);
/** The kind of an error of a Prisma driver adapter */
const TRANSIENT_KINDS = new Set(['TransactionWriteConflict']);

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
export function isTransientDbError(error) {
    /** @type {unknown[]} */
    const pending = [error];

    for (let depth = 0; pending.length && depth < 10; depth++) {
        const current = /** @type {ErrorFields | null | undefined} */ (pending.shift());

        if (!current) {
            continue;
        }

        const { code, errno, originalCode, kind, cause, meta } = current;

        if (TRANSIENT_CODES.has(String(code)) || TRANSIENT_ERRNOS.has(Number(errno))
            || TRANSIENT_CODES.has(String(originalCode)) || TRANSIENT_ERRNOS.has(Number(originalCode))
            || TRANSIENT_KINDS.has(String(kind))) {
            return true;
        }

        pending.push(cause, meta?.driverAdapterError);
    }

    return false;
}
