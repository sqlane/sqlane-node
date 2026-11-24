// The lane definitions, their limits and their schedules: imported by producers and workers. Pure: no handler code.
import { defineConcurrencyLimit, defineLane, defineRateLimit, defineSchedule } from '@sqlane/core';

export const reportFailed = defineLane({
    name: 'report_failed',
});

export const buildReport = defineLane({
    name: 'build_report',
    maxAttempts: 5,
    backoff: { type: 'exponential', delay: '5s', maxDelay: '1h', jitter: 0.2 },
    retention: { completed: '1h', failed: '30d' },
    failureLane: reportFailed,
    timeout: '5m',
});

/** One job of an order at a time, in the whole cluster: a key per order */
export const order = defineConcurrencyLimit({ name: 'order', max: 1 });

export const syncOrder = defineLane({
    name: 'sync_order',
    globalConcurrencyLimits: ({ payload }) => [order.key(payload.orderId)],
    timeout: '2m', // a job with global limits needs a timeout
});

/** At most 100 calls a second to the mail API, in the whole cluster: one every 10 ms, or 20 at once after a pause */
export const mailApi = defineRateLimit({ name: 'mail_api', max: 100, per: '1s', burst: 20 });

export const sendEmail = defineLane({
    name: 'send_email',
    maxAttempts: 10,
    backoff: { type: 'fixed', delay: '30s' },
    globalRateLimits: () => [mailApi], // no timeout needed: a rate limit holds nothing while the job runs
});

export const nightlyReport = defineLane({ name: 'nightly_report', timeout: '10m' });
export const syncTenant = defineLane({ name: 'sync_tenant', timeout: '1m' });

// At 03:00 in Berlin, every day. A run missed during a short downtime runs once (missed: 'once').
export const nightly = defineSchedule(nightlyReport, { key: 'nightly', cron: '0 3 * * *', timezone: 'Europe/Berlin' });

// Every 15 minutes, per tenant: a key per schedule. A slot is skipped while the previous run is not done, and the
// runs of the tenants spread over 5 minutes.
export const tenantSyncs = [41, 42].map(tenantId => defineSchedule(syncTenant, {
    key: `tenant-${tenantId}`,
    every: '15m',
    payload: { tenantId },
    overlap: 'skip',
    jitter: '5m',
}));
