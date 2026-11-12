// The fire of the slots of schedules: one short queue transaction, the same steps on every dialect. The SQL of each
// dialect is in <dialect>_schedules.js. See docs/design.md › Schedules.
import { createMonotonicUlid } from '../ulid.js';

const enqueueToken = createMonotonicUlid();

/**
 * A slot that a process tries to enqueue.
 * @typedef {object} SlotCandidate
 * @property {string} id The schedule id.
 * @property {string} name The job name.
 * @property {string} spec The normalized spec of this process.
 * @property {number} slot
 * @property {number} due When its job is due: the slot plus its jitter; the slot without jitter.
 * @property {'once' | 'skip'} missed
 * @property {'allow' | 'skip'} overlap
 * @property {number} catchUpFrom A late slot runs only if the cursor is at least this.
 * @property {boolean} [insertMissing] The row is missing (after a recheck): insert it first.
 */

/**
 * The row of a schedule.
 * @typedef {object} ScheduleRow
 * @property {string} id
 * @property {string} jobName
 * @property {string} spec
 * @property {number} lastSlotMs The cursor: the last decided slot.
 * @property {string | null} lastJobId
 */

/**
 * A sample of the database clock: the local time before and after the statement that read it.
 * @typedef {object} ClockSample
 * @property {number} dbNowMs
 * @property {number} sentAt
 * @property {number} receivedAt
 */

/**
 * @typedef {object} DecidedSlot
 * @property {string} id
 * @property {string} name
 * @property {number} slot
 * @property {boolean} late
 * @property {'enqueued' | 'skipped' | 'lost' | 'dropped'} outcome
 * @property {string | null} jobId The job of the slot: null unless enqueued.
 * @property {boolean} created The job was added by this fire: false when it existed already.
 */

/**
 * @typedef {object} FireResult
 * @property {ClockSample | null} clock Null: no row came back from the lock pass.
 * @property {DecidedSlot[]} decided
 * @property {string[]} busy The ids that another transaction holds, or whose row is missing.
 * @property {string[]} deferred The ids whose slot is ahead of the database clock.
 */

/**
 * @typedef {object} FireParams
 * @property {SlotCandidate[]} candidates Sorted by id, distinct.
 * @property {(candidate: SlotCandidate, late: boolean) => import('../new_job.js').NewJob} buildJob
 * @property {string | null} notifyChannel PostgreSQL NOTIFY.
 * @property {() => number} now The clock of the process, for the samples.
 * @property {number} graceMs A slot is on time while the database time minus the slot is at most this.
 * @property {number} futureMs A slot more than this ahead of the database time is deferred.
 * @property {{ afterLock?: () => Promise<void>, afterInsert?: () => Promise<void> }} [hooks] For tests.
 */

/**
 * The SQL of a dialect.
 * @typedef {object} FireStatements
 * @property {(executor: Executor, p: string, candidates: SlotCandidate[]) => Promise<void>} insertMissing Inserts
 *     the missing rows with a cursor at 1970, sorted by id: an existing row stays.
 * @property {(executor: Executor, p: string, ids: string[]) => Promise<LockedRows>} lockRows `FOR UPDATE SKIP
 *     LOCKED`, in id order.
 * @property {(executor: Executor, p: string, jobIds: string[]) => Promise<Set<string>>} findUnfinishedJobs The ids
 *     of the jobs that are pending or running.
 * @property {(executor: Executor, p: string, jobs: NewJob[], options: InsertOptions) => Promise<Set<string>>}
 *     insertJobs All names in one call. The ids that it created.
 * @property {(executor: Executor, p: string, winners: Winner[]) => Promise<void>} updateCursors
 */

/** @typedef {import('../types.js').Executor} Executor */
/** @typedef {import('../new_job.js').NewJob} NewJob */
/** @typedef {{ enqueueToken: string, notifyChannel: string | null }} InsertOptions */
/** @typedef {{ dbNowMs: number | null, rows: ScheduleRow[] }} LockedRows */

/**
 * @typedef {object} Winner
 * @property {string} id
 * @property {string} name
 * @property {string} spec
 * @property {number} slot
 * @property {string | null} jobId Null: keep the last job.
 */

