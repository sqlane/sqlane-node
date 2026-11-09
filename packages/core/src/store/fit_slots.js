// Which locked due jobs a claim takes: the free slots of their lanes and of the process.

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
export function fitSlots(jobs, requests, laneFree, processMax) {
    const laneByName = new Map(requests.map(request => [request.name, request.lane]));
    const taken = laneFree.map(() => 0);
    /** @type {T[]} */
    const fit = [];

    for (const job of jobs) {
        const lane = laneByName.get(job.name);

        if (fit.length >= processMax) {
            break;
        }

        if (lane !== undefined && taken[lane] < laneFree[lane]) {
            taken[lane]++;
            fit.push(job);
        }
    }

    return fit;
}
