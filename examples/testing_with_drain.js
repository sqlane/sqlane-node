// Scenario: test the app with drain(), without start(); a slot of a schedule by hand.
import { expect, test } from 'vitest';
import { orderReport } from './enqueue_in_transaction.js';
import { nightly } from './jobs.js';
import { scheduleHandlers } from './schedules.js';
import { sqlane } from './sqlane.js';
import { runner, workerParts } from './worker.js';

test('an ordered report is built', async () => {
    runner.mount(workerParts);
    await orderReport('report-1');

    const { completed, failed } = await runner.drain({ timeout: '10s', includeDelayed: true });

    expect({ completed, failed }).toStrictEqual({ completed: 1, failed: 0 });
});

test('the nightly report runs', async () => {
    runner.mount(scheduleHandlers);
    await sqlane.schedules.runSlot(nightly);

    await expect(runner.drain()).resolves.toMatchObject({ completed: 1, failed: 0 });
});
