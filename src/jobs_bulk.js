// The bulk methods of sqlane.jobs: retry, cancel and remove. The checks of their arguments, then one transaction
// (atomic) or one per batch: read the candidates without a lock, decide the ignored ids, lock the rest by primary key
// in id order with their status checked again, write guarded by the status. After the commit: the events, the wakes
// and the unblocks. The SQL is in store/job_writes.js.
import { IgnoredJobsError, InvalidOptionsError, JobCancelledError } from './errors.js';
import { toErrorJson } from './error_json.js';
import { isPossibleJobId, shown, statusesOf } from './jobs_api.js';
import {
    cancelJobs,
    lockJobs,
    notifyLanes,
    readBatch,
    readByFilter,
    readByIds,
    removeJobs,
    retryJobs,
} from './store/job_writes.js';
import { isRateKey } from './rate_keys.js';
import { isQuickRetryError } from './transient_error.js';
import { checkedLaneName } from './lane_names.js';
import { checkObject } from './validate.js';

/** @typedef {import('./types.js').JobStatus} JobStatus */
/** @typedef {import('./types.js').BulkIgnoredJob} BulkIgnoredJob */
/** @typedef {import('./types.js').BulkResult} BulkResult */
/** @typedef {import('./types.js').Executor} Executor */
/** @typedef {'retry' | 'cancel' | 'remove'} Operation */

/** @type {Record<Operation, readonly JobStatus[]>} The statuses that each operation changes, and its default */
export const ACCEPTED = {
    retry: ['failed'],
    cancel: ['pending', 'blocked'],
    remove: ['pending', 'blocked', 'completed', 'failed'],
};
const MAX_IDS = 1000;
/** The jobs of a batch */
const BATCH_SIZE = 1000;
/** The retries of an owned transaction after a deadlock, a serialization failure or a 1020, as the sweep's */
const MAX_TRANSIENT_RETRIES = 3;
/** The `last_error` of a cancelled job: no stack, the same for every job */
const CANCEL_ERROR_JSON = (() => {
    const { name, message, code } = toErrorJson(new JobCancelledError('Cancelled by jobs.cancel()'));

    return JSON.stringify({ name, message, code });
})();

/**
 * Runs func in a transaction of sqlane's own, again after a deadlock, a serialization failure or a 1020.
 * @template T
 * @param {(func: (executor: Executor) => Promise<T>) => Promise<T>} transaction
 * @param {(executor: Executor) => Promise<T>} func
 * @returns {Promise<T>}
 */
async function owned(transaction, func) {
    for (let retries = 0; ; retries++) {
        try {
            // oxlint-disable-next-line no-await-in-loop -- one try after the other
            return await transaction(func);
        } catch (error) {
            if (!isQuickRetryError(error) || retries >= MAX_TRANSIENT_RETRIES) {
                throw error;
            }
        }
    }
}

/**
 * The arguments of a call, checked.
 * @typedef {object} BulkCall
 * @property {string[] | null} ids The distinct ids, in the order of their first appearance. Null: a filter.
 * @property {{ lane: string, statuses: readonly JobStatus[] } | null} filter
 * @property {'atomic' | 'batches'} mode
 * @property {boolean} strict
 * @property {boolean} includeAffectedJobIds
 * @property {'reset' | 'one_more'} budget
 * @property {unknown} connection
 */

/**
 * @param {Operation} operation
 * @param {unknown} selector
 * @param {unknown} options
 * @returns {BulkCall}
 * @throws {InvalidOptionsError}
 */
