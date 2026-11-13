import { describe, expect, test, vi } from 'vitest';
import { createStore } from './store.js';

/**
 * A store on a fake adapter. The claim statement fails with `claimError` while it sets innodb_snapshot_isolation.
 * @param {import('../types.js').Dialect} dialect
 * @param {unknown} claimError
 * @returns {{ claims: string[], claimDue: () => Promise<unknown>, logger: Record<string, import('vitest').Mock>,
 *     transactions: () => number }}
 */
function storeWith(dialect, claimError) {
    /** @type {string[]} */
    const claims = [];
    let transactions = 0;
    const executor = {
        query: async (/** @type {string} */ sql) => {
            if (sql.includes('SKIP LOCKED')) {
                claims.push(sql);

                if (sql.includes('innodb_snapshot_isolation')) {
                    throw claimError;
                }
            }

            return [];
        },
        run: async () => 0,
    };
    const adapter = /** @type {import('../types.js').Adapter<any>} */ (/** @type {unknown} */ ({
        dialect,
        queue: executor,
        queueTransaction: async (/** @type {(e: typeof executor) => Promise<unknown>} */ func) => {
            transactions++;

            return func(executor);
        },
    }));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = createStore(adapter, 'sqlane_', logger);
    const claimDue = () => store.claimDue({
        requests: [{ name: 'a', maxJobs: 5, running: 0, weight: 1, group: null, tie: 0 }],
        groupRooms: [],
        free: 10,
        lockToken: 'T',
        lockedBy: 'test:T',
        leaseMs: 60_000,
        choose: locked => locked,
    });

    return { claims, claimDue, logger, transactions: () => transactions };
}

/**
 * @param {string} code
 * @param {number} errno
 * @returns {Error}
 */
function dbError(code, errno) {
    return Object.assign(new Error(code), { code, errno });
}

describe('claimDue on MariaDB without innodb_snapshot_isolation', () => {
    test('ER_UNKNOWN_SYSTEM_VARIABLE: claims again without the prefix, once, and from then on', async () => {
        const { claims, claimDue, logger, transactions } = storeWith(
            'mariadb',
            dbError('ER_UNKNOWN_SYSTEM_VARIABLE', 1193),
        );

        await expect(claimDue()).resolves.toStrictEqual({ jobs: [], next: [] });
        await expect(claimDue()).resolves.toStrictEqual({ jobs: [], next: [] });

        expect(claims.map(sql => sql.includes('innodb_snapshot_isolation'))).toStrictEqual([true, false, false]);
        expect(transactions()).toBe(3);
        expect(logger.debug).toHaveBeenCalledOnce();
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('the errno alone, wrapped by an ORM: the same', async () => {
        const { claims, claimDue } = storeWith('mariadb', new Error('wrapped', { cause: { errno: 1193 } }));

        await claimDue();

        expect(claims.map(sql => sql.includes('innodb_snapshot_isolation'))).toStrictEqual([true, false]);
    });

    test('another error: thrown, the prefix stays', async () => {
        const error = dbError('ER_CHECKREAD', 1020);
        const { claims, claimDue, logger } = storeWith('mariadb', error);

        await expect(claimDue()).rejects.toBe(error);
        await expect(claimDue()).rejects.toBe(error);

        expect(claims.map(sql => sql.includes('innodb_snapshot_isolation'))).toStrictEqual([true, true]);
        expect(logger.debug).not.toHaveBeenCalled();
    });

    test('MySQL: no prefix', async () => {
        const { claims, claimDue } = storeWith('mysql', dbError('ER_UNKNOWN_SYSTEM_VARIABLE', 1193));

        await claimDue();

        expect(claims.map(sql => sql.includes('innodb_snapshot_isolation'))).toStrictEqual([false]);
    });
});
