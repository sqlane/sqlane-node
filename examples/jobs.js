// The job definitions and the concurrency groups: imported by producers and workers.
import { defineConcurrencyGroup, defineJob } from '@sqlane/core';

/** At most 2 heavy jobs at once in one process, across the names of the group */
export const heavy = defineConcurrencyGroup({ name: 'heavy', maxConcurrency: 2 });

export const buildReport = defineJob({
    name: 'build_report',
    maxAttempts: 5,
    backoff: { type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 },
    retention: { completed: '1h', failed: '30d' },
    failureJob: 'report_failed',
});

export const reportFailed = defineJob({
    name: 'report_failed',
});

export const syncOrder = defineJob({
    name: 'sync_order',
    // Two jobs of one order never run at the same time, in the whole cluster
    mutexKeys: payload => [`order:${payload.orderId}`],
    timeout: '2m', // a job with mutex keys needs a timeout
});

export const sendEmail = defineJob({
    name: 'send_email',
    maxAttempts: 10,
    backoff: { type: 'fixed', delay: '30s' },
});

export const allJobs = [buildReport, reportFailed, syncOrder, sendEmail];
