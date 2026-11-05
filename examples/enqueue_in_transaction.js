// Scenarios: enqueue in the business transaction; dedupe by jobId; enqueueMany.
import { buildReport, sendEmail } from './jobs.js';
import { appPool, sqlane } from './sqlane.js';

/**
 * Orders a report: the report row and its job commit together, or neither does.
 * @param {string} reportId
 * @returns {Promise<boolean>} False: the report was ordered before.
 */
export async function orderReport(reportId) {
    const connection = await appPool.getConnection();

    try {
        await connection.beginTransaction();
        await connection.query('INSERT INTO reports (id, status) VALUES (?, ?)', [reportId, 'ordered']);

        const { created } = await sqlane.enqueue(connection, buildReport, { reportId }, {
            jobId: reportId, // one job per report while its row exists
            delay: '10s',
        });

        await connection.commit();

        return created;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Sends a newsletter: one job per recipient, in one INSERT, outside any transaction (a pool).
 * @param {string[]} emails
 * @returns {Promise<number>} The jobs added.
 */
export async function sendNewsletter(emails) {
    const results = await sqlane.enqueueMany(appPool, sendEmail, emails.map(email => ({
        payload: { to: email, template: 'newsletter' },
        options: { jobId: `newsletter-2026-11:${email}` },
    })));

    return results.filter(result => result.created).length;
}
