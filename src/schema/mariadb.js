// The schema of sqlane on MariaDB 10.11+. Each statement is idempotent: MariaDB commits each DDL statement, so a
// migration cut in the middle runs again from its start. A copy of the MySQL schema, changed where MariaDB differs: the
// collation (MariaDB 10.11 has no utf8mb4_0900_bin).

/** IDs, names, keys, tokens: ASCII, compared byte by byte (case-sensitive, like PostgreSQL). */
const ASCII = 'CHARACTER SET ascii COLLATE ascii_bin';

/**
 * @param {string} p The table prefix.
 * @returns {import('../migrations.js').Migration[]}
 */
export function mariadbMigrations(p) {
    return [
        {
            id: '0001_initial',
            version: '2.0.0',
            statements: [
                `CREATE TABLE IF NOT EXISTS ${p}jobs (
                    id VARCHAR(255) ${ASCII} NOT NULL,
                    job_name VARCHAR(128) ${ASCII} NOT NULL,
                    status VARCHAR(16) ${ASCII} NOT NULL,
                    run_at DATETIME(3) NOT NULL,
                    attempts INT NOT NULL DEFAULT 0,
                    max_attempts INT NOT NULL,
                    stalls INT NOT NULL DEFAULT 0,
                    max_stalls INT NOT NULL,
                    mutex_keys JSON NULL,
                    enqueue_token VARCHAR(26) ${ASCII} NOT NULL,
                    lock_token VARCHAR(26) ${ASCII} NULL,
                    locked_by VARCHAR(255) NULL,
                    locked_until DATETIME(3) NULL,
                    timed_out_at DATETIME(3) NULL,
                    last_error JSON NULL,
                    completed_retention_ms BIGINT NOT NULL,
                    failed_retention_ms BIGINT NOT NULL,
                    failure_job VARCHAR(128) ${ASCII} NULL,
                    created_at DATETIME(3) NOT NULL,
                    started_at DATETIME(3) NULL,
                    finished_at DATETIME(3) NULL,
                    expires_at DATETIME(3) NULL,
                    updated_at DATETIME(3) NOT NULL,
                    PRIMARY KEY (id),
                    KEY ${p}jobs_status_name_run_at (status, job_name, run_at),
                    KEY ${p}jobs_expires_at (expires_at),
                    CONSTRAINT ${p}jobs_status CHECK (status IN ('pending', 'running', 'completed', 'failed'))
                ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`,
                `CREATE TABLE IF NOT EXISTS ${p}payloads (
                    id VARCHAR(255) ${ASCII} NOT NULL,
                    payload JSON NOT NULL,
                    PRIMARY KEY (id)
                ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`,
                `CREATE TABLE IF NOT EXISTS ${p}mutexes (
                    mutex_key VARCHAR(255) ${ASCII} NOT NULL,
                    job_id VARCHAR(255) ${ASCII} NOT NULL,
                    lock_token VARCHAR(26) ${ASCII} NOT NULL,
                    held_until DATETIME(3) NULL,
                    created_at DATETIME(3) NOT NULL,
                    PRIMARY KEY (mutex_key),
                    KEY ${p}mutexes_job_id (job_id)
                ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`,
            ],
        },
        {
            // The FIFO of a mutex key, and the wake after its release, read the pending jobs of a key in order: a row
            // per key of each pending job. A claim deletes the rows of its jobs, a return to pending adds them again.
            id: '0002_job_keys',
            version: '3.0.0',
            statements: [
                `CREATE TABLE IF NOT EXISTS ${p}job_keys (
                    mutex_key VARCHAR(255) ${ASCII} NOT NULL,
                    run_at DATETIME(3) NOT NULL,
                    job_id VARCHAR(255) ${ASCII} NOT NULL,
                    job_name VARCHAR(128) ${ASCII} NOT NULL,
                    PRIMARY KEY (mutex_key, run_at, job_id),
                    KEY ${p}job_keys_job_id (job_id)
                ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`,
                `INSERT INTO ${p}job_keys (mutex_key, run_at, job_id, job_name)
                SELECT k.mutex_key, j.run_at, j.id, j.job_name FROM ${p}jobs j, JSON_TABLE(j.mutex_keys, '$[*]' COLUMNS (
                        mutex_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PATH '$'
                    )) AS k
                 WHERE j.status = 'pending'
                ON DUPLICATE KEY UPDATE job_id = job_id`,
            ],
        },
        {
            // The cursor of each schedule: its last decided slot. Needed only with schedules. The id is the same on
            // every dialect: it skips 0003, which only PostgreSQL has.
            id: '0004_schedules',
            version: '4.0.0',
            statements: [
                `CREATE TABLE IF NOT EXISTS ${p}schedules (
                    id VARCHAR(255) ${ASCII} NOT NULL,
                    job_name VARCHAR(128) ${ASCII} NOT NULL,
                    spec VARCHAR(512) ${ASCII} NOT NULL,
                    last_slot_at DATETIME(3) NOT NULL,
                    last_job_id VARCHAR(255) ${ASCII} NULL,
                    created_at DATETIME(3) NOT NULL,
                    updated_at DATETIME(3) NOT NULL,
                    PRIMARY KEY (id)
                ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`,
            ],
        },
        {
            // 6.0: global concurrency limits replace mutex keys. A job's keys get their maxes; a job with a full key
            // is `blocked` on it, out of the due jobs, until a release of the key. One statement: atomic. CHANGE
            // COLUMN, not RENAME COLUMN: MariaDB keeps the JSON check of the column under its old name.
            id: '0005_concurrency_limits',
            version: '6.0.0',
            statements: [
                `ALTER TABLE ${p}jobs
                    DROP CONSTRAINT ${p}jobs_status,
                    ADD CONSTRAINT ${p}jobs_states
                        CHECK (status IN ('pending', 'blocked', 'running', 'completed', 'failed')),
                    CHANGE COLUMN mutex_keys limit_keys JSON NULL,
                    ADD COLUMN limit_maxes JSON NULL AFTER limit_keys,
                    ADD COLUMN blocked_on VARCHAR(255) ${ASCII} NULL,
                    ADD KEY ${p}jobs_blocked (status, blocked_on, run_at, id)`,
            ],
        },
        {
            // A mutex key of 5.x gets the max 1; its hold becomes slot 0 of its key. The job_keys and their FIFO go.
            id: '0006_concurrency_slots',
            version: '6.0.0',
            statements: [
                `CREATE TABLE IF NOT EXISTS ${p}concurrency_slots (
                    limit_key VARCHAR(255) ${ASCII} NOT NULL,
                    slot INT NOT NULL,
                    job_id VARCHAR(255) ${ASCII} NOT NULL,
                    lock_token VARCHAR(26) ${ASCII} NOT NULL,
                    held_until DATETIME(3) NULL,
                    created_at DATETIME(3) NOT NULL,
                    PRIMARY KEY (limit_key, slot),
                    KEY ${p}concurrency_slots_job_id (job_id)
                ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`,
                `UPDATE ${p}jobs
                    SET limit_maxes = CONCAT('[', SUBSTRING(REPEAT(',1', JSON_LENGTH(limit_keys)), 2), ']')
                  WHERE limit_keys IS NOT NULL AND limit_maxes IS NULL`,
                `INSERT INTO ${p}concurrency_slots (limit_key, slot, job_id, lock_token, held_until, created_at)
                SELECT mutex_key, 0, job_id, lock_token, held_until, created_at FROM ${p}mutexes
                ON DUPLICATE KEY UPDATE slot = slot`,
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
                    limit_key VARCHAR(255) ${ASCII} NOT NULL,
                    tat DATETIME(6) NOT NULL,
                    PRIMARY KEY (limit_key),
                    -- The sweep deletes the rows whose tat passed
                    KEY ${p}rate_limits_tat (tat)
                ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`,
                `ALTER TABLE ${p}jobs ADD COLUMN IF NOT EXISTS rate_limits JSON NULL AFTER limit_maxes`,
            ],
        },
        {
            // sqlane.jobs.list(): the jobs of a name, newest first, by enqueue time then id. Online: inserts and
            // updates go on while it builds.
            id: '0008_job_list',
            version: '7.1.0',
            statements: [`ALTER TABLE ${p}jobs ADD KEY IF NOT EXISTS ${p}jobs_list (job_name, created_at, id)`],
        },
    ];
}

/**
 * @param {string} p
 * @returns {string}
 */
export function mariadbMigrationsTable(p) {
    return `CREATE TABLE IF NOT EXISTS ${p}migrations (
        id VARCHAR(64) ${ASCII} NOT NULL,
        applied_at DATETIME(3) NOT NULL,
        PRIMARY KEY (id)
    ) ENGINE = InnoDB`;
}
