// Scenarios: a producer-only process (a script, another service), enqueue by name.
import mysql from 'mysql2/promise';
import { createSqlane } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/mysql2';

const pool = mysql.createPool({ uri: 'mysql://app@localhost/app', connectionLimit: 2 });

// No jobs, no handlers, no start(): this process only adds jobs.
const sqlane = createSqlane({ adapter: mysql2Adapter(pool) });

/**
 * Re-sends the emails of the given users. The name is not known here: the job gets the instance defaults, and
 * mutexKeys and failureJob come only from the options.
 * @param {string[]} userIds
 * @returns {Promise<void>}
 */
export async function resendWelcomeEmails(userIds) {
    await sqlane.enqueueMany(pool, 'send_email', userIds.map(userId => ({
        payload: { to: userId, template: 'welcome' },
        options: { maxAttempts: 10, failureJob: 'email_failed' },
    })));
}
