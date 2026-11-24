// Scenarios: a producer-only process (a script, another service): no runner, so the dispatcher, the scheduler and the
// leases are never loaded.
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createSqlane } from '@sqlane/core';
import { drizzleAdapter } from '@sqlane/core/adapter-drizzle';
import { sendEmail } from './jobs.js';

const db = drizzle({ client: new Pool({ connectionString: 'postgres://app@localhost/app', max: 2 }) });

// No runner: this process only adds jobs. notify wakes the workers of the other processes.
const sqlane = createSqlane({ adapter: drizzleAdapter(db, { dialect: 'postgres', notify: true }) });

/**
 * Re-sends the emails of the given users. The definition of the lane, imported from the module of the lanes, gives
 * the options of the jobs; the options of an item override them.
 * @param {string[]} userIds
 * @returns {Promise<void>}
 */
export async function resendWelcomeEmails(userIds) {
    await sqlane.enqueueMany(db, sendEmail, userIds.map(userId => ({
        payload: { to: userId, template: 'welcome' },
        options: { maxAttempts: 3 },
    })));
}
