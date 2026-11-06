// The schema of sqlane on MySQL 8.4+. Each statement is idempotent: MySQL commits each DDL statement, so a migration
// cut in the middle runs again from its start.

/** IDs, names, keys, tokens: ASCII, compared byte by byte (case-sensitive, like PostgreSQL). */
const ASCII = 'CHARACTER SET ascii COLLATE ascii_bin';

/**
 * @param {string} p The table prefix.
 * @returns {import('../types.js').Migration[]}
 */
export function mysqlMigrations(p) {
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
                    enqueue_token CHAR(26) ${ASCII} NOT NULL,
                    lock_token CHAR(26) ${ASCII} NULL,
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
                ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin`,
                `CREATE TABLE IF NOT EXISTS ${p}payloads (
                    id VARCHAR(255) ${ASCII} NOT NULL,
                    payload JSON NOT NULL,
                    PRIMARY KEY (id)
                ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin`,
                `CREATE TABLE IF NOT EXISTS ${p}mutexes (
                    mutex_key VARCHAR(255) ${ASCII} NOT NULL,
                    job_id VARCHAR(255) ${ASCII} NOT NULL,
                    lock_token CHAR(26) ${ASCII} NOT NULL,
                    held_until DATETIME(3) NULL,
                    created_at DATETIME(3) NOT NULL,
                    PRIMARY KEY (mutex_key),
                    KEY ${p}mutexes_job_id (job_id)
                ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin`,
            ],
        },
    ];
}

/**
 * @param {string} p
 * @returns {string}
 */
export function mysqlMigrationsTable(p) {
    return `CREATE TABLE IF NOT EXISTS ${p}migrations (
        id VARCHAR(64) ${ASCII} NOT NULL,
        applied_at DATETIME(3) NOT NULL,
        PRIMARY KEY (id)
    ) ENGINE = InnoDB`;
}
