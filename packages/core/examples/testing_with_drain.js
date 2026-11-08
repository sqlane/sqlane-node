// Scenario: test the app with drain(), without start().
import { expect, test } from 'vitest';
import { orderReport } from './enqueue_in_transaction.js';
import { sqlane } from './sqlane.js';

test('an ordered report is built', async () => {
    await orderReport('report-1');

    const { completed, failed } = await sqlane.drain({ timeout: '10s', includeDelayed: true });

    expect({ completed, failed }).toStrictEqual({ completed: 1, failed: 0 });
});
