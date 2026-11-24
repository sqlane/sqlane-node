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
        requests: [{ name: 'a', maxJobs: 5, running: 0, weight: 1, limits: [], tie: 0 }],
        limitRooms: [],
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

        await expect(claimDue()).resolves.toStrictEqual({ jobs: [], next: [], limited: [] });
        await expect(claimDue()).resolves.toStrictEqual({ jobs: [], next: [], limited: [] });

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

/**
 * A store on a fake adapter whose transactions fail with the given errors, one after the other, then run.
 * @param {import('../types.js').Dialect} dialect
 * @param {unknown[]} errors
 * @returns {{ store: import('./store.js').Store, logger: Record<string, import('vitest').Mock>,
 *     transactions: () => number }}
 */
function storeFailingWith(dialect, errors) {
    let transactions = 0;
    const executor = { query: async () => [], run: async () => 0 };
    const adapter = /** @type {import('../types.js').Adapter<any>} */ (/** @type {unknown} */ ({
        dialect,
        queue: executor,
        queueTransaction: async (/** @type {(e: typeof executor) => Promise<unknown>} */ func) => {
            const error = errors[transactions];

            transactions++;

            if (error) {
                throw error;
            }

            return func(executor);
        },
    }));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    return { store: createStore(adapter, 'sqlane_', logger), logger, transactions: () => transactions };
}

const NOTHING_SWEPT = { lingers: 0, orphans: 0, unblocked: 0, rateWaits: [] };

describe.each(/** @type {const} */ (['mysql', 'mariadb', 'postgres']))('sweepSlots on %s', (dialect) => {
    test('a deadlock, a serialization failure, a 1020: the sweep runs again at once, logged at debug', async () => {
        const { store, logger, transactions } = storeFailingWith(dialect, [
            dbError('ER_LOCK_DEADLOCK', 1213),
            dbError('40001', 0),
            dbError('ER_CHECKREAD', 1020),
        ]);

        await expect(store.sweepSlots(100)).resolves.toStrictEqual(NOTHING_SWEPT);

        expect(transactions()).toBe(4);
        expect(logger.debug).toHaveBeenCalledTimes(3);
        expect(logger.debug).toHaveBeenLastCalledWith(
            expect.objectContaining({ operation: 'sweep_slots', retry: 3 }),
            expect.any(String),
        );
    });

    test('a 4th one in a row: it rejects', async () => {
        const error = dbError('ER_LOCK_DEADLOCK', 1213);
        const { store, transactions } = storeFailingWith(dialect, [error, error, error, error]);

        await expect(store.sweepSlots(100)).rejects.toBe(error);

        expect(transactions()).toBe(4);
    });

    test('no part with work: no transaction', async () => {
        const { store, transactions } = storeFailingWith(dialect, []);

        await expect(store.sweepSlots(100, { lingers: false, orphans: false, blocked: false }))
            .resolves.toStrictEqual(NOTHING_SWEPT);

        expect(transactions()).toBe(0);
    });

    test('a lock wait timeout: it rejects at once', async () => {
        const timeout = dbError('ER_LOCK_WAIT_TIMEOUT', 1205);
        const { store, transactions } = storeFailingWith(dialect, [timeout]);

        await expect(store.sweepSlots(100)).rejects.toBe(timeout);

        expect(transactions()).toBe(1);
    });
});

/**
 * A MySQL store whose probe reads the paused lanes given, and the SQL of the unblocks of concurrency keys.
 * @param {string[]} paused
 * @param {{ pausedSeenMs?: number }} [options]
 * @returns {{ store: import('./store.js').Store, heads: () => string | undefined }}
 */
function storeWithPauses(paused, options) {
    /** @type {string[]} */
    const sent = [];
    const executor = {
        query: async (/** @type {string} */ sql) => {
            sent.push(sql);

            return sql.includes('UNION ALL') && sql.includes('paused_lanes)')
                ? paused.map(lane => ({ lane, delay_ms: null }))
                : [];
        },
        run: async () => 0,
    };
    const adapter = /** @type {import('../types.js').Adapter<any>} */ (/** @type {unknown} */ ({
        dialect: 'mysql',
        queue: executor,
        queueTransaction: async (/** @type {(e: typeof executor) => Promise<unknown>} */ func) => func(executor),
    }));
    const store = createStore(adapter, 'sqlane_', undefined, options);

    return { store, heads: () => sent.findLast(sql => sql.includes('JSON_TABLE(?')) };
}

describe('mysql: the paused lanes of the last probe, in the reads of the blocked jobs', () => {
    test('no probe yet: the subquery; after a probe: its lanes as parameters, none when no lane is paused', async () => {
        const { store, heads } = storeWithPauses(['a']);

        await store.unblock(['k']);
        expect(heads()).toContain('NOT EXISTS (SELECT 1 FROM sqlane_paused_lanes');
        await store.probe(null);
        await store.unblock(['k']);
        expect(heads()).toContain('j.lane NOT IN (?)');

        const none = storeWithPauses([]);

        await none.store.probe(null);
        await none.store.unblock(['k']);
        expect(none.heads()).not.toMatch(/paused_lanes|NOT IN/u);
    });

    test('the lanes of a probe expire after pausedSeenMs: the subquery again', async () => {
        vi.useFakeTimers();

        try {
            const { store, heads } = storeWithPauses(['a'], { pausedSeenMs: 5000 });

            await store.probe(null);
            vi.advanceTimersByTime(5000);
            await store.unblock(['k']);
            expect(heads()).toContain('j.lane NOT IN (?)');
            vi.advanceTimersByTime(1);
            await store.unblock(['k']);
            expect(heads()).toContain('NOT EXISTS (SELECT 1 FROM sqlane_paused_lanes');
        } finally {
            vi.useRealTimers();
        }
    });

    test('forgetPausedLanes (a resume): the subquery until the next probe', async () => {
        const { store, heads } = storeWithPauses(['a']);

        await store.probe(null);
        store.forgetPausedLanes();
        await store.unblock(['k']);
        expect(heads()).toContain('NOT EXISTS (SELECT 1 FROM sqlane_paused_lanes');
        await store.probe(null);
        await store.unblock(['k']);
        expect(heads()).toContain('j.lane NOT IN (?)');
    });

    test('more paused lanes than 50: the subquery, not a list of parameters', async () => {
        const { store, heads } = storeWithPauses(Array.from({ length: 51 }, (_, index) => `lane_${index}`));

        await store.probe(null);
        await store.unblock(['k']);
        expect(heads()).toContain('NOT EXISTS (SELECT 1 FROM sqlane_paused_lanes');
        expect(heads()).not.toContain('NOT IN');
    });
});
