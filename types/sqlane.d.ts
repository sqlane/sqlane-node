import type { BulkOptions, BulkResult, CloseOptions, DrainOptions, DrainResult, DropOptions, EnqueueManyItem, EnqueueOptions, EnqueuePayload, EnqueueResult, Handler, HandlerPayload, JobDefinition, JobFilter, JobPage, JobRecord, JobSelector, KeyStatsOptions, KeyStatsPage, JobStats, ListJobsOptions, MigrateOptions, MigrationStatus, RetryOptions, RollbackOptions, ScheduleBaseOptions, ScheduleInfo, SchedulePayload, ScheduleTiming, SchemaProblems } from './types.js';
/**
 * The tables of sqlane: `sqlane.schema`. Each migration is tagged with the lowest version of sqlane that ships it.
 * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schemamigrate | schema}
 */
export interface SqlaneSchema {
    /**
     * Creates or updates the `sqlane_*` tables: applies the missing migrations, in order. It holds a database lock, so
     * several processes can run it at once. Run it from your own migration tool to pin a version, but not inside the
     * tool's transaction.
     * @param options `targetVersion`: apply only the migrations tagged at or below it, from `'6.0.0'` up to the
     *     installed version; default: every migration. `lockTimeout`: how long to wait for the lock; default `'10m'`.
     * @returns The ids of the migrations that it applied.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schemamigrate | schema.migrate}
     */
    migrate(options?: MigrateOptions): Promise<{
        applied: string[];
    }>;
    /**
     * Reverts the recorded migrations tagged above `targetVersion`, newest first: the down of each, then its record.
     * Each down is safe to run again, so a cut rollback is finished by running it again. A down that drops a column or
     * a table loses its data. Run it only when no process of a newer version uses the tables. Its DDL waits for the
     * locks of the tables, and the queries of the queue wait behind it: pass a short `lockTimeout` while processes run.
     *
     * Rejects with a `ConfigError` when a recorded migration is unknown to this version, or on a started or draining
     * instance.
     * @param options `targetVersion`: the version to go back to, from `'6.0.0'` up to the installed version.
     *     `lockTimeout`: how long to wait for the migration lock, and for each lock of a table; default `'10m'`.
     * @returns The ids of the migrations that it reverted, newest first.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schemarollback | schema.rollback}
     */
    rollback(options: RollbackOptions): Promise<{
        reverted: string[];
    }>;
    /**
     * Drops every table that sqlane created under the prefix, in any version, with their data: `<p>migrations` last.
     * Stop the other processes on the prefix first. It drops only the tables of sqlane: when `<p>jobs` is not a table
     * of sqlane and `<p>migrations` does not record `0001_initial`, it rejects with a `ConfigError` and drops nothing.
     * Also a `ConfigError` when a recorded migration is unknown to this version, or on a started or draining instance.
     * @param options `lockTimeout`: how long to wait for the migration lock, and for the locks of the tables; default
     *     `'10m'`.
     * @returns The tables that existed.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schemadrop | schema.drop}
     */
    drop(options?: DropOptions): Promise<{
        dropped: string[];
    }>;
    /**
     * What `migrate()` would do, by the records of the migrations: a read, for a readiness probe. It never throws on a
     * mismatch.
     * @returns `ok` when no migration that the installed major needs is missing; the missing ids, required (tagged up
     *     to `X.0.0` of the installed major) or optional; the recorded ids unknown to this version.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schemagetmigrationstatus}
     */
    getMigrationStatus(): Promise<MigrationStatus>;
    /**
     * Whether the queries of this version find what they need, by the catalog: the tables, columns (type, nullability,
     * collation) and indexes that its migrations create, by name. Anything extra is ignored. A read, for a readiness
     * probe: it never throws on a mismatch.
     * @returns `ok` when no problem is required, and the problems.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schemafindschemaproblems}
     */
    findSchemaProblems(): Promise<SchemaProblems>;
}
/**
 * The jobs in the database: `sqlane.jobs`. Read and count them; retry, cancel or remove them in bulk; see the keys of
 * the global limits. Before `start()` and after `close()` too. `get`, `list` and the batches require the migration
 * `0008_job_list`; `keyStats` requires `0007`.
 * @template C The connections that the bulk methods accept as `connection`: those of the adapter.
 * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobs | jobs}
 */
