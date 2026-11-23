// Scenarios: a worker of definitions with local and global limits, rate limits, weights and timeouts; retry, rate
// limited and failure job; graceful shutdown.
import { FatalJobError, RateLimitedError, RetryJobError } from '@sqlane/core';
import { buildReport, mailApi, reportFailed, sendEmail, syncOrder } from './jobs.js';
import { sqlane } from './sqlane.js';

sqlane.lanes.add(buildReport, async ({ payload, job, signal }) => {
    const response = await fetch(`https://reports.example.com/${payload.reportId}`, { signal });

    if (response.status === 404) {
        throw new FatalJobError(`report ${payload.reportId} does not exist`); // no retries: report_failed runs
    }

    if (response.status === 503) {
        throw new RetryJobError('reports are down', { delay: '1m' }); // instead of the backoff
    }

    void job.attempt;
});

sqlane.lanes.add(reportFailed, ({ payload }) => {
    /** @type {import('@sqlane/core').FailedJobPayload} */
    const failure = payload;

    void failure.job.payload.reportId;
    void failure.error.message;
});

sqlane.lanes.add(syncOrder, async ({ payload, signal }) => {
    await fetch(`https://erp.example.com/orders/${payload.orderId}`, { method: 'PUT', signal });
});

sqlane.lanes.add(sendEmail, async ({ payload }) => {
    const response = await fetch('https://mail.example.com/send', { method: 'POST', body: JSON.stringify(payload) });

    if (response.status === 429) {
        // The mail API starts nothing for 30 s, in the whole cluster; this job waits, without using an attempt
        throw new RateLimitedError({ limit: mailApi, retryAfter: '30s' });
    }
});

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
