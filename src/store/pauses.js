// The global pauses: the paused lanes (`<p>paused_lanes`) and the pause of a schedule (`<p>schedules.paused_at`).
// Each write is one statement, on the caller's connection or the queue's pool. The claims read the paused lanes in
// their own statements: a filter on `<p>paused_lanes` (notPaused).

/** @typedef {import('../types.js').Executor} Executor */

/**
 * The filter of the claims: the lane is not paused. A subquery, never a join: it reads the primary key of
 * `<p>paused_lanes`, at most one row; a lane given as a parameter makes it uncorrelated (run once per statement).
 * @param {string} p
 * @param {string} lane The SQL of the lane: a column, qualified, or a parameter.
 * @returns {string}
 */
export const notPaused = (p, lane) => `NOT EXISTS (SELECT 1 FROM ${p}paused_lanes pl WHERE pl.lane = ${lane})`;

/** Above it, the paused lanes of a probe are checked with the subquery, not as parameters */
export const MAX_PAUSED_PARAMS = 50;

/**
 * MySQL and MariaDB: the filter of the paused lanes in a read of the blocked jobs (the head of a key, the jobs that an
 * unblock takes), by the paused lanes that the last probe of the process saw. No pause seen: no filter, so no subquery
 * to plan in the statement. None seen yet (no probe: a process without a runner): the subquery of `notPaused`. A pause
 * after the probe holds until the next probe: a blocked job of its lane can head a key for one turn.
 * @param {string} p
 * @param {string} lane The column of the lane, qualified.
 * @param {readonly string[] | null | undefined} paused The paused lanes of the last probe; null: no probe yet.
 * @returns {{ sql: string, params: string[] }} ` AND …`, or nothing; and its parameters.
 */
export function pausedFilter(p, lane, paused) {
    // Many paused lanes: the subquery, not as many parameters in each branch
    if (paused === null || paused === undefined || paused.length > MAX_PAUSED_PARAMS) {
        return { sql: ` AND ${notPaused(p, lane)}`, params: [] };
    }

    if (!paused.length) {
        return { sql: '', params: [] };
    }

    return { sql: ` AND ${lane} NOT IN (${paused.map(() => '?').join(', ')})`, params: [...paused] };
}

/**
 * @typedef {object} PauseSql The statements of a dialect family.
 * @property {(p: string) => string} pauseLane Keeps the time of the first pause.
 * @property {(p: string) => string} resumeLane
 * @property {(p: string) => string} readPausedLanes
 * @property {(p: string) => string} blockedKeysOfLane
 * @property {(p: string) => string} pauseSchedule No row: a paused one, with its cursor at the pause. A row: paused,
 *     once; its cursor and spec kept.
 * @property {(p: string) => string} resumeSchedule A paused row only: its cursor moves to now (no catch-up), unless
 *     it is ahead.
 * @property {(p: string) => string} removeSchedule
 */

