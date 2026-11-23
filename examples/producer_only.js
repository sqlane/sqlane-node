// Scenarios: a producer-only process (a script, another service), enqueue to a lane by name.
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createSqlane } from '@sqlane/core';
import { drizzleAdapter } from '@sqlane/core/adapter-drizzle';

const db = drizzle({ client: new Pool({ connectionString: 'postgres://app@localhost/app', max: 2 }) });

// No lanes, no handlers, no start(): this process only adds jobs. notify wakes the workers of the other processes.
const sqlane = createSqlane({ adapter: drizzleAdapter(db, { dialect: 'postgres', notify: true }) });

/**
 * Re-sends the emails of the given users. The lane is not known here: the job gets the instance defaults, and
 * globalConcurrencyLimits comes only from the options. The failure lane is the one of the definition of the worker.
 * @param {string[]} userIds
 * @returns {Promise<void>}
 */
export async function resendWelcomeEmails(userIds) {
    await sqlane.enqueueMany(db, 'send_email', userIds.map(userId => ({
        payload: { to: userId, template: 'welcome' },
        options: { maxAttempts: 10 },
    })));
}