/**
 * The decision on a slot, under the lock of its row, with the database clock. The cursor and the catch-up reach count
 * in slots; on time and deferred, from the due time.
 * @param {SlotCandidate} candidate
 * @param {ScheduleRow} row
 * @param {number} dbNowMs
 * @param {{ graceMs: number, futureMs: number }} limits
 * @returns {'deferred' | 'lost' | 'on_time' | 'late' | 'dropped'}
 */
export function decideSlot(candidate, row, dbNowMs, { graceMs, futureMs }) {
    if (candidate.due > dbNowMs + futureMs) {
        return 'deferred';
    }

    if (row.lastSlotMs >= candidate.slot) {
        return 'lost';
    }

    if (dbNowMs - candidate.due <= graceMs) {
        return 'on_time';
    }

    if (candidate.missed === 'once' && row.spec === candidate.spec && row.lastSlotMs >= candidate.catchUpFrom) {
        return 'late';
    }

    return 'dropped';
}

/**
 * Locks the rows of the candidates, decides each slot, inserts the jobs of the winners and moves their cursors. Call it
 * in a queue transaction.
 * @param {import('../types.js').Executor} executor
 * @param {string} p The table prefix.
 * @param {FireStatements} statements
 * @param {FireParams} params
 * @returns {Promise<FireResult>}
 */
export async function runFire(executor, p, statements, params) {
    const { candidates, buildJob, notifyChannel, now, hooks } = params;
    const missing = candidates.filter(candidate => candidate.insertMissing);

    if (missing.length) {
        await statements.insertMissing(executor, p, missing);
    }

    const sentAt = now();
    const { dbNowMs, rows } = await statements.lockRows(executor, p, candidates.map(candidate => candidate.id));
    const clock = dbNowMs === null ? null : { dbNowMs, sentAt, receivedAt: now() };

    await hooks?.afterLock?.();

    const rowsById = new Map(rows.map(row => [row.id, row]));
    /** @type {FireResult} */
    const result = { clock, decided: [], busy: [], deferred: [] };
    /** @type {{ candidate: SlotCandidate, row: ScheduleRow, late: boolean }[]} */
    const winners = [];

    for (const candidate of candidates) {
        const row = rowsById.get(candidate.id);

        if (!row || dbNowMs === null) {
            result.busy.push(candidate.id);
            continue;
        }

        const decision = decideSlot(candidate, row, dbNowMs, params);

        if (decision === 'deferred') {
            result.deferred.push(candidate.id);
        } else if (decision === 'on_time' || decision === 'late') {
            winners.push({ candidate, row, late: decision === 'late' });
        } else {
            result.decided.push({
                id: candidate.id,
                name: candidate.name,
                slot: candidate.slot,
                late: dbNowMs - candidate.due > params.graceMs,
                outcome: decision,
                jobId: null,
                created: false,
            });
        }
    }

    if (!winners.length) {
        return result;
    }

    // Overlap: the last job of the schedule is not done
    const lastJobIds = winners
        .filter(({ candidate, row }) => candidate.overlap === 'skip' && row.lastJobId !== null)
        .map(({ row }) => /** @type {string} */ (row.lastJobId));
    const unfinished = lastJobIds.length ? await statements.findUnfinishedJobs(executor, p, lastJobIds) : new Set();
    const enqueued = winners.filter(({ candidate, row }) => candidate.overlap === 'allow' || row.lastJobId === null
        || !unfinished.has(row.lastJobId));
    const jobs = enqueued.map(({ candidate, late }) => buildJob(candidate, late));
    const created = jobs.length
        ? await statements.insertJobs(executor, p, jobs, { enqueueToken: enqueueToken(), notifyChannel })
        : new Set();

    await hooks?.afterInsert?.();

    /** @type {Map<string, string>} */
    const jobIdById = new Map(enqueued.map(({ candidate }, index) => [candidate.id, jobs[index].id]));

    await statements.updateCursors(executor, p, winners.map(({ candidate }) => ({
        id: candidate.id,
        name: candidate.name,
        spec: candidate.spec,
        slot: candidate.slot,
        jobId: jobIdById.get(candidate.id) ?? null,
    })));

    for (const { candidate, late } of winners) {
        const jobId = jobIdById.get(candidate.id) ?? null;

        result.decided.push({
            id: candidate.id,
            name: candidate.name,
            slot: candidate.slot,
            late,
            outcome: jobId === null ? 'skipped' : 'enqueued',
            jobId,
            created: jobId !== null && created.has(jobId),
        });
    }

    return result;
}
