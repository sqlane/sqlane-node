// The interface of a sqlane instance: its methods and their parameters, documented for the editor's hover and
// signature help. Type-only: no code runs from this file, and the package ships its declarations (types/sqlane.d.ts).
// The full reference is docs/api.md.
import type {
    BulkOptions,
    BulkResult,
    CloseOptions,
    DrainOptions,
    DrainResult,
    DropOptions,
    EnqueueManyItem,
    EnqueueOptions,
    EnqueuePayload,
    EnqueueResult,
    HandlerPayload,
    JobFilter,
    JobPage,
    JobRecord,
    JobSelector,
    KeyStatsOptions,
    KeyStatsPage,
    LaneDefinition,
    LaneHandler,
    LaneRunStatus,
    LaneStats,
    ListJobsOptions,
    MigrateOptions,
    MigrationStatus,
    PauseGloballyOptions,
    RetryOptions,
    RollbackOptions,
    RunSlotOptions,
    ScheduleDefinition,
    ScheduleInfo,
    ScheduleRunStatus,
    SchemaProblems,
} from './types.js';

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
    migrate(options?: MigrateOptions): Promise<{ applied: string[] }>;

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
    rollback(options: RollbackOptions): Promise<{ reverted: string[] }>;

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
    drop(options?: DropOptions): Promise<{ dropped: string[] }>;

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
 * The lanes in the database: `sqlane.lanes`. A lane is the jobs that share a name; their default options come from its
 * definition. A runner runs a lane in a process: `runner.mount([defineHandler(lane, fn)])`.
 * @template C The connections that the pauses accept as `connection`: those of the adapter.
 * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#lanesstats | lanes}
 */
export interface SqlaneLanes<C = any> {
    /**
     * Pauses a lane in every process: no runner claims its jobs, from its next poll (or hint). Stored in the
     * database: it holds across restarts and deploys, until `resumeGlobally()`. The running jobs finish; enqueues and
     * schedules go on, and their jobs wait pending. Its blocked jobs take no room of a key that other lanes share. A
     * lane with no job yet is fine: pause it before its first deploy. Idempotent.
     * @param lane A lane definition, or the name of a lane.
     * @param options `connection`: your transaction, or a pool (default: the queue's pool).
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#lanespauseglobally-and-resumeglobally | lanes.pauseGlobally}
     */
    pauseGlobally(lane: LaneDefinition | string, options?: PauseGloballyOptions<C>): Promise<void>;

    /**
     * Resumes a lane that `pauseGlobally()` paused: its blocked jobs are unblocked as far as their keys allow, this
     * process wakes, and the hint (if configured) wakes the others. With a `connection`, after its commit, when the
     * adapter can tell; else at once. A lane that is not paused: nothing to resume. Idempotent.
     * @param lane A lane definition, or the name of a lane.
     * @param options `connection`: your transaction, or a pool (default: the queue's pool).
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#lanespauseglobally-and-resumeglobally | lanes.resumeGlobally}
     */
    resumeGlobally(lane: LaneDefinition | string, options?: PauseGloballyOptions<C>): Promise<void>;

    /**
     * Counts the jobs of each lane, for monitoring and alerts. A growing `oldestDueAgeMs` usually means that no
     * process runs the lane, or that the workers can't keep up; a growing `blocked`, that a key of a global limit
     * holds its jobs back (see `jobs.keyStats`). It reads every row kept: mind the interval of a metric scrape.
     * @returns One entry per lane with jobs in any status, and per globally paused lane, sorted by name. The failed and
     *     completed jobs count until the cleanup deletes them.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#lanesstats | lanes.stats}
     */
    stats(): Promise<LaneStats[]>;
}

/**
 * The jobs in the database: `sqlane.jobs`. Read them; retry, cancel or remove them in bulk; see the keys of the global
 * limits. Before `start()` and after `close()` too.
 * @template C The connections that the bulk methods accept as `connection`: those of the adapter.
 * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobs | jobs}
 */
export interface SqlaneJobs<C = any> {
    /**
     * Reads one job, with its payload.
     * @param jobId The full id, as `enqueue` returns it: `<lane>:<dedupeKey>`, a slot id, or a ULID.
     * @returns The job. Null: no job has this id, or the string cannot be a job id.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobsget | jobs.get}
     */
    get<P = any>(jobId: string): Promise<JobRecord<P> | null>;