/** @type {Record<'mysql' | 'postgres', PauseSql>} */
const SQL = {
    postgres: {
        pauseLane: p => `INSERT INTO ${p}paused_lanes (lane, paused_at) VALUES ($1, clock_timestamp())
            ON CONFLICT (lane) DO NOTHING`,
        resumeLane: p => `DELETE FROM ${p}paused_lanes WHERE lane = $1`,
        readPausedLanes: p => `SELECT lane FROM ${p}paused_lanes`,
        blockedKeysOfLane: p => `SELECT DISTINCT blocked_on FROM ${p}jobs WHERE status = 'blocked' AND lane = $1`,
        pauseSchedule: p => `
            WITH t AS MATERIALIZED (
                SELECT date_trunc('milliseconds', clock_timestamp()) AS now
            )
            INSERT INTO ${p}schedules AS s (id, lane, spec, last_slot_at, created_at, updated_at, paused_at)
            SELECT $1, $2, $3, t.now, t.now, t.now, t.now FROM t
            ON CONFLICT (id) DO UPDATE
               SET updated_at = CASE WHEN s.paused_at IS NULL THEN EXCLUDED.updated_at ELSE s.updated_at END,
                   paused_at = COALESCE(s.paused_at, EXCLUDED.paused_at)`,
        resumeSchedule: p => `
            UPDATE ${p}schedules
               SET paused_at = NULL, last_slot_at = GREATEST(last_slot_at, date_trunc('milliseconds', clock_timestamp())),
                   updated_at = clock_timestamp()
             WHERE id = $1 AND paused_at IS NOT NULL`,
        removeSchedule: p => `DELETE FROM ${p}schedules WHERE id = $1`,
    },
    // MySQL and MariaDB. UTC_TIMESTAMP is the time of the statement: one value in it
    mysql: {
        pauseLane: p => `INSERT INTO ${p}paused_lanes (lane, paused_at) VALUES (?, UTC_TIMESTAMP(3))
            ON DUPLICATE KEY UPDATE paused_at = paused_at`,
        resumeLane: p => `DELETE FROM ${p}paused_lanes WHERE lane = ?`,
        readPausedLanes: p => `SELECT lane FROM ${p}paused_lanes`,
        blockedKeysOfLane: p => `SELECT DISTINCT blocked_on FROM ${p}jobs WHERE status = 'blocked' AND lane = ?`,
        // updated_at first: MySQL sets the columns from left to right, and it reads the old paused_at
        pauseSchedule: p => `
            INSERT INTO ${p}schedules (id, lane, spec, last_slot_at, created_at, updated_at, paused_at)
            VALUES (?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
            ON DUPLICATE KEY UPDATE updated_at = IF(paused_at IS NULL, UTC_TIMESTAMP(3), updated_at),
                paused_at = COALESCE(paused_at, UTC_TIMESTAMP(3))`,
        resumeSchedule: p => `
            UPDATE ${p}schedules
               SET paused_at = NULL, last_slot_at = GREATEST(last_slot_at, UTC_TIMESTAMP(3)),
                   updated_at = UTC_TIMESTAMP(3)
             WHERE id = ? AND paused_at IS NOT NULL`,
        removeSchedule: p => `DELETE FROM ${p}schedules WHERE id = ?`,
    },
};

/**
 * @typedef {object} PauseStore
 * @property {(lane: string, connection?: unknown) => Promise<void>} pauseLane
 * @property {(lane: string, connection?: unknown) => Promise<boolean>} resumeLane True: the lane was paused.
 * @property {() => Promise<string[]>} readPausedLanes The paused lanes, in no order.
 * @property {(lane: string) => Promise<string[]>} blockedKeysOfLane The keys of its blocked jobs, once each: they
 *     scan the blocked jobs.
 * @property {(schedule: { id: string, lane: string, spec: string }, connection?: unknown) => Promise<void>}
 *     pauseSchedule
 * @property {(id: string, connection?: unknown) => Promise<boolean>} resumeSchedule True: the row was paused.
 * @property {(id: string, connection?: unknown) => Promise<boolean>} removeSchedule True: the row was there.
 */

/**
 * @param {import('../types.js').Adapter<any>} adapter
 * @param {string} p
 * @returns {PauseStore}
 */
export function createPauseStore(adapter, p) {
    const sql = SQL[adapter.dialect === 'postgres' ? 'postgres' : 'mysql'];
    /**
     * @param {unknown} connection
     * @returns {Executor} The caller's connection, or the queue's pool.
     */
    const on = connection => (connection === undefined ? adapter.queue : adapter.wrap(connection));

    return {
        pauseLane: async (lane, connection) => {
            await on(connection).query(sql.pauseLane(p), [lane]);
        },
        resumeLane: async (lane, connection) => await on(connection).run(sql.resumeLane(p), [lane]) > 0,
        readPausedLanes: async () => (await adapter.queue.query(sql.readPausedLanes(p), []))
            .map(row => String(row.lane)),
        blockedKeysOfLane: async lane => (await adapter.queue.query(sql.blockedKeysOfLane(p), [lane]))
            .map(row => String(row.blocked_on)),
        pauseSchedule: async ({ id, lane, spec }, connection) => {
            await on(connection).query(sql.pauseSchedule(p), [id, lane, spec]);
        },
        resumeSchedule: async (id, connection) => await on(connection).run(sql.resumeSchedule(p), [id]) > 0,
        removeSchedule: async (id, connection) => await on(connection).run(sql.removeSchedule(p), [id]) > 0,
    };
}
