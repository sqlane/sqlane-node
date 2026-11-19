// The interface of a sqlane instance: its methods and their parameters, documented for the editor's hover and
// signature help. Type-only: no code runs from this file, and the package ships its declarations (types/sqlane.d.ts).
// The full reference is docs/api.md.
import type {
    CloseOptions,
    DrainOptions,
    DrainResult,
    EnqueueManyItem,
    EnqueueOptions,
    EnqueuePayload,
    EnqueueResult,
    Handler,
    HandlerPayload,
    JobDefinition,
    JobStats,
    MigrateOptions,
    ScheduleBaseOptions,
    ScheduleInfo,
    SchedulePayload,
    ScheduleTiming,
} from './types.js';

/**
 * A sqlane instance, made by `createSqlane()`: one per process. It enqueues jobs, runs the handlers of this process,
 * and fires its schedules.
 * @template C The connections that `enqueue` accepts: those of the adapter's driver or ORM.
 * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md | API reference}
 */
export interface Sqlane<C> {
    /**
     * Adds one job with your connection, in your transaction: the job commits or rolls back with your data, and a
     * worker runs it after the commit.
     *
     * A connection or a transaction client must be in a transaction: sqlane cannot always detect one. A pool: sqlane
     * runs the insert in a short transaction of its own.
     * @param connection Your transaction, or a connection in one, of the adapter's library; or a pool.
     * @param job The job definition, or a job name. A name takes its definition from `jobs` or the handled names; else
     *     the job gets the instance defaults.
     * @param payload JSON. With a typed definition, such as `defineJob<{ orderId: number }>(…)`, its type is checked.
     * @param options `jobId` to dedupe or `slot` to run a schedule slot by hand; `delay` or `runAt`; and overrides of
     *     the definition for this job.
     * @returns The job id, and `created: false` when a job with this `jobId` exists already: nothing was added.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueue | enqueue}
     */
    enqueue<J extends JobDefinition | string, P>(
        connection: C,
        job: J,
        payload: EnqueuePayload<J, P>,
        options?: EnqueueOptions,
    ): Promise<EnqueueResult>;

    /**
     * Adds several jobs of one name in one call, with your connection, in your transaction. sqlane checks all the items
     * before it writes, so one bad item adds no job.
     * @param connection Your transaction, or a connection in one, of the adapter's library; or a pool.
     * @param job The job definition, or a job name.
     * @param items Each a `payload` and optional `options`, as in `enqueue`.
     * @returns The results, in the order of the items. Two items with one `jobId`: the first adds the job, the next
     *     get `created: false`.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueuemany | enqueueMany}
     */
    enqueueMany<J extends JobDefinition | string, P>(
        connection: C,
        job: J,
        items: readonly EnqueueManyItem<J, P>[],
    ): Promise<EnqueueResult[]>;

    /**
     * Registers the handler of a job name in this process. The worker runs its jobs after `start()`, or in `drain()`.
     *
     * Register all the handlers before `start()`. The handler runs outside any transaction, and its return value is
     * ignored. A throw retries the job after its backoff, until `maxAttempts`; `FatalJobError`, `RetryJobError` and
     * `RateLimitedError` change that. Throws a `ConfigError` when the name has a handler already, or when `jobs` holds
     * another definition with this name.
     * @param job The job definition, or a job name. The definition holds all the options of the name.
     * @param handler Gets `{ payload, job, signal }`. Pass `signal` to `fetch` and other APIs: it aborts on a timeout,
     *     a lost lease or a shutdown, and the handler must then stop.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#handle | handle}
     */
    handle<J extends JobDefinition | string>(job: J, handler: Handler<HandlerPayload<J>>): void;

    /**
     * Adds a job at each slot of a cron in a time zone, or of a fixed interval. Each slot adds at most one job in the
     * whole cluster, with no leader. Call it before `start()`, in each process that should fire the schedule.
     * @param job The job definition, or a job name.
     * @param options `cron` with an optional `timezone`, or `every`; `key` to tell several schedules of one name apart;
     *     `payload`, `missed`, `overlap` and `jitter`.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schedule | schedule}
     */
    schedule<J extends JobDefinition | string, P>(
        job: J,
        options: ScheduleBaseOptions & ScheduleTiming & SchedulePayload<J, P>,
    ): void;

    /**
     * Lists the schedules of the table and those registered in this process, sorted by id. It works before `start()`.
     * @returns The schedules. `registered: false`: a schedule of another service, or one removed from the code.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#getschedules | getSchedules}
     */
    getSchedules(): Promise<ScheduleInfo[]>;

    /**
     * Starts the worker of this process: it claims and runs the due jobs of the handled names, renews leases, recovers
     * stalled jobs, deletes expired ones and fires the schedules of this process. A second call does nothing.
     *
     * Rejects with a `ConfigError` for a bad schedule, a missing table, or a server that fails the check of the
     * adapter's `dialect`. If the database is down, it resolves anyway and emits an `error` event.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#start | start}
     */
    start(): Promise<void>;

    /**
     * For tests: runs the due jobs of the handled names until none is left, without `start()`. It does not fire
     * schedules: enqueue a slot with the `slot` option instead.
     * @param options `timeout` (default `'10s'`), and `includeDelayed` to run delayed jobs and retries at once.
     * @returns The jobs that completed, the attempts that will be retried, and the jobs that failed for good.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#drain | drain}
     */
    drain(options?: DrainOptions): Promise<DrainResult>;

    /**
     * Stops the worker of this process: it claims no more jobs, waits for the running handlers until the deadline,
     * then aborts their `signal`. It never ends your pools: close them after it.
     * @param options `deadline` (default `'30s'`); `mode`: `'release'` (default) puts unfinished jobs back in the
     *     queue without using an attempt; `exitsBy`: the latest time the process exits.
     * @returns Resolves when the handlers have settled or the deadline has passed. It never rejects because of its
     *     options.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#close | close}
     */
    close(options?: CloseOptions): Promise<void>;

    /**
     * Creates or updates the `sqlane_*` tables. It holds a database lock, so several processes can run it at once. To
     * use your own migration tool instead, take the SQL from `getMigrations()`.
     * @param options `lockTimeout`: how long to wait for the lock. Default: `'10m'`.
     * @returns The ids of the migrations that it applied.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#migrate | migrate}
     */
    migrate(options?: MigrateOptions): Promise<{ applied: string[] }>;

    /**
     * Counts the jobs of each job name, for monitoring and alerts. A growing `oldestDueAgeMs` usually means that no
     * process handles the name, or that the workers can't keep up.
     * @returns One entry per name with pending, running or failed jobs, sorted by name.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#getstats | getStats}
     */
    getStats(): Promise<JobStats[]>;

    /**
     * Low level: makes this process check for due jobs now, instead of at the next poll. Most apps don't need it:
     * sqlane wakes the process after an enqueue in it, and after a hint. It does nothing before `start()`.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#wake | wake}
     */
    wake(): void;
}