    /**
     * Lists the jobs of one lane, newest first: by enqueue time, then by id. A page has at most `limit` jobs; pass its
     * `nextCursor` to read the next one, with the same filter.
     * @param filter `lane`, a lane definition or the name of a lane, and `status`, one status or a list. Without
     *     `status`: every status.
     * @param options `limit` (1 to 1000, default 100), `cursor` (the `nextCursor` of the previous page),
     *     `includePayload` (default `false`).
     * @returns A page: its jobs, and the cursor of the next page, null on the last page.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobslist | jobs.list}
     */
    list<J extends LaneDefinition | string>(
        filter: JobFilter<J>,
        options?: ListJobsOptions,
    ): Promise<JobPage<HandlerPayload<J>>>;

    /**
     * Runs failed jobs again: pending, due now, with the same id and enqueue time. A job without a payload is not
     * retried.
     * @param selector `jobIds`, up to 1000 full ids, or a filter: `lane` and `status` (`'failed'`, the default).
     * @param options `budget` (`'reset'`, the default: attempts and stalls back to 0; `'one_more'`: one more
     *     attempt), `connection`, `mode`, `strict`, `includeAffectedJobIds`.
     * @returns The count of the retried jobs, their ids with `includeAffectedJobIds`, and the ignored ids.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobsretry | jobs.retry}
     */
    retry(selector: JobSelector, options?: RetryOptions<C>): Promise<BulkResult>;

    /**
     * Cancels pending and blocked jobs: they fail at once, with a `JobCancelledError`, without a failure job. A
     * running job is not changed.
     * @param selector `jobIds`, up to 1000 full ids, or a filter: `lane` and `status` (`'pending'`, `'blocked'`;
     *     both by default).
     * @param options `connection`, `mode`, `strict`, `includeAffectedJobIds`.
     * @returns The count of the cancelled jobs, their ids with `includeAffectedJobIds`, and the ignored ids.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#jobscancel | jobs.cancel}
     */
    cancel(selector: JobSelector, options?: BulkOptions<C>): Promise<BulkResult>;

    /**
     * Deletes jobs and their payloads, in any status but running. Their dedupe keys are free again.
     * @param selector `jobIds`, up to 1000 full ids, or a filter: `lane` and `status` (`'pending'`,
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
}

/**
 * The schedules in the database: `sqlane.schedules`. No runner needed, before `start()` and after `close()` too.
 * @template C The connections that `runSlot` accepts as `connection`: those of the adapter.
 * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#scheduleslist | schedules}
 */
export interface SqlaneSchedules<C = any> {
    /**
     * Lists the schedules of the table, sorted by id: their next slot by their stored spec. No runner needed. A
     * schedule is listed once a started runner has mounted it, or a pause has created its row.
     * @returns The schedules: their spec, their next slot (none while paused), their last slot, their last job, and
     *     whether they are paused.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#scheduleslist | schedules.list}
     */
    list(): Promise<ScheduleInfo[]>;

    /**
     * Enqueues a slot of a schedule by hand, as a runner would: the payload of the schedule, the dedupe key of the
     * slot, the options of its lane. A second run of the slot, or its fire, gives `created: false`. Due now: it ignores
     * the jitter and `overlap`. For tests (then `runner.drain()`) and for admin tasks; no runner needed. The default
     * slot comes from the clock of this process; the runners use the clock of the database.
     * @param schedule A schedule definition, from `defineSchedule()`: it holds the payload.
     * @param options `at`: a slot of the schedule, not in the future (default: the latest slot at or before now);
     *     `connection`: your transaction, or a pool (default: the queue's pool). An `at` off the spec or in the
     *     future: an `InvalidOptionsError`.
     * @returns The id of the job of the slot, and `created: false` when it exists already.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schedulesrunslot | schedules.runSlot}
     */
    runSlot(schedule: ScheduleDefinition<any>, options?: RunSlotOptions<C>): Promise<EnqueueResult>;

    /**
     * Pauses a schedule in every process: no runner fires it; its slots during the pause are skipped, with no event.
     * Stored in its row: it holds across restarts and deploys. No row yet: creates it, paused, with its cursor at now
     * (pause before the first deploy; the row of a typo shows in `list()`, and `remove()` deletes it). Idempotent.
     * @param schedule A schedule definition, or its id `<lane>:<key>`.
     * @param options `connection`: your transaction, or a pool (default: the queue's pool).
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schedulespauseglobally-and-resumeglobally | schedules.pauseGlobally}
     */
    pauseGlobally(schedule: ScheduleDefinition<any> | string, options?: PauseGloballyOptions<C>): Promise<void>;

