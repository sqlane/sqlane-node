export type SlotCandidate = {
    /**
     * The schedule id.
     */
    id: string;
    /**
     * The job name.
     */
    name: string;
    /**
     * The normalized spec of this process.
     */
    spec: string;
    slot: number;
    /**
     * When its job is due: the slot plus its jitter; the slot without jitter.
     */
    due: number;
    missed: 'once' | 'skip';
    overlap: 'allow' | 'skip';
    /**
     * A late slot runs only if the cursor is at least this.
     */
    catchUpFrom: number;
    /**
     * The row is missing (after a recheck): insert it first.
     */
    insertMissing?: boolean;
};
export type ScheduleRow = {
    id: string;
    jobName: string;
    spec: string;
    /**
     * The cursor: the last decided slot.
     */
    lastSlotMs: number;
    lastJobId: string | null;
};
export type ClockSample = {
    dbNowMs: number;
    sentAt: number;
    receivedAt: number;
};
export type DecidedSlot = {
    id: string;
    name: string;
    slot: number;
    late: boolean;
    outcome: 'enqueued' | 'skipped' | 'lost' | 'dropped';
    /**
     * The job of the slot: null unless enqueued.
     */
    jobId: string | null;
    /**
     * The job was added by this fire: false when it existed already.
     */
    created: boolean;
};
export type FireResult = {
    /**
     * Null: no row came back from the lock pass.
     */
    clock: ClockSample | null;
    decided: DecidedSlot[];
    /**
     * The ids that another transaction holds, or whose row is missing.
     */
    busy: string[];
    /**
     * The ids whose slot is ahead of the database clock.
     */
    deferred: string[];
};
export type FireParams = {
    /**
     * Sorted by id, distinct.
     */
    candidates: SlotCandidate[];
    buildJob: (candidate: SlotCandidate, late: boolean) => import('../new_job.js').NewJob;
    /**
     * PostgreSQL NOTIFY.
     */
    notifyChannel: string | null;
    /**
     * The clock of the process, for the samples.
     */
    now: () => number;
    /**
     * A slot is on time while the database time minus the slot is at most this.
     */
    graceMs: number;
    /**
     * A slot more than this ahead of the database time is deferred.
     */
    futureMs: number;
    /**
     * For tests.
     */
    hooks?: {
        afterLock?: () => Promise<void>;
        afterInsert?: () => Promise<void>;
    };
};
export type FireStatements = {
    /**
     * Inserts
     * the missing rows with a cursor at 1970, sorted by id: an existing row stays.
     */
    insertMissing: (executor: Executor, p: string, candidates: SlotCandidate[]) => Promise<void>;
    /**
     * `FOR UPDATE SKIP
     * LOCKED`, in id order.
     */
    lockRows: (executor: Executor, p: string, ids: string[]) => Promise<LockedRows>;
    /**
     * The ids
     * of the jobs that are pending or running.
     */
    findUnfinishedJobs: (executor: Executor, p: string, jobIds: string[]) => Promise<Set<string>>;
    /**
     * All names in one call. The ids that it created.
     */
    insertJobs: (executor: Executor, p: string, jobs: NewJob[], options: InsertOptions) => Promise<Set<string>>;
    updateCursors: (executor: Executor, p: string, winners: Winner[]) => Promise<void>;
};
export type Executor = import('../types.js').Executor;
export type NewJob = import('../new_job.js').NewJob;
export type InsertOptions = {
    enqueueToken: string;
    notifyChannel: string | null;
};
export type LockedRows = {
    dbNowMs: number | null;
    rows: ScheduleRow[];
};
export type Winner = {
    id: string;
    name: string;
    spec: string;
    slot: number;
    /**
     * Null: keep the last job.
     */
    jobId: string | null;
};
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
export declare function decideSlot(candidate: SlotCandidate, row: ScheduleRow, dbNowMs: number, { graceMs, futureMs }: {
    graceMs: number;
    futureMs: number;
}): 'deferred' | 'lost' | 'on_time' | 'late' | 'dropped';
/**
 * Locks the rows of the candidates, decides each slot, inserts the jobs of the winners and moves their cursors. Call it
 * in a queue transaction.
 * @param {import('../types.js').Executor} executor
 * @param {string} p The table prefix.
 * @param {FireStatements} statements
 * @param {FireParams} params
 * @returns {Promise<FireResult>}
 */
export declare function runFire(executor: import('../types.js').Executor, p: string, statements: FireStatements, params: FireParams): Promise<FireResult>;
