export type Executor = import('../types.js').Executor;
export type KeyStats = import('../types.js').KeyStats;
/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('../types.js').KeyStats} KeyStats */
/** The blocked jobs that a key counts: one more is read, and means more */
export declare const BLOCKED_CAP = 1000;
export type KeyStatsParams = {
    limit: number;
    /**
     * Null: every type.
     */
    type: 'concurrency' | 'rate' | null;
    orderBy: 'blocked' | 'held';
};
export type Dialect = {
    /**
     * The database time of the statement, constant in it.
     */
    now: string;
    /**
     * Of a time column at `now`, in integer ms (null for null).
     */
    ageMs: (column: string) => string;
    /**
     * A JSON or array column, as JSON text.
     */
    jsonText: (column: string) => string;
    /**
     * `heads` is a recursive CTE.
     */
    recursive: boolean;
    /**
     * The CTE `heads`: one row per blocked key, `k` and `head_run_at`.
     */
    heads: string;
    /**
     * The ORDER BY of the blocked jobs `b` of a key, by its index.
     */
    headOrder: string;
    /**
     * The index hint of the blocked jobs, or nothing.
     */
    blockedIndex: string;
    /**
     * The CTE `ks`: `k`, `head_run_at`, `held`, `lingering`, `oldest_slot`.
     */
    keys: string;
    /**
     * `sortT` ascending, nulls last, then the key in byte order.
     */
    nullsLast: (sortT: string) => string;
    /**
     * The first character of `k`.
     */
    firstChar: string;
    /**
     * The debt of the rate key `r.k`, in µs, at `now`: null without a row.
     */
    debtUs: string;
    /**
     * The placeholder of the limit.
     */
    limitParam: string;
};
/**
 * A row of the statement as `KeyStats`.
 * @param {Record<string, unknown>} row
 * @returns {KeyStats}
 */
export declare function toKeyStats(row: Record<string, unknown>): KeyStats;
/**
 * The keys of a page, worst first.
 * @param {Executor} executor The queue's pool.
 * @param {'mysql' | 'postgres'} family
 * @param {string} p
 * @param {KeyStatsParams} params
 * @returns {Promise<import('../types.js').KeyStatsPage>}
 */
export declare function keyStats(executor: Executor, family: 'mysql' | 'postgres', p: string, params: KeyStatsParams): Promise<import('../types.js').KeyStatsPage>;
