// The schema of sqlane on PostgreSQL 15+. The migrations run in one transaction (transactional DDL).

/**
 * @param {string} p The table prefix.
 * @returns {import('../types.js').Migration[]}
 */
export function postgresMigrations(p) {
    return [
        {
            id: '0001_initial',
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
            statements: [
                `DROP INDEX IF EXISTS ${p}jobs_pending`,
                `CREATE INDEX IF NOT EXISTS ${p}jobs_pending ON ${p}jobs (job_name, run_at, id) WHERE status = 'pending'`,
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