export function checkBulk(operation, selector, options) {
    const where = `jobs.${operation}`;
    const scope = { where, ErrorClass: InvalidOptionsError };
    const { jobIds, lane, status } = checkObject(selector, ['jobIds', 'lane', 'status'], 'selector', scope);
    const optionNames = ['connection', 'mode', 'strict', 'includeAffectedJobIds',
        ...(operation === 'retry' ? ['budget'] : [])];
    const {
        connection,
        mode = 'atomic',
        strict = false,
        includeAffectedJobIds = false,
        budget = 'reset',
    } = checkObject(options ?? {}, optionNames, 'options', scope);

    if ((jobIds === undefined) === (lane === undefined)) {
        throw new InvalidOptionsError(`${where}: the selector takes "jobIds", or a filter with "lane", not both`);
    }

    if (jobIds !== undefined && status !== undefined) {
        throw new InvalidOptionsError(`${where}: "status" is for a filter, not for "jobIds"`);
    }

    if (mode !== 'atomic' && mode !== 'batches') {
        throw new InvalidOptionsError(`${where}: "mode" must be 'atomic' or 'batches', got ${shown(mode)}`);
    }

    if (budget !== 'reset' && budget !== 'one_more') {
        throw new InvalidOptionsError(`${where}: "budget" must be 'reset' or 'one_more', got ${shown(budget)}`);
    }

    if (typeof strict !== 'boolean') {
        throw new InvalidOptionsError(`${where}: "strict" must be a boolean, got ${shown(strict)}`);
    }

    if (typeof includeAffectedJobIds !== 'boolean') {
        throw new InvalidOptionsError(`${where}: "includeAffectedJobIds" must be a boolean, got ${
            shown(includeAffectedJobIds)}`);
    }

    const ids = jobIds === undefined ? null : idsOf(jobIds, where);
    const filter = lane === undefined ? null : filterOf(operation, lane, status, where);

    if (mode === 'batches' && (ids || connection !== undefined || strict)) {
        throw new InvalidOptionsError(`${where}: 'batches' takes a filter, without "connection" and "strict"`);
    }

    if (strict && filter) {
        throw new InvalidOptionsError(`${where}: "strict" is for "jobIds": a filter reports no ignored job`);
    }

    return { ids, filter, mode, strict, includeAffectedJobIds, budget, connection };
}

/**
 * @param {unknown} jobIds
 * @param {string} where
 * @returns {string[]} Distinct, in the order of their first appearance.
 */
function idsOf(jobIds, where) {
    if (!Array.isArray(jobIds)) {
        throw new InvalidOptionsError(`${where}: "jobIds" must be an array of strings`);
    }

    // A loop, not Array#some: it skips the holes of a sparse array
    for (const id of jobIds) {
        if (typeof id !== 'string') {
            throw new InvalidOptionsError(`${where}: "jobIds" must be an array of strings`);
        }
    }

    const ids = [...new Set(/** @type {string[]} */ (jobIds))];

    if (!ids.length || ids.length > MAX_IDS) {
        throw new InvalidOptionsError(`${where}: "jobIds" must have 1 to ${MAX_IDS} distinct ids, got ${ids.length}`);
    }

    return ids;
}

/**
 * @param {Operation} operation
 * @param {unknown} given A lane, or its definition.
 * @param {unknown} status
 * @param {string} where
 * @returns {{ lane: string, statuses: readonly JobStatus[] }}
 */
function filterOf(operation, given, status, where) {
    const lane = checkedLaneName(given, where, '"lane"');

    const accepted = ACCEPTED[operation];
    const statuses = statusesOf(status, where) ?? accepted;
    const others = statuses.filter(item => !accepted.includes(item));

    if (others.length) {
        throw new InvalidOptionsError(`${where}: "status" takes ${accepted.join(', ')}; it does not change ${
            others.join(', ')} jobs`);
    }

    return { lane, statuses };
}

/**
 * What a transaction changed, for the result and for the work after its commit.
 * @typedef {object} Outcome
 * @property {number} count
 * @property {string[]} ids The changed ids (on MySQL outside a transaction: the locked ones).
 * @property {BulkIgnoredJob[]} ignored
 * @property {{ id: string, lane: string, attempts: number }[]} cancelled
 * @property {string[]} lanes The lanes of the retried jobs.
 * @property {string[]} keys The concurrency keys of the pending jobs cancelled or removed.
 */

