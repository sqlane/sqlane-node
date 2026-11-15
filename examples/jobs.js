// The job definitions and their local concurrency limits: imported by producers and workers.
import { defineConcurrencyLimit, defineJob } from '@sqlane/core';

/** At most 2 heavy jobs at once in one process, across the names that list it */
export const heavy = defineConcurrencyLimit({ name: 'heavy', max: 2 });

/** At most 4 order syncs at once in one process */
export const orderSyncs = defineConcurrencyLimit({ name: 'order_syncs', max: 4 });

export const buildReport = defineJob({
    name: 'build_report',
    maxAttempts: 5,
    backoff: { type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 },
    retention: { completed: '1h', failed: '30d' },
    failureJob: 'report_failed',
    timeout: '5m',
    localConcurrencyLimits: [heavy],
});

export const reportFailed = defineJob({
    name: 'report_failed',
});

/** One job of an order at a time, in the whole cluster: a key per order */
export const order = defineConcurrencyLimit({ name: 'order', max: 1 });

export const syncOrder = defineJob({
    name: 'sync_order',
    globalConcurrencyLimits: ({ payload }) => [order.key(payload.orderId)],
    timeout: '2m', // a job with global limits needs a timeout
    localConcurrencyLimits: [orderSyncs],
});

export const sendEmail = defineJob({
    name: 'send_email',
    maxAttempts: 10,
    backoff: { type: 'fixed', delay: '30s' },
    fairShareWeight: 3, // 3 times the share of the free slots of a name of weight 1
});

export const allJobs = [buildReport, reportFailed, syncOrder, sendEmail];
