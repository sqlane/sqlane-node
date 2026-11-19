// One sqlane instance per process, over Drizzle on PostgreSQL.
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createSqlane } from '@sqlane/core';
import { drizzleAdapter } from '@sqlane/core/adapter-drizzle';
import { allJobs } from './jobs.js';

/** The app's database: business transactions, handlers. */
export const db = drizzle({ client: new Pool({ connectionString: 'postgres://app@localhost/app', max: 20 }) });

/** The queue's own small pool: claims, leases, results, and the LISTEN connection of notify. */
const queueDb = drizzle({ client: new Pool({ connectionString: 'postgres://app@localhost/app', max: 3 }) });

export const sqlane = createSqlane({
    // NOTIFY wakes the workers of every process at the commit
    adapter: drizzleAdapter(queueDb, { dialect: 'postgres', notify: true }),
    jobs: allJobs,
    localMaxConcurrency: 10,
    defaults: { timeout: '10m' },
    unknownJobs: 'reject',
    onEvent: (event) => {
        if (event.type === 'failed') {
            reportError(event.jobName, event.error);
        }
    },
});

/**
 * @param {string} jobName
 * @param {unknown} error
 */
function reportError(jobName, error) {
    void jobName;
    void error;
}
