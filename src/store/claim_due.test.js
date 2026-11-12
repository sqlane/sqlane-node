import { describe, expect, test } from 'vitest';
import * as mariadbWorker from './mariadb_worker.js';
import * as mysqlWorker from './mysql_worker.js';

/** @typedef {{ sql: string, params: readonly unknown[] }} Sent */

/**
 * @param {string} id
 * @param {string | null} payload Null: the statement did not see it.
 * @returns {Record<string, unknown>} A row of the claim statement (MariaDB reads payload_found from the payload).
 */
function lockedRow(id, payload) {
    return {
        id,
        job_name: 'a',
        run_at_ms: 1000,
        attempts: 0,
        max_attempts: 3,
        stalls: 0,
        max_stalls: 1,
        failure_job: null,
        created_at_ms: 1000,
        has_keys: 0,
        waited_ms: 5,
        payload,
        payload_found: payload === null ? 0 : 1,
    };
}

/**
 * Claims through a fake executor: the claim statement gives `rows`, a read of payloads gives `payloads`.
 * @param {typeof mysqlWorker.claimDue} claimDue
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, string>} payloads By id, as JSON: what a new statement sees.
 * @returns {Promise<{ result: import('./store.js').ClaimDueResult, sent: Sent[] }>}
 */
async function claimWith(claimDue, rows, payloads) {
    /** @type {Sent[]} */
    const sent = [];
    const result = await claimDue({
        query: async (sql, params) => {
            sent.push({ sql, params });

            if (sql.includes('SKIP LOCKED')) {
                return rows;
            }

            if (sql.includes('FROM sqlane_payloads WHERE')) {
                return params.filter(id => String(id) in payloads)
                    .map(id => ({ id, payload: payloads[String(id)] }));
            }

            return [];
        },
        run: async () => 0,
    }, 'sqlane_', {
        requests: [{ name: 'a', maxJobs: 5, lane: 0 }],
        laneFree: [5],
        processMax: 10,
        lockToken: 'T',
        lockedBy: 'test:T',
        leaseMs: 60_000,
    });

    return { result, sent };
}

describe.each([
    ['mysql', mysqlWorker.claimDue],
    ['mariadb', mariadbWorker.claimDue],
])('%s', (_, claimDue) => {
    test('a job locked without its payload: the claim reads it again, in a new statement of the transaction', async () => {
        // The enqueue of j2 committed after the statement's read view: its job row is locked, its payload read as NULL
        const { result, sent } = await claimWith(
            claimDue,
            [lockedRow('j1', '{"n":1}'), lockedRow('j2', null), lockedRow('j3', null)],
            { j1: '{"n":1}', j2: '{"n":2}' },
        );

        expect(result.jobs.map(job => [job.id, job.payload])).toStrictEqual([
            ['j1', { found: true, payload: { n: 1 } }],
            ['j2', { found: true, payload: { n: 2 } }],
            ['j3', { found: false, payload: undefined }],
        ]);

        const reads = sent.filter(({ sql }) => sql.includes('FROM sqlane_payloads WHERE'));

        expect(reads.map(({ params }) => params)).toStrictEqual([['j2', 'j3']]);
        expect(sent.findIndex(({ sql }) => sql.includes('FROM sqlane_payloads WHERE')))
            .toBeLessThan(sent.findIndex(({ sql }) => sql.includes('UPDATE sqlane_jobs')));
    });

    test('every payload seen: no second read', async () => {
        const { result, sent } = await claimWith(claimDue, [lockedRow('j1', '{"n":1}'), lockedRow('j2', '{"n":2}')], {});

        expect(result.jobs.map(job => job.payload.found)).toStrictEqual([true, true]);
        // The claim, the update, the probe
        expect(sent).toHaveLength(3);
        expect(sent.some(({ sql }) => sql.includes('FROM sqlane_payloads WHERE'))).toBe(false);
    });
});
