// Scenarios: cron and repeatable jobs. The schedules are defined next to their lane (jobs.js); the runner of a
// process fires those that it mounts (worker.js). Their handlers, and the admin side here.
import { defineHandler } from '@sqlane/core';
import { nightly, nightlyReport, syncTenant } from './jobs.js';
import { sqlane } from './sqlane.js';

export const scheduleHandlers = [
    defineHandler(nightlyReport, async ({ job, signal }) => {
        // The slot, also when the run is late: the day of the report
        const day = job.scheduledAt;

        await fetch(`https://reports.example.com/nightly?day=${day?.toISOString()}`, { method: 'POST', signal });
    }),
    defineHandler(syncTenant, async ({ payload, signal }) => {
        await fetch(`https://erp.example.com/tenants/${payload.tenantId}/sync`, { method: 'POST', signal });
    }),
];

/**
 * The schedules in the database: their next slot and their last job, for every process.
 * @returns {Promise<void>}
 */
export async function printSchedules() {
    for (const schedule of await sqlane.schedules.list()) {
        console.log(schedule.id, schedule.nextRunAt?.toISOString(), schedule.lastJobId);
    }
}

/**
 * Runs the report of a day by hand: the same job as the slot, so the scheduler adds no second one. No runner needed.
 * @param {Date} slot A slot of the schedule, not in the future.
 * @returns {Promise<void>}
 */
export async function runReportByHand(slot) {
    await sqlane.schedules.runSlot(nightly, { at: slot });
}
