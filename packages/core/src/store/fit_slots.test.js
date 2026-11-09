import { expect, test } from 'vitest';
import { fitSlots } from './fit_slots.js';

test('the free slots of each lane and of the process, in the given order', () => {
    const jobs = ['a1', 'b1', 'c1', 'a2', 'c2', 'c3'].map(id => ({ id, name: id[0] }));
    const requests = [
        { name: 'a', maxJobs: 2, lane: 0 },
        { name: 'b', maxJobs: 2, lane: 0 },
        { name: 'c', maxJobs: 3, lane: 1 },
    ];

    // Lane 0 (a, b): 2 free slots; lane 1 (c): 2
    expect(fitSlots(jobs, requests, [2, 2], 10).map(job => job.id)).toStrictEqual(['a1', 'b1', 'c1', 'c2']);
    // The process: 3 free slots; a passed-over job does not count
    expect(fitSlots(jobs, requests, [1, 5], 3).map(job => job.id)).toStrictEqual(['a1', 'c1', 'c2']);
    // An unknown name: never taken
    expect(fitSlots([{ id: 'x', name: 'x' }], requests, [5, 5], 5)).toStrictEqual([]);
});
