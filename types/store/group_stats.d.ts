export type Executor = import('../types.js').Executor;
export type GroupStatsParams = {
    lane: string;
    limit: number;
    orderBy: 'oldestDue' | 'pending';
};
/** @typedef {import('../types.js').Executor} Executor */
/**
 * @typedef {object} GroupStatsParams
 * @property {string} lane
 * @property {number} limit
 * @property {'oldestDue' | 'pending'} orderBy
 */
/**
 * @param {Executor} executor
 * @param {'mysql' | 'postgres'} family
 * @param {string} p
 * @param {GroupStatsParams} params
 * @returns {Promise<import('../types.js').GroupStatsPage>}
 */
export declare function readGroupStats(executor: Executor, family: 'mysql' | 'postgres', p: string, { lane, limit, orderBy }: GroupStatsParams): Promise<import('../types.js').GroupStatsPage>;
