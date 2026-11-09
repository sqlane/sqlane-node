/**
 * The jobs that fit the free slots, oldest first: at most `laneFree` of each lane and `processMax` in all. The claim of
 * due jobs on PostgreSQL does the same in SQL.
 * @template {{ name: string }} T
 * @param {T[]} jobs In the order of run_at, id.
 * @param {import('./store.js').DueRequest[]} requests
 * @param {number[]} laneFree
 * @param {number} processMax
 * @returns {T[]}
 */
export declare function fitSlots<T extends {
    name: string;
}>(jobs: T[], requests: import('./store.js').DueRequest[], laneFree: number[], processMax: number): T[];
