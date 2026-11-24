import { expect, test } from 'vitest';
import { resolveDefaults } from './defaults.js';
import { defineLane } from './define_lane.js';
import { createFailureLanes } from './failure_lanes.js';
import { createRegistry } from './registry.js';

const reportFailed = defineLane({ name: 'report_failed', maxAttempts: 7 });
const alert = defineLane({ name: 'alert', maxAttempts: 5 });

/**
 * @returns {{ failureLanes: import('./failure_lanes.js').FailureLanes, events: import('./types.js').SqlaneEvent[],
 *     added: string[] }}
 */
function failureLanesOf() {
    const registry = createRegistry({ lanesByName: new Map([['report_failed', reportFailed]]), defaultTimeoutMs: null });
    /** @type {import('./types.js').SqlaneEvent[]} */
    const events = [];
    /** @type {string[]} */
    const added = [];

    return {
        failureLanes: createFailureLanes({
            registry,
            defaults: resolveDefaults(),
            emit: event => events.push(event),
            reportError: () => {},
            onAdded: lane => added.push(lane),
        }),
        events,
        added,
    };
}

/** @type {import('./store/store.js').FailedJob} */
const failedJob = {
    id: 'job-1',
    lane: 'report',
    payload: { reportId: 'r1' },
    attempt: 2,
    maxAttempts: 3,
    error: { name: 'Error', message: 'broken' },
};

test.each([
    {
        title: 'a failure lane by name: its definition in "lanes"',
        definition: defineLane({ name: 'report', failureLane: 'report_failed' }),
        lane: 'report_failed',
        maxAttempts: 7,
    },
    {
        title: 'a failure lane as a definition: its own options',
        definition: defineLane({ name: 'report', failureLane: alert }),
        lane: 'alert',
        maxAttempts: 5,
    },
])('the failure job: the definition of this process decides; $title', ({ definition, lane, maxAttempts }) => {
    const { failureLanes } = failureLanesOf();
    const builder = failureLanes.builderOf(definition);

    expect(builder.lane).toBe(lane);
    expect(builder.build(failedJob)).toMatchObject({ lane, maxAttempts });
    expect(builder.build(failedJob)).not.toHaveProperty('failureLane');
    expect(JSON.parse(builder.build(failedJob).payloadJson)).toStrictEqual({
        job: { id: 'job-1', lane: 'report', payload: { reportId: 'r1' }, attempt: 2, maxAttempts: 3 },
        error: { name: 'Error', message: 'broken' },
    });
});

test('no failure lane: a definition without one; a lane added by name, without a definition', () => {
    const { failureLanes } = failureLanesOf();

    expect(failureLanes.builderOf(defineLane({ name: 'report' })).lane).toBeNull();
    expect(failureLanes.builderOf(null).lane).toBeNull();
});

test('report: an added failure job wakes its lane; a refused one is a failure_job_not_added event with its lane', () => {
    const { failureLanes, events, added } = failureLanesOf();
    const error = new Error('refused');
    const job = { id: 'job-1', lane: 'report', attempt: 2 };
    const builder = failureLanes.builderOf(defineLane({ name: 'report', failureLane: 'report_failed' }));

    failureLanes.report(job, null);
    failureLanes.report(job, { added: builder.build(failedJob) });
    failureLanes.report(job, { notAdded: error, failureLane: 'alert' });

    expect(added).toStrictEqual(['report_failed']);
    expect(events).toStrictEqual([{
        type: 'failure_job_not_added',
        jobId: 'job-1',
        lane: 'report',
        attempt: 2,
        failureLane: 'alert',
        error,
    }]);
});