export interface SqlaneJobs<C = any> {
    /**
     * Reads one job, with its payload.
     * @param jobId The full id, as `enqueue` returns it: `<name>:<dedupe key>`, a slot id, or a ULID.
     * @returns The job. Null: no job has this id, or the string cannot be a job id.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobsget | jobs.get}
     */
    get<P = any>(jobId: string): Promise<JobRecord<P> | null>;
    /**
     * Lists the jobs of one name, newest first: by enqueue time, then by id. A page has at most `limit` jobs; pass its
     * `nextCursor` to read the next one, with the same filter.
     * @param filter `jobName`, a job name or a definition, and `status`, one status or a list. Without `status`: every
     *     status.
     * @param options `limit` (1 to 1000, default 100), `cursor` (the `nextCursor` of the previous page),
     *     `includePayload` (default `false`).
     * @returns A page: its jobs, and the cursor of the next page, null on the last page.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobslist | jobs.list}
     */
    list<J extends JobDefinition | string>(filter: JobFilter<J>, options?: ListJobsOptions): Promise<JobPage<HandlerPayload<J>>>;
    /**
     * Runs failed jobs again: pending, due now, with the same id and enqueue time. A job without a payload is not
     * retried.
     * @param selector `jobIds`, up to 1000 full ids, or a filter: `jobName` and `status` (`'failed'`, the default).
     * @param options `budget` (`'reset'`, the default: attempts and stalls back to 0; `'one_more'`: one more
     *     attempt), `connection`, `mode`, `strict`, `includeAffectedJobIds`.
     * @returns The count of the retried jobs, their ids with `includeAffectedJobIds`, and the ignored ids.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobsretry | jobs.retry}
     */
    retry(selector: JobSelector, options?: RetryOptions<C>): Promise<BulkResult>;
    /**
     * Cancels pending and blocked jobs: they fail at once, with a `JobCancelledError`, without a failure job. A
     * running job is not changed.
     * @param selector `jobIds`, up to 1000 full ids, or a filter: `jobName` and `status` (`'pending'`, `'blocked'`;
     *     both by default).
     * @param options `connection`, `mode`, `strict`, `includeAffectedJobIds`.
     * @returns The count of the cancelled jobs, their ids with `includeAffectedJobIds`, and the ignored ids.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobscancel | jobs.cancel}
     */
    cancel(selector: JobSelector, options?: BulkOptions<C>): Promise<BulkResult>;
    /**
     * Deletes jobs and their payloads, in any status but running. Their dedupe keys are free again.
     * @param selector `jobIds`, up to 1000 full ids, or a filter: `jobName` and `status` (`'pending'`,
     *     `'blocked'`, `'completed'`, `'failed'`; all four by default).
     * @param options `connection`, `mode`, `strict`, `includeAffectedJobIds`.
     * @returns The count of the removed jobs, their ids with `includeAffectedJobIds`, and the ignored ids.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobsremove | jobs.remove}
     */
    remove(selector: JobSelector, options?: BulkOptions<C>): Promise<BulkResult>;
    /**
     * The keys of the global limits with blocked jobs, or with held or lingering slots, worst first: for alerts on a
     * blocked chain (`orderBy: 'blocked'`) or a key held too long (`orderBy: 'held'`). One statement, whose cost grows
     * with the number of blocked keys: poll it at the pace of an alert.
     * @param options `limit` (1 to 1000, default 100), `type` (`'concurrency'` or `'rate'`; default: all types),
     *     `orderBy` (`'blocked'`, the default, or `'held'`).
     * @returns The keys of the page, and `truncated` when more keys matched.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#key-stats | jobs.keyStats}
     */
    keyStats(options?: KeyStatsOptions): Promise<KeyStatsPage>;
    /**
     * Counts the jobs of each job name, for monitoring and alerts. A growing `oldestDueAgeMs` usually means that no
     * process handles the name, or that the workers can't keep up; a growing `blocked`, that a key of a global limit
     * holds its jobs back (see `keyStats`). PostgreSQL reads every row kept; MySQL and MariaDB read the completed jobs
     * in their index: poll it at the pace of a metric scrape.
     * @returns One entry per name with jobs in any status, sorted by name. The failed and completed jobs count until
     *     the cleanup deletes them.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobsstats | jobs.stats}
     */
    stats(): Promise<JobStats[]>;
}
/**
 * The schedules: `sqlane.schedules`. Before `start()` and after `close()` too.
 * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#scheduleslist | schedules}
 */
export interface SqlaneSchedules {
    /**
     * Lists the schedules of the table and those registered in this process, sorted by id. It works before `start()`.
     * @returns The schedules. `registered: false`: a schedule of another service, or one removed from the code.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#scheduleslist | schedules.list}
     */
    list(): Promise<ScheduleInfo[]>;
}
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
    enqueue<J extends JobDefinition | string, P>(connection: C, job: J, payload: EnqueuePayload<J, P>, options?: EnqueueOptions): Promise<EnqueueResult>;
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
    enqueueMany<J extends JobDefinition | string, P>(connection: C, job: J, items: readonly EnqueueManyItem<J, P>[]): Promise<EnqueueResult[]>;
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
    schedule<J extends JobDefinition | string, P>(job: J, options: ScheduleBaseOptions & ScheduleTiming & SchedulePayload<J, P>): void;
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
    /** The jobs in the database: read and count them; retry, cancel or remove them in bulk. */
    readonly jobs: SqlaneJobs<C>;
    /** The schedules: list them. */
    readonly schedules: SqlaneSchedules;
    /** The `sqlane_*` tables: create, update, roll back or drop them; check them. */
    readonly schema: SqlaneSchema;
    /**
     * Low level: makes this process check for due jobs now, instead of at the next poll. Most apps don't need it:
     * sqlane wakes the process after an enqueue in it, and after a hint. It does nothing before `start()`.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#wake | wake}
     */
    wake(): void;
}
