// Scenarios: a worker with concurrency groups, caps, weights and timeouts; retry and failure job; mutex keys; graceful
// shutdown.
import { FatalJobError, RetryJobError } from '@sqlane/core';
import { buildReport, heavy, reportFailed, sendEmail, syncOrder } from './jobs.js';
import { sqlane } from './sqlane.js';

sqlane.handle(buildReport, async ({ payload, job, signal }) => {
    const response = await fetch(`https://reports.example.com/${payload.reportId}`, { signal });

    if (response.status === 404) {
        throw new FatalJobError(`report ${payload.reportId} does not exist`); // no retries: report_failed runs
    }

    if (response.status === 429) {
        throw new RetryJobError('rate limited', { delay: '1m' }); // instead of the backoff
    }

    void job.attempt;
}, { concurrencyGroup: heavy, timeout: '5m' });

sqlane.handle(reportFailed, ({ payload }) => {
    /** @type {import('@sqlane/core').FailedJobPayload} */
    const failure = payload;

    void failure.job.payload.reportId;
    void failure.error.message;
});

sqlane.handle(syncOrder, async ({ payload, signal }) => {
    await fetch(`https://erp.example.com/orders/${payload.orderId}`, { method: 'PUT', signal });
}, { maxConcurrency: 4 }); // at most 4 at once in this process

sqlane.handle(sendEmail, async ({ payload }) => {
    await fetch('https://mail.example.com/send', { method: 'POST', body: JSON.stringify(payload) });
}, { fairShareWeight: 3 }); // 3 times the share of the free slots of a name of weight 1

/**
 * Starts the worker; closes it on SIGTERM.
 * @returns {Promise<void>}
 */
export async function runWorker() {
    await sqlane.start();

    process.once('SIGTERM', async () => {
        // Handlers that do not finish by the deadline are released: no attempt is used.
        await sqlane.close({ deadline: '30s', mode: 'release', exitsBy: '35s' });
    });
}