    /**
     * Resumes a schedule that `pauseGlobally()` paused: its cursor moves to now, so the slots of the pause are not
     * caught up. A schedule that is not paused, or with no row: nothing changes. Idempotent.
     * @param schedule A schedule definition, or its id `<lane>:<key>`.
     * @param options `connection`: your transaction, or a pool (default: the queue's pool).
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schedulespauseglobally-and-resumeglobally | schedules.resumeGlobally}
     */
    resumeGlobally(schedule: ScheduleDefinition<any> | string, options?: PauseGloballyOptions<C>): Promise<void>;

    /**
     * Deletes the row of a schedule: its cursor and its pause. For a schedule deleted from the code, a typo, or a
     * keyless schedule of 9.x. A schedule still mounted in a started runner gets its row back at its next fire, fresh.
     * @param schedule A schedule definition, or its id: `<lane>:<key>`, or `<lane>` for a keyless schedule of 9.x.
     * @param options `connection`: your transaction, or a pool (default: the queue's pool).
     * @returns `removed`: a row was deleted.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#schedulesremove | schedules.remove}
     */
    remove(
        schedule: ScheduleDefinition<any> | string,
        options?: PauseGloballyOptions<C>,
    ): Promise<{ removed: boolean }>;
}

/**
 * A sqlane, made by `createSqlane()`: the database side, one per process. It enqueues jobs, and reads and changes the
 * jobs, the schedules and the tables, for every process. A process that runs jobs adds a runner over it:
 * `createRunner()`.
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
     * @param lane A lane definition: it gives the job its options.
     * @param payload JSON. With a typed definition, such as `defineLane<{ orderId: number }>(…)`, its type is checked.
     * @param options `dedupeKey` to dedupe; `delay` or `runAt`; and overrides of the definition for this job.
     * @returns The job id, and `created: false` when a job with this id exists already: nothing was added.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueue | enqueue}
     */
    enqueue<J extends LaneDefinition, P>(
        connection: C,
        lane: J,
        payload: EnqueuePayload<J, P>,
        options?: EnqueueOptions,
    ): Promise<EnqueueResult>;

    /**
     * Adds several jobs of one lane in one call, with your connection, in your transaction. sqlane checks all the items
     * before it writes, so one bad item adds no job.
     * @param connection Your transaction, or a connection in one, of the adapter's library; or a pool.
     * @param lane A lane definition: it gives the jobs their options.
     * @param items Each a `payload` and optional `options`, as in `enqueue`.
     * @returns The results, in the order of the items. Two items with one `dedupeKey`: the first adds the job, the
     *     next get `created: false`.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#enqueuemany | enqueueMany}
     */
    enqueueMany<J extends LaneDefinition, P>(
        connection: C,
        lane: J,
        items: readonly EnqueueManyItem<J, P>[],
    ): Promise<EnqueueResult[]>;

    /**
     * Closes the runner of this sqlane, if any (see `runner.close()`), with these options, then stops publishing hints
     * and unsubscribes from the hint. It never ends your pools: close them after it. The enqueues still work after it,
     * without a hint.
     * @param options `deadline` (default `'30s'`); `mode`: `'release'` (default) puts unfinished jobs back in the
     *     queue without using an attempt; `exitsBy`: the latest time the process exits.
     * @returns Resolves when the runner is closed: its handlers have settled or the deadline has passed. It never
     *     rejects because of its options.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#runnerclose-and-sqlaneclose | close}
     */
    close(options?: CloseOptions): Promise<void>;

    /** The lanes: count the jobs of each lane; pause and resume a lane in every process. */
    readonly lanes: SqlaneLanes<C>;

    /** The jobs in the database: read them; retry, cancel or remove them in bulk. */
    readonly jobs: SqlaneJobs<C>;

    /** The schedules: list them; run a slot by hand; pause, resume or remove one in every process. */
    readonly schedules: SqlaneSchedules<C>;

    /** The `sqlane_*` tables: create, update, roll back or drop them; check them. */
    readonly schema: SqlaneSchema;
}

/**
 * The parts of one `runner.mount()` call.
 * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#mount | Mount}
 */
export interface Mount {
    /**
     * Removes the parts of the mount from this process: it stops claiming their lanes and firing their schedules here,
     * at once. A claim or a fire in flight completes with the old parts; the jobs that run go on to their end, and
     * `close()` waits for them. The lanes can be mounted again at once, with any handler: the old jobs still running
     * count toward its local limits and its share. Sync and idempotent. During `drain()`: a `ConfigError`.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#mountunmount | Mount.unmount}
     */
    unmount(): void;
}

