import { expect } from 'vitest';

/**
 * The bulk methods of sqlane.jobs through an adapter: its pool given as `connection` (a transaction of sqlane's own),
 * its transaction (the caller's, committed and rolled back), its parameters and the types of its driver.
 * @param {import('../../../src/types.js').Sqlane<any>} sqlane Migrated.
 * @param {unknown} pool A connection that the adapter takes as a pool: the app's instance.
 * @param {(func: (transaction: any) => Promise<void>) => Promise<void>} inTransaction Runs func in a transaction of
 *     the app's library, then commits it; rolls it back when func throws.
 * @returns {Promise<void>}
 */
export async function checkJobsBulk(sqlane, pool, inTransaction) {
    const items = [{ n: 1 }, { n: 2 }, { n: 3 }].map(payload => ({ payload, options: { delay: '1h' } }));
    const [first, second, third] = (await sqlane.enqueueMany(pool, 'bulk_check', items)).map(({ id }) => id);

    // A pool: a transaction of sqlane's own
    await expect(sqlane.jobs.cancel({ jobIds: [first, 'bulk_check:none'] }, { connection: pool })).resolves
        .toStrictEqual({ affectedCount: 1, ignoredJobs: [{ jobId: 'bulk_check:none', reason: 'not_found' }] });

    // The caller's transaction, rolled back, then committed
    await expect(inTransaction(async (transaction) => {
        await sqlane.jobs.cancel({ jobIds: [second] }, { connection: transaction });
        throw new Error('rollback');
    })).rejects.toThrow('rollback');
    await expect(sqlane.jobs.get(second)).resolves.toMatchObject({ status: 'pending' });
    await inTransaction(async (transaction) => {
        const result = await sqlane.jobs.cancel(
            { lane: 'bulk_check' },
            { connection: transaction, includeAffectedJobIds: true },
        );

        expect(result).toStrictEqual({ affectedCount: 2, affectedJobIds: expect.any(Array), ignoredJobs: [] });
        expect(result.affectedJobIds?.toSorted()).toStrictEqual([second, third].toSorted());
    });

    // The caller's transaction, committed: a retry and a cancel by ids
    await inTransaction(async (transaction) => {
        await expect(sqlane.jobs.retry({ jobIds: [first, second] }, { connection: transaction })).resolves
            .toStrictEqual({ affectedCount: 2, ignoredJobs: [] });
        await expect(sqlane.jobs.cancel({ jobIds: [first] }, { connection: transaction })).resolves
            .toStrictEqual({ affectedCount: 1, ignoredJobs: [] });
    });
    await expect(sqlane.jobs.get(second)).resolves.toMatchObject({ status: 'pending', attempts: 0 });
    await expect(sqlane.jobs.get(first)).resolves.toMatchObject({ status: 'failed' });

    // A filter read with its payload flag, on the pool
    await expect(sqlane.jobs.retry({ lane: 'bulk_check' }, { connection: pool })).resolves
        .toStrictEqual({ affectedCount: 2, ignoredJobs: [] });
    await expect(sqlane.jobs.get(first)).resolves.toMatchObject({ status: 'pending', attempts: 0, payload: { n: 1 } });
    await expect(sqlane.jobs.remove({ lane: 'bulk_check' })).resolves
        .toStrictEqual({ affectedCount: 3, ignoredJobs: [] });
}
