// The schedules on MySQL, and on MariaDB (mariadb_schedules.js): their rows, and the fire of their slots. The SQL is
// the same on both; only the insert of the jobs differs. See docs/design.md › Schedules.
import { runFire } from './fire_slots.js';
import { insertJobsMysql } from './mysql_enqueue.js';

/** Rows per statement of the registration */
const CHUNK_SIZE = 500;
const EPOCH = '\'1970-01-01\'';
const NOW_MS = `TIMESTAMPDIFF(MICROSECOND, ${EPOCH}, UTC_TIMESTAMP(3)) DIV 1000`;
const LAST_SLOT_MS = `TIMESTAMPDIFF(MICROSECOND, ${EPOCH}, s.last_slot_at) DIV 1000`;

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./fire_slots.js').ScheduleRow} ScheduleRow */

/**
 * @param {number} ms
 * @returns {string} The UTC time, as DATETIME(3) reads it.
 */
function toUtcDatetime(ms) {
    return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * @param {readonly unknown[]} values
 * @returns {string}
 */
const placeholders = values => values.map(() => '?').join(', ');

/**
 * @param {Record<string, unknown>} row
 * @returns {ScheduleRow}
 */
function toScheduleRow(row) {
    return {
        id: String(row.id),
        jobName: String(row.job_name),
        spec: String(row.spec),
        lastSlotMs: Number(row.last_slot_ms),
        lastJobId: row.last_job_id === null ? null : String(row.last_job_id),
    };
}

/** @type {Omit<import('./fire_slots.js').FireStatements, 'insertJobs'>} */
const STATEMENTS = {
    insertMissing: async (executor, p, candidates) => {
        await executor.query(`
            INSERT INTO ${p}schedules (id, job_name, spec, last_slot_at, created_at, updated_at)
            VALUES ${candidates.map(() => `(?, ?, ?, ${EPOCH}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`).join(', ')}
            ON DUPLICATE KEY UPDATE id = id
        `, candidates.flatMap(({ id, name, spec }) => [id, name, spec]));
    },
    lockRows: async (executor, p, ids) => {
        // FORCE INDEX: a locking read has no semi-consistent read, a scan would lock other rows
        const rows = await executor.query(`
            SELECT s.id, s.job_name, s.spec, s.last_job_id, ${LAST_SLOT_MS} AS last_slot_ms, ${NOW_MS} AS db_now_ms
              FROM ${p}schedules s FORCE INDEX (PRIMARY)
             WHERE s.id IN (${placeholders(ids)}) ORDER BY s.id FOR UPDATE SKIP LOCKED
        `, ids);

        return { dbNowMs: rows.length ? Number(rows[0].db_now_ms) : null, rows: rows.map(toScheduleRow) };
    },
    findUnfinishedJobs: async (executor, p, jobIds) => {
        const rows = await executor.query(`
            SELECT id FROM ${p}jobs WHERE id IN (${placeholders(jobIds)}) AND status IN ('pending', 'running')
        `, jobIds);

        return new Set(rows.map(row => String(row.id)));
    },
    updateCursors: async (executor, p, winners) => {
        const cases = winners.map(() => 'WHEN ? THEN ?').join(' ');
        /**
         * @param {(winner: import('./fire_slots.js').Winner) => unknown} value
         * @returns {unknown[]}
         */
        const params = value => winners.flatMap(winner => [winner.id, value(winner)]);
        const withJob = winners.filter(winner => winner.jobId !== null);

        await executor.query(`
            UPDATE ${p}schedules FORCE INDEX (PRIMARY)
               SET last_slot_at = CASE id ${cases} END,
                   spec = CASE id ${cases} END,
                   job_name = CASE id ${cases} END,
                   ${withJob.length ? `last_job_id = CASE id ${withJob.map(() => 'WHEN ? THEN ?').join(' ')} ELSE last_job_id END,` : ''}
                   updated_at = UTC_TIMESTAMP(3)
             WHERE id IN (${placeholders(winners)})
        `, [
            ...params(winner => toUtcDatetime(winner.slot)),
            ...params(winner => winner.spec),
            ...params(winner => winner.name),
            ...withJob.flatMap(winner => [winner.id, winner.jobId]),
            ...winners.map(winner => winner.id),
        ]);
    },
};

/**
 * Reads rows of schedules, without a lock, and the database clock: also when no row matches.
 * @param {Executor} executor
 * @param {string} p
 * @param {string[] | null} ids Null: every row.
 * @param {() => number} now The clock of the process.
 * @returns {Promise<{ clock: import('./fire_slots.js').ClockSample, rows: ScheduleRow[] }>} Sorted by id.
 */
export async function readSchedules(executor, p, ids, now) {
    const sentAt = now();
    const rows = await executor.query(`
        SELECT s.id, s.job_name, s.spec, s.last_job_id, ${LAST_SLOT_MS} AS last_slot_ms, ${NOW_MS} AS db_now_ms
          FROM (SELECT 1 AS one) AS one
          LEFT JOIN ${p}schedules s ON ${ids === null ? 'TRUE' : `s.id IN (${placeholders(ids)})`}
         ORDER BY s.id
    `, ids ?? []);
    const receivedAt = now();

    return {
        clock: { dbNowMs: Number(rows[0].db_now_ms), sentAt, receivedAt },
        rows: rows.filter(row => row.id !== null).map(toScheduleRow),
    };
}

/**
 * Inserts the missing rows of the schedules, with the database time as their cursor, then reads them all.
 * @param {Executor} executor
 * @param {string} p
 * @param {{ id: string, name: string, spec: string }[]} schedules
 * @param {() => number} now
 * @returns {Promise<{ clock: import('./fire_slots.js').ClockSample, rows: ScheduleRow[] }>}
 */
export async function registerSchedules(executor, p, schedules, now) {
    const sorted = schedules.toSorted((a, b) => (a.id < b.id ? -1 : 1));
    /** @type {ScheduleRow[]} */
    const rows = [];
    let clock = null;

    for (let start = 0; start < sorted.length; start += CHUNK_SIZE) {
        const chunk = sorted.slice(start, start + CHUNK_SIZE);

        // oxlint-disable-next-line no-await-in-loop -- one chunk after the other, in id order
        await executor.query(`
            INSERT INTO ${p}schedules (id, job_name, spec, last_slot_at, created_at, updated_at)
            VALUES ${chunk.map(() => '(?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))').join(', ')}
            ON DUPLICATE KEY UPDATE id = id
        `, chunk.flatMap(({ id, name, spec }) => [id, name, spec]));

        // oxlint-disable-next-line no-await-in-loop -- one chunk after the other
        const read = await readSchedules(executor, p, chunk.map(({ id }) => id), now);

        rows.push(...read.rows);
        clock = read.clock;
    }

    return { clock: /** @type {import('./fire_slots.js').ClockSample} */ (clock), rows };
}

/**
 * @typedef {(executor: Executor, p: string, params: import('./fire_slots.js').FireParams)
 *     => Promise<import('./fire_slots.js').FireResult>} FireSlots Call it in a queue transaction.
 */

/**
 * The fire of the slots, with the insert of the jobs of a dialect.
 * @param {typeof insertJobsMysql} insertJobs
 * @returns {FireSlots}
 */
export function fireSlotsWith(insertJobs) {
    /** @type {import('./fire_slots.js').FireStatements} */
    const statements = {
        ...STATEMENTS,
        insertJobs: (executor, p, jobs, { enqueueToken }) => insertJobs(executor, p, jobs, enqueueToken),
    };

    return (executor, p, params) => runFire(executor, p, statements, params);
}

/** @type {FireSlots} */
export const fireSlots = fireSlotsWith(insertJobsMysql);
