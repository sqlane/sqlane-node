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
 * @property {{ driverAdapterError?: unknown, code?: unknown }} [meta] Prisma: the error of its driver adapter; the code
 *     of the database (raw queries).
 * @property {unknown} [original] Sequelize: the error of the driver.
 * @property {unknown} [parent] Sequelize: the error of the driver.
 * @property {unknown} [driverError] TypeORM: the error of the driver.
 */

/**
 * Looks through the error, its causes, and the errors of the drivers that ORMs wrap.
 * @param {unknown} error
 * @param {(fields: ErrorFields) => boolean} predicate
 * @returns {boolean} One of them matches.
 */
function someError(error, predicate) {
    /** @type {unknown[]} */
    const pending = [error];
    const seen = new Set();

    for (let depth = 0; pending.length && depth < 20; depth++) {
        const current = /** @type {ErrorFields | null | undefined} */ (pending.shift());

        if (!current || typeof current !== 'object' || seen.has(current)) {
            continue;
        }

        seen.add(current);

        if (predicate(current)) {
            return true;
        }

        pending.push(current.cause, current.meta?.driverAdapterError, current.original, current.parent,
            current.driverError);
    }

    return false;
}

/**
 * @param {ErrorFields} fields
 * @param {{ codes: Set<string>, errnos: Set<number>, kinds: Set<string> }} sets
 * @returns {boolean}
 */
function matches({ code, errno, originalCode, kind, meta }, { codes, errnos, kinds }) {
    return codes.has(String(code)) || errnos.has(Number(errno)) || codes.has(String(originalCode))
        || errnos.has(Number(originalCode)) || kinds.has(String(kind)) || codes.has(String(meta?.code))
        || errnos.has(Number(meta?.code));
}

/**
 * A database error that a retry of the same work can pass: the transaction lost a lock race. Looks through the causes,
 * and through the error of a Prisma driver adapter.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientDbError(error) {
    return someError(error, fields => matches(fields, {
        codes: TRANSIENT_CODES,
        errnos: TRANSIENT_ERRNOS,
        kinds: TRANSIENT_KINDS,
    }));
}
