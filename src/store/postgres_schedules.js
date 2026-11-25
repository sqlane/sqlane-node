// The schedules on PostgreSQL: their rows, and the fire of their slots. See docs/design.md › Schedules.
import { runFire } from './fire_slots.js';
import { fairGroupColumn, toJobInput } from './postgres_enqueue.js';

/** Rows per statement of the registration */
const CHUNK_SIZE = 500;
const NOW_MS = 'floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint';
/**
 * @param {string} column
 * @returns {string} Its epoch ms.
 */
const epochMs = column => `floor(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`;

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./fire_slots.js').ScheduleRow} ScheduleRow */

/**
 * @param {Record<string, unknown>} row
 * @returns {ScheduleRow}
 */
function toScheduleRow(row) {
    return {
        id: String(row.id),
        lane: String(row.lane),
        spec: String(row.spec),
        lastSlotMs: Number(row.last_slot_ms),
        lastJobId: row.last_job_id === null ? null : String(row.last_job_id),
        pausedAtMs: row.paused_at_ms === null ? null : Number(row.paused_at_ms),
    };
}

/**
 * Inserts the jobs of slots of several lanes, in one statement, with one NOTIFY per lane that got a job. The CTE of
 * `insertJobsPostgres` with another NOTIFY step: the enqueue statement stays as it is.
 * @param {Executor} executor
 * @param {string} p The table prefix.
 * @param {import('../new_job.js').NewJob[]} jobs Their ids are distinct.
 * @param {{ enqueueToken: string, notifyChannel: string | null }} options
 * @returns {Promise<Set<string>>} The ids that this call created.
 */
export async function insertScheduledJobsPostgres(executor, p, jobs, { enqueueToken, notifyChannel }) {
    const group = fairGroupColumn(jobs);
    const rows = await executor.query(`
        WITH input AS (
            SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS r(
                  id text, lane text, payload text, limit_keys text[], limit_maxes integer[], rate_limits jsonb,
                  max_attempts integer, max_stalls integer, completed_retention_ms bigint, failed_retention_ms bigint,
                  delay_ms bigint, run_at timestamptz${group && ', fair_group text'}
            )
        ),
        inserted AS (
            INSERT INTO ${p}jobs (id, lane, status, run_at, max_attempts, max_stalls, limit_keys, limit_maxes,
                rate_limits, enqueue_token, completed_retention_ms, failed_retention_ms, created_at, updated_at${group})
            SELECT id, lane, 'pending',
                   -- Truncated: timestamptz(3) rounds, and a rounded-up time is not due for the claim
                   COALESCE(run_at, date_trunc('milliseconds', clock_timestamp() + delay_ms * interval '1 millisecond')),
                   max_attempts, max_stalls, limit_keys, limit_maxes, rate_limits, $2, completed_retention_ms,
                   failed_retention_ms, clock_timestamp(), clock_timestamp()${group}
              FROM input ORDER BY id
            ON CONFLICT (id) DO NOTHING
            RETURNING id, lane
        ),
        payloads AS (
            INSERT INTO ${p}payloads (id, payload)
            SELECT input.id, input.payload::jsonb FROM input JOIN inserted ON inserted.id = input.id
            ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload
        ),
        -- One NOTIFY per lane that got a job: PostgreSQL drops only a repeat of the same channel and message
        notified AS (
            SELECT pg_notify($3, d.lane)
              FROM (SELECT DISTINCT lane FROM inserted) AS d
             WHERE $3::text IS NOT NULL
        )
        -- The reference runs the NOTIFY step: a SELECT in WITH runs only when it is read
        SELECT id FROM inserted WHERE (SELECT count(*) FROM notified) >= 0
    `, [JSON.stringify(jobs.map(toJobInput)), enqueueToken, notifyChannel]);

    return new Set(rows.map(row => String(row.id)));
}

