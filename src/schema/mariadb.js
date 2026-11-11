// The schema of sqlane on MariaDB 10.11+. Each statement is idempotent: MariaDB commits each DDL statement, so a
// migration cut in the middle runs again from its start. A copy of the MySQL schema, changed where MariaDB differs: the
// collation (MariaDB 10.11 has no utf8mb4_0900_bin).

/** IDs, names, keys, tokens: ASCII, compared byte by byte (case-sensitive, like PostgreSQL). */
const ASCII = 'CHARACTER SET ascii COLLATE ascii_bin';

/**
 * @param {string} p The table prefix.
 * @returns {import('../types.js').Migration[]}
 */
export function mariadbMigrations(p) {
    return [
        {
            id: '0001_initial',
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