/**
 * The runner of this process, made by `createRunner()`: it runs the handlers and fires the
 * schedules that it mounts. Its methods act on this process, sync, but `start`, `drain` and `close`. The
 * methods of the sqlane act on the database, for every process.
 * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#runner | Runner}
 */
export interface Runner {
    /**
     * Runs the handlers and fires the schedules of the parts in this process, from now on: before `start()`, or after
     * it (it claims and fires at once). A schedule fires here whether its lane is handled here or not.
     *
     * Throws a `ConfigError` for a lane handled here already, a schedule id mounted here already, two definitions
     * with one name among the mounted lanes and their failure lanes, two maxes of one local limit, global limits
     * without a `timeout`, or a schedule whose job would be refused (payload size, limits); nothing is mounted then.
     * During `drain()`: a `ConfigError`. After `close()`: a `ClosedError`.
     * @param parts Handlers from `defineHandler()` and schedules from `defineSchedule()`.
     * @returns The mount: `unmount()` removes all its parts.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#runnermount | runner.mount}
     */
    mount(parts: readonly (LaneHandler<any> | ScheduleDefinition<any>)[]): Mount;

    /**
     * This process stops claiming the jobs of the lane, for the life of the runner: before it is mounted too, and
     * across an unmount and a mount. Its running jobs finish; its schedules go on; the enqueues of the lane in this
     * process send the hint to the others. Idempotent.
     * @param lane A lane definition or the name of a lane.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#runnerpauselocally | runner.pauseLocally}
     */
    pauseLocally(lane: LaneDefinition | string): void;

    /**
     * This process claims the jobs of the lane again, at once. Idempotent.
     * @param lane A lane definition or the name of a lane.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#runnerpauselocally | runner.resumeLocally}
     */
    resumeLocally(lane: LaneDefinition | string): void;

    /**
     * A schedule in this process. An unknown id: `mounted: false`.
     * @param schedule A schedule definition, or a schedule id: `<lane>:<key>`.
     * @returns Whether it is mounted here.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#runnergetstatus | runner.getStatus}
     */
    getStatus(schedule: ScheduleDefinition<any> | `${string}:${string}`): ScheduleRunStatus;

    /**
     * A lane in this process. An unknown name: `mounted: false`.
     * @param lane A lane definition or the name of a lane.
     * @returns Whether a handler of the lane is mounted here, whether it is paused here, and its jobs that run here.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#runnergetstatus | runner.getStatus}
     */
    getStatus(lane: LaneDefinition | string): LaneRunStatus;

    /**
     * Starts this process: it claims and runs the due jobs of the mounted lanes that no pause holds, renews leases,
     * recovers stalled jobs, deletes expired ones and fires the mounted schedules. A second call does nothing.
     *
     * Rejects with a `ConfigError` for a missing table, a server that fails the check of the adapter's `dialect`, or a
     * call during `drain()`.
     * If the database is down, it resolves anyway, emits an `error` event, and retries.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#runnerstart | runner.start}
     */
    start(): Promise<void>;

    /**
     * For tests: runs the due jobs of the mounted lanes that no pause holds, until none is left, without `start()`. It
     * fires no schedule: run a slot with `sqlane.schedules.runSlot()`. After `start()`: a `ConfigError`.
     * @param options `timeout` (default `'10s'`), and `includeDelayed` to run delayed jobs and retries at once.
     * @returns The jobs that completed, the attempts that will be retried, and the jobs that failed for good.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#runnerdrain | runner.drain}
     */
    drain(options?: DrainOptions): Promise<DrainResult>;

    /**
     * Stops this process: it claims no more jobs, fires no more schedules, waits for the running handlers until the
     * deadline, then aborts their `signal`. It never ends your pools. `sqlane.close()` closes the runner too.
     * @param options `deadline` (default `'30s'`); `mode`: `'release'` (default) puts unfinished jobs back in the
     *     queue without using an attempt; `exitsBy`: the latest time the process exits.
     * @returns Resolves when the handlers have settled or the deadline has passed. It never rejects because of its
     *     options.
     * @see {@link https://github.com/sqlane/sqlane-node/blob/main/docs/api.md#runnerclose | runner.close}
     */
    close(options?: CloseOptions): Promise<void>;
}
