// Scenarios: cron and repeatable jobs. Call schedule() in the worker code, before start().
import { defineJob } from '@sqlane/core';
import { sqlane } from './sqlane.js';

export const nightlyReport = defineJob({ name: 'nightly_report', timeout: '10m' });
export const syncTenant = defineJob({ name: 'sync_tenant', timeout: '1m' });

sqlane.handle(nightlyReport, async ({ job, signal }) => {
    // The slot, also when the run is late: the day of the report
    const day = job.scheduledAt;

    await fetch(`https://reports.example.com/nightly?day=${day?.toISOString()}`, { method: 'POST', signal });
});

sqlane.handle(syncTenant, async ({ payload, signal }) => {
    await fetch(`https://erp.example.com/tenants/${payload.tenantId}/sync`, { method: 'POST', signal });
});

// At 03:00 in Berlin, every day. A run missed during a short downtime runs once (missed: 'once').
sqlane.schedule(nightlyReport, { cron: '0 3 * * *', timezone: 'Europe/Berlin' });

// Every 15 minutes, per tenant: a key per schedule. A slot is skipped while the previous run is not done, and the
// runs of the tenants spread over 5 minutes.
for (const tenantId of [41, 42]) {
    sqlane.schedule(syncTenant, {
        every: '15m',
        key: `tenant-${tenantId}`,
        payload: { tenantId },
        overlap: 'skip',
        jitter: '5m',
    });
}

/**
 * Starts the schedules and the worker.
 * @returns {Promise<void>}
 */
export async function runSchedules() {
    await sqlane.start();

    for (const schedule of await sqlane.getSchedules()) {
        console.log(schedule.id, schedule.nextRunAt?.toISOString());
    }
}

/**
 * Runs the report of a day by hand: the same job as the slot, so the scheduler adds no second one.
 * @param {import('mysql2/promise').Pool} pool
 * @param {Date} slot
 * @returns {Promise<void>}
 */
export async function runReportByHand(pool, slot) {
    await sqlane.enqueue(pool, nightlyReport, {}, { slot: { at: slot } });
}
