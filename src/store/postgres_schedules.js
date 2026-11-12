// The schedules on PostgreSQL: their rows, and the fire of their slots. See docs/design.md › Schedules.
import { runFire } from './fire_slots.js';
import { toJobInput } from './postgres_enqueue.js';

/** Rows per statement of the registration */
const CHUNK_SIZE = 500;
const NOW_MS = 'floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint';

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('./fire_slots.js').ScheduleRow} ScheduleRow */

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

/**
 * Inserts the jobs of slots of several names, in one statement, with one NOTIFY per name that got a job. The CTE of
 * `insertJobsPostgres` with another NOTIFY step: the enqueue statement stays as it is.
 * @param {Executor} executor
 * @param {string} p The table prefix.
 * @param {import('../new_job.js').NewJob[]} jobs Their ids are distinct.
 * @param {{ enqueueToken: string, notifyChannel: string | null }} options
 * @returns {Promise<Set<string>>} The ids that this call created.
 */
export async function insertScheduledJobsPostgres(executor, p, jobs, { enqueueToken, notifyChannel }) {
    const rows = await executor.query(`
        WITH input AS (
            SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS r(
                  id text, job_name text, payload jsonb, mutex_keys text[], max_attempts integer,
                  max_stalls integer, completed_retention_ms bigint, failed_retention_ms bigint, failure_job text,
                  delay_ms bigint, run_at timestamptz
            )
        ),
        inserted AS (
            INSERT INTO ${p}jobs (id, job_name, status, run_at, max_attempts, max_stalls, mutex_keys, enqueue_token,
                completed_retention_ms, failed_retention_ms, failure_job, created_at, updated_at)
            SELECT id, job_name, 'pending',
                   -- Truncated: timestamptz(3) rounds, and a rounded-up time is not due for the claim
                   COALESCE(run_at, date_trunc('milliseconds', clock_timestamp() + delay_ms * interval '1 millisecond')),
                   max_attempts, max_stalls, mutex_keys, $2, completed_retention_ms, failed_retention_ms, failure_job,
                   clock_timestamp(), clock_timestamp()
              FROM input ORDER BY id
            ON CONFLICT (id) DO NOTHING
            RETURNING id, run_at, job_name, mutex_keys
        ),
        job_keys AS (
            INSERT INTO ${p}job_keys (mutex_key, run_at, job_id, job_name)
            SELECT k.mutex_key, inserted.run_at, inserted.id, inserted.job_name
              FROM inserted CROSS JOIN LATERAL unnest(inserted.mutex_keys) AS k(mutex_key)
            ON CONFLICT DO NOTHING
        ),
        payloads AS (
            INSERT INTO ${p}payloads (id, payload)
            SELECT input.id, input.payload FROM input JOIN inserted ON inserted.id = input.id
            ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload
        ),
        -- One NOTIFY per name that got a job: PostgreSQL drops only a repeat of the same channel and message
        notified AS (
            SELECT pg_notify($3, d.job_name)
              FROM (SELECT DISTINCT job_name FROM inserted) AS d
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
            INSERT INTO ${p}schedules (id, job_name, spec, last_slot_at, created_at, updated_at)
            SELECT i.id, i.job_name, i.spec, 'epoch'::timestamptz, clock_timestamp(), clock_timestamp()
              FROM jsonb_to_recordset($1::text::jsonb) AS i(id text, job_name text, spec text) ORDER BY i.id
            ON CONFLICT (id) DO NOTHING
        `, [JSON.stringify(candidates.map(({ id, name, spec }) => ({ id, job_name: name, spec })))]);
    },
    lockRows: async (executor, p, ids) => {
        const rows = await executor.query(`
            SELECT id, job_name, spec, last_job_id,
                   floor(EXTRACT(EPOCH FROM last_slot_at) * 1000)::bigint AS last_slot_ms, ${NOW_MS} AS db_now_ms
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
               SET last_slot_at = w.slot_at, spec = w.spec, job_name = w.job_name,
                   last_job_id = COALESCE(w.job_id, s.last_job_id), updated_at = clock_timestamp()
              FROM jsonb_to_recordset($1::text::jsonb) AS w(id text, slot_at timestamptz, spec text, job_name text,
                   job_id text)
             WHERE s.id = w.id
        `, [JSON.stringify(winners.map(winner => ({
            id: winner.id,
            slot_at: new Date(winner.slot).toISOString(),
            spec: winner.spec,
            job_name: winner.name,
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
        SELECT s.id, s.job_name, s.spec, s.last_job_id,
               floor(EXTRACT(EPOCH FROM s.last_slot_at) * 1000)::bigint AS last_slot_ms, ${NOW_MS} AS db_now_ms
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
            SELECT i.id, i.job_name, i.spec, date_trunc('milliseconds', clock_timestamp()), clock_timestamp(),
                   clock_timestamp()
              FROM jsonb_to_recordset($1::text::jsonb) AS i(id text, job_name text, spec text) ORDER BY i.id
            ON CONFLICT (id) DO NOTHING
        `, [JSON.stringify(chunk.map(({ id, name, spec }) => ({ id, job_name: name, spec })))]);

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
