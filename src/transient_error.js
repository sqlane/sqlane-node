/** MySQL: deadlock, lock wait timeout. PostgreSQL: serialization failure, deadlock. */
const TRANSIENT_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', '40001', '40P01']);
const TRANSIENT_ERRNOS = new Set([1205, 1213]);

/**
 * A database error that a retry of the same work can pass: the transaction lost a lock race.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientDbError(error) {
    for (let current = error, depth = 0; current && depth < 5; depth++) {
        const { code, errno, cause } = /** @type {{ code?: unknown, errno?: unknown, cause?: unknown }} */ (current);

        if (TRANSIENT_CODES.has(String(code)) || TRANSIENT_ERRNOS.has(Number(errno))) {
            return true;
        }

        current = cause;
    }

    return false;
}
