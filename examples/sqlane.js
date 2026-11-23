// One sqlane instance per process, over Drizzle on PostgreSQL.
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createSqlane } from '@sqlane/core';
import { drizzleAdapter } from '@sqlane/core/adapter-drizzle';
import { allLanes } from './jobs.js';

/** The app's database: business transactions, handlers. */
export const db = drizzle({ client: new Pool({ connectionString: 'postgres://app@localhost/app', max: 20 }) });

/** The queue's own small pool: claims, leases, results, and the LISTEN connection of notify. */
const queueDb = drizzle({ client: new Pool({ connectionString: 'postgres://app@localhost/app', max: 3 }) });

export const sqlane = createSqlane({
    // NOTIFY wakes the workers of every process at the commit
    adapter: drizzleAdapter(queueDb, { dialect: 'postgres', notify: true }),
    lanes: allLanes,
    localMaxConcurrency: 10,
    defaults: { timeout: '10m' },
    unknownLanes: 'reject',
    onEvent: (event) => {
        if (event.type === 'failed') {
            reportError(event.lane, event.error);
        }
    },
});

/**
 * @param {string} lane
 * @param {unknown} error
 */
function reportError(lane, error) {
    void lane;
    void error;
}
