// The schema of sqlane on PostgreSQL 15+. The migrations run in one transaction (transactional DDL).

/**
 * @param {string} p The table prefix.
 * @returns {import('../migrations.js').Migration[]}
 */
export function postgresMigrations(p) {
    return [
        {
            id: '0001_initial',
            version: '0.1.0',
            statements: [
                `CREATE TABLE IF NOT EXISTS ${p}jobs (
                    id varchar(255) COLLATE "C" NOT NULL PRIMARY KEY,
                    job_name varchar(128) COLLATE "C" NOT NULL,
                    status varchar(16) COLLATE "C" NOT NULL
                        CONSTRAINT ${p}jobs_status CHECK (status IN ('pending', 'running', 'completed', 'failed')),
                    run_at timestamptz(3) NOT NULL,
                    attempts integer NOT NULL DEFAULT 0,
                    max_attempts integer NOT NULL,
                    stalls integer NOT NULL DEFAULT 0,
                    max_stalls integer NOT NULL,
                    mutex_keys text[] COLLATE "C",
                    enqueue_token varchar(26) COLLATE "C" NOT NULL,
                    lock_token varchar(26) COLLATE "C",
                    locked_by varchar(255),
                    locked_until timestamptz(3),
                    timed_out_at timestamptz(3),
                    last_error jsonb,
                    completed_retention_ms bigint NOT NULL,
                    failed_retention_ms bigint NOT NULL,
                    failure_job varchar(128) COLLATE "C",
                    created_at timestamptz(3) NOT NULL,
                    started_at timestamptz(3),
                    finished_at timestamptz(3),
                    expires_at timestamptz(3),
                    updated_at timestamptz(3) NOT NULL
                )`,
                `CREATE INDEX IF NOT EXISTS ${p}jobs_pending ON ${p}jobs (job_name, run_at) WHERE status = 'pending'`,
                `CREATE INDEX IF NOT EXISTS ${p}jobs_running ON ${p}jobs (locked_until) WHERE status = 'running'`,
                `CREATE INDEX IF NOT EXISTS ${p}jobs_expires_at ON ${p}jobs (expires_at)`,
                `CREATE TABLE IF NOT EXISTS ${p}payloads (
                    id varchar(255) COLLATE "C" NOT NULL PRIMARY KEY,
                    payload jsonb NOT NULL
                )`,
                `CREATE TABLE IF NOT EXISTS ${p}mutexes (
                    mutex_key varchar(255) COLLATE "C" NOT NULL PRIMARY KEY,
                    job_id varchar(255) COLLATE "C" NOT NULL,
                    lock_token varchar(26) COLLATE "C" NOT NULL,
                    held_until timestamptz(3),
                    created_at timestamptz(3) NOT NULL
                )`,
                `CREATE INDEX IF NOT EXISTS ${p}mutexes_job_id ON ${p}mutexes (job_id)`,
            ],
        },
        {
            // The claims read the due jobs of a name in the order of (run_at, id): from the index, with no sort, in
            // every plan (a cached generic one too). The index has the pending jobs only: small.
            id: '0002_pending_order',
            version: '3.0.0',
            statements: [
                `DROP INDEX IF EXISTS ${p}jobs_pending`,
                `CREATE INDEX IF NOT EXISTS ${p}jobs_pending ON ${p}jobs (job_name, run_at, id) WHERE status = 'pending'`,
            ],
        },
        {
            // The FIFO of a mutex key, and the wake after its release, read the pending jobs of a key in order: a row
            // per key of each pending job. A claim deletes the rows of its jobs, a return to pending adds them again.
            id: '0003_job_keys',
            version: '3.0.0',
            statements: [
                `CREATE TABLE IF NOT EXISTS ${p}job_keys (
                    mutex_key varchar(255) COLLATE "C" NOT NULL,
                    run_at timestamptz(3) NOT NULL,
                    job_id varchar(255) COLLATE "C" NOT NULL,
                    job_name varchar(128) COLLATE "C" NOT NULL,
                    PRIMARY KEY (mutex_key, run_at, job_id)
                )`,
                `CREATE INDEX IF NOT EXISTS ${p}job_keys_job_id ON ${p}job_keys (job_id)`,
                `INSERT INTO ${p}job_keys (mutex_key, run_at, job_id, job_name)
                SELECT k.mutex_key, j.run_at, j.id, j.job_name
                  FROM ${p}jobs j CROSS JOIN LATERAL unnest(j.mutex_keys) AS k(mutex_key)
                 WHERE j.status = 'pending'
                ON CONFLICT DO NOTHING`,
            ],
        },
        {
            // The cursor of each schedule: its last decided slot. Needed only with schedules.
            id: '0004_schedules',
            version: '4.0.0',
            statements: [
                `CREATE TABLE IF NOT EXISTS ${p}schedules (
                    id varchar(255) COLLATE "C" NOT NULL PRIMARY KEY,
                    job_name varchar(128) COLLATE "C" NOT NULL,
                    spec varchar(512) COLLATE "C" NOT NULL,
                    last_slot_at timestamptz(3) NOT NULL,
                    last_job_id varchar(255) COLLATE "C",
                    created_at timestamptz(3) NOT NULL,
                    updated_at timestamptz(3) NOT NULL
                )`,
            ],
        },
        {
            // 6.0: global concurrency limits replace mutex keys. A job's keys get their maxes; a job with a full key
            // is `blocked` on it, out of the due jobs, until a release of the key.
            id: '0005_concurrency_limits',
            version: '6.0.0',
            statements: [
                `ALTER TABLE ${p}jobs DROP CONSTRAINT IF EXISTS ${p}jobs_status`,
                `ALTER TABLE ${p}jobs DROP CONSTRAINT IF EXISTS ${p}jobs_states`,
                `ALTER TABLE ${p}jobs ADD CONSTRAINT ${p}jobs_states
                    CHECK (status IN ('pending', 'blocked', 'running', 'completed', 'failed'))`,
                `ALTER TABLE ${p}jobs RENAME COLUMN mutex_keys TO limit_keys`,
                `ALTER TABLE ${p}jobs ADD COLUMN IF NOT EXISTS limit_maxes integer[]`,
                `ALTER TABLE ${p}jobs ADD COLUMN IF NOT EXISTS blocked_on varchar(255) COLLATE "C"`,
                `CREATE INDEX IF NOT EXISTS ${p}jobs_blocked ON ${p}jobs (blocked_on, run_at, id)
                  WHERE status = 'blocked'`,
            ],
        },
        {
            // A mutex key of 5.x gets the max 1; its hold becomes slot 0 of its key. The job_keys and their FIFO go.
            id: '0006_concurrency_slots',
            version: '6.0.0',
            statements: [
                `CREATE TABLE IF NOT EXISTS ${p}concurrency_slots (
                    limit_key varchar(255) COLLATE "C" NOT NULL,
                    slot integer NOT NULL,
                    job_id varchar(255) COLLATE "C" NOT NULL,
                    lock_token varchar(26) COLLATE "C" NOT NULL,
                    held_until timestamptz(3),
                    created_at timestamptz(3) NOT NULL,
                    PRIMARY KEY (limit_key, slot)
                )`,
                `CREATE INDEX IF NOT EXISTS ${p}concurrency_slots_job_id ON ${p}concurrency_slots (job_id)`,
                `UPDATE ${p}jobs SET limit_maxes = array_fill(1, ARRAY[cardinality(limit_keys)])
                  WHERE limit_keys IS NOT NULL AND limit_maxes IS NULL`,
                `INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
                SELECT mutex_key, 0, job_id, lock_token, held_until, created_at FROM ${p}mutexes
                ON CONFLICT DO NOTHING`,
                `DROP TABLE IF EXISTS ${p}job_keys`,
                `DROP TABLE IF EXISTS ${p}mutexes`,
            ],
        },
        {
            // Rate limits: the next allowed start of each rate key (its theoretical arrival time, GCRA), in µs; the
            // rate keys of a job, frozen at enqueue with their settings, as a JSON array sorted by key.
            id: '0007_rate_limits',
            version: '6.0.0',
            statements: [
                `CREATE TABLE IF NOT EXISTS ${p}rate_limits (
                    limit_key varchar(255) COLLATE "C" NOT NULL PRIMARY KEY,
                    tat timestamptz(6) NOT NULL
                )`,
                // The sweep deletes the rows whose tat passed
                `CREATE INDEX IF NOT EXISTS ${p}rate_limits_tat ON ${p}rate_limits (tat)`,
                `ALTER TABLE ${p}jobs ADD COLUMN IF NOT EXISTS rate_limits jsonb`,
            ],
        },
        {
            // sqlane.jobs.list(): the jobs of a name, newest first, by enqueue time then id. Not CONCURRENTLY: a
            // migration is one transaction, so the build blocks the writes of the table while it runs.
            id: '0008_job_list',
            version: '7.1.0',
            statements: [`CREATE INDEX IF NOT EXISTS ${p}jobs_list ON ${p}jobs (job_name, created_at, id)`],
            down: [`DROP INDEX IF EXISTS ${p}jobs_list`],
        },
        {
            // 9.0: the kind of a job is its lane. Renames only: metadata, in the transaction of the migration.
            id: '0009_lanes',
            version: '9.0.0',
            statements: [
                `ALTER TABLE ${p}jobs RENAME COLUMN job_name TO lane`,
                `ALTER TABLE ${p}jobs RENAME COLUMN failure_job TO failure_lane`,
                `ALTER TABLE ${p}schedules RENAME COLUMN job_name TO lane`,
            ],
            down: [
                `ALTER TABLE ${p}jobs RENAME COLUMN lane TO job_name`,
                `ALTER TABLE ${p}jobs RENAME COLUMN failure_lane TO failure_job`,
                `ALTER TABLE ${p}schedules RENAME COLUMN lane TO job_name`,
            ],
        },
        {
            // 10.0: the global pauses. A row of paused_lanes holds its lane in every process; a schedule with a
            // paused_at fires in none. Its down drops both: the paused lanes and schedules run again.
            id: '0010_pause',
            version: '10.0.0',
            statements: [
                `CREATE TABLE IF NOT EXISTS ${p}paused_lanes (
                    lane varchar(128) COLLATE "C" NOT NULL PRIMARY KEY,
                    paused_at timestamptz(3) NOT NULL
                )`,
                `ALTER TABLE ${p}schedules ADD COLUMN IF NOT EXISTS paused_at timestamptz(3)`,
            ],
            down: [
                `DROP TABLE IF EXISTS ${p}paused_lanes`,
                `ALTER TABLE ${p}schedules DROP COLUMN IF EXISTS paused_at`,
            ],
        },
        {
            // 10.1: the fair groups. A nullable column (metadata only), and the index that the claim of a grouped
            // lane reads: the oldest due jobs of each group, and the skip from one group to the next. It covers the
            // pending rows of every lane. On a big table, build it CONCURRENTLY beforehand: the migration's
            // transaction holds the table's lock while it builds. Its down drops both: the groups are lost.
            id: '0011_fair_groups',
            version: '10.1.0',
            statements: [
                `ALTER TABLE ${p}jobs ADD COLUMN IF NOT EXISTS fair_group varchar(255) COLLATE "C"`,
                `CREATE INDEX IF NOT EXISTS ${p}jobs_pending_group ON ${p}jobs (lane, fair_group, run_at, id)
                    WHERE status = 'pending'`,
            ],
            down: [
                `DROP INDEX IF EXISTS ${p}jobs_pending_group`,
                `ALTER TABLE ${p}jobs DROP COLUMN IF EXISTS fair_group`,
            ],
        },
    ];
}

/**
 * @param {string} p
 * @returns {string}
 */
export function postgresMigrationsTable(p) {
    return `CREATE TABLE IF NOT EXISTS ${p}migrations (
        id varchar(64) COLLATE "C" NOT NULL PRIMARY KEY,
        applied_at timestamptz(3) NOT NULL
    )`;
}
