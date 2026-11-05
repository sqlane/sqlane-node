// One sqlane instance per process.
import mysql from 'mysql2/promise';
import { createSqlane } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/mysql2';
import { allJobs } from './jobs.js';

/** The app's pool: business transactions, handlers. */
export const appPool = mysql.createPool({ uri: 'mysql://app@localhost/app', connectionLimit: 20 });

/** The queue's own small pool: claims, leases, results. */
const queuePool = mysql.createPool({ uri: 'mysql://app@localhost/app', connectionLimit: 3 });

export const sqlane = createSqlane({
    adapter: mysql2Adapter(queuePool),
    jobs: allJobs,
    concurrency: 10,
    lanes: { heavy: { concurrency: 2 } },
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