/**
 * @typedef {object} BulkDeps
 * @property {import('./store/store.js').Store} store
 * @property {import('./types.js').Adapter<any>} adapter
 * @property {string} tablePrefix
 * @property {(lane: string, committed: boolean) => void} wakeFor
 * @property {(keys: string[]) => Promise<void>} unblockKeys Never rejects.
 * @property {(event: import('./types.js').SqlaneEvent) => void} emit
 * @property {(operation: string, error: unknown) => void} reportError
 * @property {string | null} notifyChannel
 */

/**
 * @param {BulkDeps} deps
 * @returns {(operation: Operation, selector: unknown, options: unknown) => Promise<BulkResult>}
 */
export function createBulk({ adapter, tablePrefix: p, wakeFor, unblockKeys, emit, reportError, notifyChannel }) {
    const family = adapter.dialect === 'postgres' ? 'postgres' : 'mysql';

    /**
     * Steps 1 and 2: the candidates, and the ignored ids. No lock.
     * @param {Executor} executor
     * @param {Operation} operation
     * @param {BulkCall} call
     * @returns {Promise<{ candidates: string[], ignored: BulkIgnoredJob[] }>}
     */
    async function readCandidates(executor, operation, call) {
        const accepted = ACCEPTED[operation];

        if (!call.ids) {
            const { lane, statuses } = /** @type {NonNullable<BulkCall['filter']>} */ (call.filter);
            const rows = await readByFilter({ executor, family, p }, { lane, statuses });

            // A filter reports nothing: a retry skips the jobs without a payload
            return {
                candidates: rows.filter(row => operation !== 'retry' || row.found).map(row => row.id),
                ignored: [],
            };
        }

        const possible = call.ids.filter(isPossibleJobId);
        const rows = possible.length ? await readByIds({ executor, family, p }, possible) : [];
        const byId = new Map(rows.map(row => [row.id, row]));
        /** @type {string[]} */
        const candidates = [];
        /** @type {BulkIgnoredJob[]} */
        const ignored = [];

        for (const jobId of call.ids) {
            const row = byId.get(jobId);

            if (!row) {
                ignored.push({ jobId, reason: 'not_found' });
            } else if (!accepted.includes(row.status)) {
                ignored.push({ jobId, reason: 'status', status: row.status });
            } else if (operation === 'retry' && !row.found) {
                ignored.push({ jobId, reason: 'no_payload', status: row.status });
            } else {
                candidates.push(jobId);
            }
        }

        return { candidates, ignored };
    }

    /**
     * The write of an operation on the locked ids, guarded by the status.
     * @param {Executor} executor
     * @param {Operation} operation
     * @param {BulkCall} call
     * @param {string[]} ids
     * @returns {Promise<{ count: number, ids: string[] | null }>}
     */
    function write(executor, operation, call, ids) {
        const statuses = statusesOfCall(operation, call);

        if (operation === 'retry') {
            return retryJobs({ executor, family, p }, { ids, budget: call.budget });
        }

        if (operation === 'cancel') {
            return cancelJobs({ executor, family, p }, { ids, statuses, errorJson: CANCEL_ERROR_JSON });
        }

        return removeJobs({ executor, family, p }, { ids, statuses });
    }

    /**
     * Steps 3 to 5 on the candidates: lock, write, collect.
     * @param {Executor} executor
     * @param {{ operation: Operation, call: BulkCall, candidates: string[], ignored: BulkIgnoredJob[] }} step
     *     `ignored`: the ids ignored at the read; the result adds the candidates that changed meanwhile (ids only),
     *     all in the order of the ids.
     * @returns {Promise<Outcome>}
     */
    async function apply(executor, { operation, call, candidates, ignored: early }) {
        // The statuses of the filter, else of the operation: checked again under the lock and in the write
        const statuses = statusesOfCall(operation, call);
        // Byte order: the ids are printable ASCII, compared as the columns are (ascii_bin, COLLATE "C")
        const sorted = candidates.toSorted();
        const locked = sorted.length
            ? await lockJobs({ executor, family, p }, { ids: sorted, statuses })
            : [];
        const lockedIds = new Set(locked.map(job => job.id));
        const usable = locked.filter(job => operation !== 'retry' || job.found);
        /** @type {BulkIgnoredJob[]} */
        let ignored = early;

        if (call.ids) {
            const changed = candidates.filter(id => !lockedIds.has(id));
            const reread = changed.length ? await readByIds({ executor, family, p }, changed) : [];
            const byId = new Map(reread.map(row => [row.id, row]));
            /** @type {Map<string, BulkIgnoredJob>} */
            const reasons = new Map(early.map(entry => [entry.jobId, entry]));

            for (const jobId of changed) {
                const row = byId.get(jobId);

                // A job that left its status and came back to it before this read (a claim, then a release) is
                // reported with that status: the lock did not see it in it
                reasons.set(jobId, row ? { jobId, reason: 'status', status: row.status } : { jobId, reason: 'not_found' });
            }

            for (const job of locked) {
                if (!usable.includes(job)) {
                    reasons.set(job.id, { jobId: job.id, reason: 'no_payload', status: job.status });
                }
            }

            // In the order of the ids: the early and the late ones together
            ignored = call.ids.filter(id => reasons.has(id)).map(id => /** @type {BulkIgnoredJob} */ (reasons.get(id)));

            if (call.strict && ignored.length) {
                throw ignoredError(operation, ignored);
            }
        }

        const ids = usable.map(job => job.id);

        if (!ids.length) {
            return { count: 0, ids: [], ignored, cancelled: [], lanes: [], keys: [] };
        }

        const written = await write(executor, operation, call, ids);
        const changedIds = new Set(written.ids ?? ids);
        const changed = usable.filter(job => changedIds.has(job.id));
        const lanes = operation === 'retry' ? [...new Set(changed.map(job => job.lane))] : [];

        if (lanes.length && notifyChannel) {
            // The NOTIFY goes with the commit
            await notifyLanes(executor, notifyChannel, lanes);
        }

        return {
            count: written.count,
            ids: changed.map(job => job.id),
            ignored,
            cancelled: operation === 'cancel'
                ? changed.map(job => ({ id: job.id, lane: job.lane, attempts: job.attempts }))
                : [],
            lanes,
            keys: operation === 'retry'
                ? []
                : [...new Set(changed.filter(job => job.status === 'pending')
                        .flatMap(job => job.keys.filter(key => !isRateKey(key))))],
        };
    }

    /**
     * After an owned commit: the events, the wakes and the unblocks. Never throws.
     * @param {Outcome} outcome
     */
    function afterOwnedCommit(outcome) {
        try {
            for (const job of outcome.cancelled) {
                emit({ type: 'cancelled', jobId: job.id, lane: job.lane, attempt: job.attempts + 1 });
            }

            for (const lane of outcome.lanes) {
                wakeFor(lane, true);
            }
        } catch (error) {
            reportError('after_commit', error);
        }

        if (outcome.keys.length) {
            void unblockKeys(outcome.keys);
        }
    }

    /**
     * After a call in the caller's transaction: no event; the wakes and the unblocks at the adapter's after-commit
     * hook, else at once. Never throws.
     * @param {unknown} connection
     * @param {Outcome} outcome
     */
    function afterCallerCall(connection, outcome) {
        if (!outcome.lanes.length && !outcome.keys.length) {
            return;
        }

        const work = (/** @type {boolean} */ committed) => {
            try {
                for (const lane of outcome.lanes) {
                    wakeFor(lane, committed);
                }
            } catch (error) {
                reportError('after_commit', error);
            }

            if (outcome.keys.length) {
                void unblockKeys(outcome.keys);
            }
        };
        let hooked = false;

        try {
            hooked = adapter.afterCommit?.(/** @type {any} */ (connection), () => work(true)) ?? false;
        } catch (error) {
            reportError('after_commit', error);
        }

        if (!hooked) {
            work(false);
        }
    }

    /**
     * @param {Operation} operation
     * @param {BulkCall} call
     * @returns {Promise<Outcome>}
     */
    async function runAtomic(operation, call) {
        const work = async (/** @type {Executor} */ executor) => {
            const { candidates, ignored } = await readCandidates(executor, operation, call);

            if (call.strict && ignored.length) {
                throw ignoredError(operation, ignored);
            }

            return apply(executor, { operation, call, candidates, ignored });
        };

        if (call.connection === undefined) {
            const outcome = await owned(func => adapter.queueTransaction(func), work);

            afterOwnedCommit(outcome);

            return outcome;
        }

        const connection = /** @type {any} */ (call.connection);
        const ownedRun = adapter.poolTransaction?.(connection, work) ?? null;

        if (ownedRun) {
            let first = true;
            const outcome = await owned((func) => {
                // The first try is the one already running
                const running = first
                    ? ownedRun
                    : /** @type {Promise<Outcome>} */ (adapter.poolTransaction?.(connection, func));

                first = false;

                return running;
            }, work);

            afterOwnedCommit(outcome);

            return outcome;
        }

        const outcome = await adapter.inTransaction(connection, work);

        afterCallerCall(connection, outcome);

        return outcome;
    }

    /**
     * A filter in short transactions on the queue's pool, in the order of `jobs.list`: each job is read at most once.
     * @param {Operation} operation
     * @param {BulkCall} call
     * @returns {Promise<Outcome>}
     */
    async function runBatches(operation, call) {
        const { lane, statuses } = /** @type {NonNullable<BulkCall['filter']>} */ (call.filter);
        /** @type {Outcome} */
        const total = { count: 0, ids: [], ignored: [], cancelled: [], lanes: [], keys: [] };
        /** @type {{ ms: number, id: string } | null} */
        let after = null;

        for (;;) {
            // oxlint-disable-next-line no-await-in-loop -- one batch after the other
            const batch = await readBatch(
                { executor: adapter.queue, family, p },
                { lane, statuses, after, limit: BATCH_SIZE },
            );

            if (!batch.length) {
                break;
            }

            after = /** @type {{ ms: number, id: string }} */ (batch.at(-1));

            const ids = batch.map(row => row.id);
            // oxlint-disable-next-line no-await-in-loop -- one batch after the other
            const outcome = await owned(
                func => adapter.queueTransaction(func),
                executor => apply(executor, { operation, call, candidates: ids, ignored: [] }),
            );

            afterOwnedCommit(outcome);
            total.count += outcome.count;
            total.ids.push(...outcome.ids);

            if (batch.length < BATCH_SIZE) {
                break;
            }
        }

        return total;
    }

    return async (operation, selector, options) => {
        const call = checkBulk(operation, selector, options);
        const outcome = call.mode === 'batches' ? await runBatches(operation, call) : await runAtomic(operation, call);

        return {
            affectedCount: outcome.count,
            ...(call.includeAffectedJobIds && { affectedJobIds: outcome.ids }),
            ignoredJobs: outcome.ignored,
        };
    };
}

/**
 * @param {Operation} operation
 * @param {BulkCall} call
 * @returns {readonly JobStatus[]} The statuses of its filter, else all those that the operation changes.
 */
function statusesOfCall(operation, call) {
    return call.filter?.statuses ?? ACCEPTED[operation];
}

/**
 * @param {Operation} operation
 * @param {BulkIgnoredJob[]} ignored
 * @returns {IgnoredJobsError}
 */
function ignoredError(operation, ignored) {
    return new IgnoredJobsError(`jobs.${operation}: strict, and ${ignored.length} of its ids would be ignored: ${
        ignored.map(job => `${job.jobId} (${job.reason})`).join(', ')}`, { ignoredJobs: [...ignored] });
}