/** @type {import('./fire_slots.js').FireStatements} */
const STATEMENTS = {
    insertMissing: async (executor, p, candidates) => {
        await executor.query(`
            INSERT INTO ${p}schedules (id, lane, spec, last_slot_at, created_at, updated_at)
            SELECT i.id, i.lane, i.spec, 'epoch'::timestamptz, clock_timestamp(), clock_timestamp()
              FROM jsonb_to_recordset($1::text::jsonb) AS i(id text, lane text, spec text) ORDER BY i.id
            ON CONFLICT (id) DO NOTHING
        `, [JSON.stringify(candidates.map(({ id, lane, spec }) => ({ id, lane, spec })))]);
    },
    lockRows: async (executor, p, ids) => {
        const rows = await executor.query(`
            SELECT id, lane, spec, last_job_id, ${epochMs('last_slot_at')} AS last_slot_ms,
                   ${epochMs('paused_at')} AS paused_at_ms, ${NOW_MS} AS db_now_ms
              FROM ${p}schedules WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE SKIP LOCKED
        `, [ids]);

        return { dbNowMs: rows.length ? Number(rows[0].db_now_ms) : null, rows: rows.map(toScheduleRow) };
    },
    findUnfinishedJobs: async (executor, p, jobIds) => {
        const rows = await executor.query(`
            SELECT id FROM ${p}jobs WHERE id = ANY($1::text[]) AND status IN ('pending', 'running')
        `, [jobIds]);

        return new Set(rows.map(row => String(row.id)));
    },
    insertJobs: insertScheduledJobsPostgres,
    updateCursors: async (executor, p, winners) => {
        await executor.query(`
            UPDATE ${p}schedules AS s
               SET last_slot_at = w.slot_at, spec = w.spec, lane = w.lane,
                   last_job_id = COALESCE(w.job_id, s.last_job_id), updated_at = clock_timestamp()
              FROM jsonb_to_recordset($1::text::jsonb) AS w(id text, slot_at timestamptz, spec text, lane text,
                   job_id text)
             WHERE s.id = w.id
        `, [JSON.stringify(winners.map(winner => ({
            id: winner.id,
            slot_at: new Date(winner.slot).toISOString(),
            spec: winner.spec,
            lane: winner.lane,
            job_id: winner.jobId,
        })))]);
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
        SELECT s.id, s.lane, s.spec, s.last_job_id, ${epochMs('s.last_slot_at')} AS last_slot_ms,
               ${epochMs('s.paused_at')} AS paused_at_ms, ${NOW_MS} AS db_now_ms
          FROM (SELECT 1) AS one
          LEFT JOIN ${p}schedules AS s ON $1::text[] IS NULL OR s.id = ANY($1::text[])
         ORDER BY s.id
    `, [ids]);
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
 * @param {{ id: string, lane: string, spec: string }[]} schedules
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
            INSERT INTO ${p}schedules (id, lane, spec, last_slot_at, created_at, updated_at)
            SELECT i.id, i.lane, i.spec, date_trunc('milliseconds', clock_timestamp()), clock_timestamp(),
                   clock_timestamp()
              FROM jsonb_to_recordset($1::text::jsonb) AS i(id text, lane text, spec text) ORDER BY i.id
            ON CONFLICT (id) DO NOTHING
        `, [JSON.stringify(chunk.map(({ id, lane, spec }) => ({ id, lane, spec })))]);

        // oxlint-disable-next-line no-await-in-loop -- one chunk after the other
        const read = await readSchedules(executor, p, chunk.map(({ id }) => id), now);

        rows.push(...read.rows);
        clock = read.clock;
    }

    return { clock: /** @type {import('./fire_slots.js').ClockSample} */ (clock), rows };
}

/**
 * @param {Executor} executor In a queue transaction.
 * @param {string} p
 * @param {import('./fire_slots.js').FireParams} params
 * @returns {Promise<import('./fire_slots.js').FireResult>}
 */
export function fireSlots(executor, p, params) {
    return runFire(executor, p, STATEMENTS, params);
}
