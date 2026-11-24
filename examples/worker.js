// Scenarios: a worker: handlers with local limits and weights; retry, rate limited and failure job; schedules; graceful
// shutdown.
import { defineConcurrencyLimit, defineHandler, FatalJobError, RateLimitedError, RetryJobError } from '@sqlane/core';
import { createRunner } from '@sqlane/core/runner';
import { buildReport, mailApi, nightly, reportFailed, sendEmail, syncOrder, tenantSyncs } from './jobs.js';
import { sqlane } from './sqlane.js';

/** At most 2 heavy jobs at once in this process, across the handlers that list it */
const heavy = defineConcurrencyLimit({ name: 'heavy', max: 2 });

/** The handlers of this process: they hold the code and its dependencies, which the producers never load */
export const workerParts = [
    defineHandler(buildReport, async ({ payload, job, signal }) => {
        const response = await fetch(`https://reports.example.com/${payload.reportId}`, { signal });

        if (response.status === 404) {
            throw new FatalJobError(`report ${payload.reportId} does not exist`); // no retries: report_failed runs
        }

        if (response.status === 503) {
            throw new RetryJobError('reports are down', { delay: '1m' }); // instead of the backoff
        }

        void job.attempt;
    }, { localConcurrencyLimits: [heavy] }),
    defineHandler(reportFailed, ({ payload }) => {
        /** @type {import('@sqlane/core').FailedJobPayload} */
        const failure = payload;

        void failure.job.payload.reportId;
        void failure.error.message;
    }),
    defineHandler(syncOrder, async ({ payload, signal }) => {
        await fetch(`https://erp.example.com/orders/${payload.orderId}`, { method: 'PUT', signal });
    }, { localConcurrencyLimits: [heavy] }),
    defineHandler(sendEmail, async ({ payload }) => {
        const response = await fetch('https://mail.example.com/send', { method: 'POST', body: JSON.stringify(payload) });

        if (response.status === 429) {
            // The mail API starts nothing for 30 s, in the whole cluster; this job waits, without using an attempt
            throw new RateLimitedError({ limit: mailApi, retryAfter: '30s' });
        }
    }, { fairShareWeight: 3 }), // 3 times the share of the free slots of a lane of weight 1
];

/** The runner of this process: one per sqlane */
export const runner = createRunner(sqlane, { localMaxConcurrency: 10 });

/**
 * Starts the worker and the schedules; closes them on SIGTERM.
 * @returns {Promise<void>}
 */
export async function runWorker() {
    runner.mount(workerParts);
    runner.mount([nightly, ...tenantSyncs]);
    await runner.start();

    process.once('SIGTERM', async () => {
        // Handlers that do not finish by the deadline are released: no attempt is used. Closes the runner too.
        await sqlane.close({ deadline: '30s', mode: 'release', exitsBy: '35s' });
    });
}
