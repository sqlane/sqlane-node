// What this version's migrations create, per dialect, for findSchemaProblems(): the tables (`<p>migrations` left
// out), their columns and their indexes, by name, each with the migration that gives it this name and definition.
// Written by hand from the migrations: the test of a fresh and of an upgraded schema on every server checks it.

/**
 * @typedef {object} ExpectedTable
 * @property {string} migration The id of the migration that gives it this name and definition: also that of its
 *     columns and indexes, unless they name one.
 * @property {[name: string, type: string, notNull: boolean, migration?: string][]} columns The type as the catalog
 *     reports it (MySQL `COLUMN_TYPE` without display widths, PostgreSQL `format_type`), with ` collate <name>` where
 *     the migration sets one.
 * @property {[name: string, definition: string, migration?: string][]} indexes The name without the prefix (MySQL's
 *     primary key: `PRIMARY`); the definition as `readIndexes` writes it.
 */

const LIMITS = '0005_concurrency_limits';
const LANES = '0009_lanes';
const PAUSE = '0010_pause';
const FAIR_GROUPS = '0011_fair_groups';
const ASCII = ' collate ascii_bin';

/** @type {Record<string, ExpectedTable>} MySQL; MariaDB with its JSON as `longtext` */
const MYSQL = {
    jobs: {
        migration: '0001_initial',
        columns: [
            ['id', `varchar(255)${ASCII}`, true],
            ['lane', `varchar(128)${ASCII}`, true, LANES],
            ['status', `varchar(16)${ASCII}`, true],
            ['run_at', 'datetime(3)', true],
            ['attempts', 'int', true],
            ['max_attempts', 'int', true],
            ['stalls', 'int', true],
            ['max_stalls', 'int', true],
            ['limit_keys', 'json', false, LIMITS],
            ['limit_maxes', 'json', false, LIMITS],
            ['enqueue_token', `varchar(26)${ASCII}`, true],
            ['lock_token', `varchar(26)${ASCII}`, false],
            ['locked_by', 'varchar(255)', false],
            ['locked_until', 'datetime(3)', false],
            ['timed_out_at', 'datetime(3)', false],
            ['last_error', 'json', false],
            ['completed_retention_ms', 'bigint', true],
            ['failed_retention_ms', 'bigint', true],
            ['failure_lane', `varchar(128)${ASCII}`, false, LANES],
            ['created_at', 'datetime(3)', true],
            ['started_at', 'datetime(3)', false],
            ['finished_at', 'datetime(3)', false],
            ['expires_at', 'datetime(3)', false],
            ['updated_at', 'datetime(3)', true],
            ['blocked_on', `varchar(255)${ASCII}`, false, LIMITS],
            ['rate_limits', 'json', false, '0007_rate_limits'],
            ['fair_group', `varchar(255)${ASCII}`, false, FAIR_GROUPS],
        ],
        indexes: [
            ['PRIMARY', 'unique (id)'],
            ['jobs_status_lane_run_at', '(status, lane, run_at)', LANES],
            ['jobs_expires_at', '(expires_at)'],
            ['jobs_blocked', '(status, blocked_on, run_at, id)', LIMITS],
            ['jobs_list', '(lane, created_at, id)', LANES],
            ['jobs_status_lane_group', '(status, lane, fair_group, run_at, id)', FAIR_GROUPS],
        ],
    },
    payloads: {
        migration: '0001_initial',
        columns: [['id', `varchar(255)${ASCII}`, true], ['payload', 'json', true]],
        indexes: [['PRIMARY', 'unique (id)']],
    },
    schedules: {
        migration: '0004_schedules',
        columns: [
            ['id', `varchar(255)${ASCII}`, true],
            ['lane', `varchar(128)${ASCII}`, true, LANES],
            ['spec', `varchar(512)${ASCII}`, true],
            ['last_slot_at', 'datetime(3)', true],
            ['last_job_id', `varchar(255)${ASCII}`, false],
            ['created_at', 'datetime(3)', true],
            ['updated_at', 'datetime(3)', true],
            ['paused_at', 'datetime(3)', false, PAUSE],
        ],
        indexes: [['PRIMARY', 'unique (id)']],
    },
    concurrency_slots: {
        migration: '0006_concurrency_slots',
        columns: [
            ['limit_key', `varchar(255)${ASCII}`, true],
            ['slot', 'int', true],
            ['job_id', `varchar(255)${ASCII}`, true],
            ['lock_token', `varchar(26)${ASCII}`, true],
            ['held_until', 'datetime(3)', false],
            ['created_at', 'datetime(3)', true],
        ],
        indexes: [['PRIMARY', 'unique (limit_key, slot)'], ['concurrency_slots_job_id', '(job_id)']],
    },
    rate_limits: {
        migration: '0007_rate_limits',
        columns: [['limit_key', `varchar(255)${ASCII}`, true], ['tat', 'datetime(6)', true]],
        indexes: [['PRIMARY', 'unique (limit_key)'], ['rate_limits_tat', '(tat)']],
    },
    paused_lanes: {
        migration: PAUSE,
        columns: [['lane', `varchar(128)${ASCII}`, true], ['paused_at', 'datetime(3)', true]],
        indexes: [['PRIMARY', 'unique (lane)']],
    },
};

/** @type {Record<string, ExpectedTable>} MariaDB stores JSON as `longtext` */
const MARIADB = Object.fromEntries(Object.entries(MYSQL).map(([name, table]) => [name, {
    ...table,
    columns: table.columns.map(([column, type, ...rest]) => [column, type === 'json' ? 'longtext' : type, ...rest]),
}]));

const C = ' collate C';
const VARCHAR = 'character varying';
const TIME = 'timestamp(3) with time zone';

/**
 * @param {string} status
 * @returns {string} The predicate of a partial index on a status, as `pg_get_expr` writes it.
 */
const whereStatus = status => ` where ((status)::text = '${status}'::text)`;

/** @type {Record<string, ExpectedTable>} */
const POSTGRES = {
    jobs: {
        migration: '0001_initial',
        columns: [
            ['id', `${VARCHAR}(255)${C}`, true],
            ['lane', `${VARCHAR}(128)${C}`, true, LANES],
            ['status', `${VARCHAR}(16)${C}`, true],
            ['run_at', TIME, true],
            ['attempts', 'integer', true],
            ['max_attempts', 'integer', true],
            ['stalls', 'integer', true],
            ['max_stalls', 'integer', true],
            ['limit_keys', `text[]${C}`, false, LIMITS],
            ['limit_maxes', 'integer[]', false, LIMITS],
            ['enqueue_token', `${VARCHAR}(26)${C}`, true],
            ['lock_token', `${VARCHAR}(26)${C}`, false],
            ['locked_by', `${VARCHAR}(255)`, false],
            ['locked_until', TIME, false],
            ['timed_out_at', TIME, false],
            ['last_error', 'jsonb', false],
            ['completed_retention_ms', 'bigint', true],
            ['failed_retention_ms', 'bigint', true],
            ['failure_lane', `${VARCHAR}(128)${C}`, false, LANES],
            ['created_at', TIME, true],
            ['started_at', TIME, false],
            ['finished_at', TIME, false],
            ['expires_at', TIME, false],
            ['updated_at', TIME, true],
            ['blocked_on', `${VARCHAR}(255)${C}`, false, LIMITS],
            ['rate_limits', 'jsonb', false, '0007_rate_limits'],
            ['fair_group', `${VARCHAR}(255)${C}`, false, FAIR_GROUPS],
        ],
        indexes: [
            ['jobs_pkey', 'unique (id)'],
            ['jobs_pending_group', `(lane, fair_group, run_at, id)${whereStatus('pending')}`, FAIR_GROUPS],
            ['jobs_pending', `(lane, run_at, id)${whereStatus('pending')}`, LANES],
            ['jobs_running', `(locked_until)${whereStatus('running')}`],
            ['jobs_expires_at', '(expires_at)'],
            ['jobs_blocked', `(blocked_on, run_at, id)${whereStatus('blocked')}`, LIMITS],
            ['jobs_list', '(lane, created_at, id)', LANES],
        ],
    },
    payloads: {
        migration: '0001_initial',
        columns: [['id', `${VARCHAR}(255)${C}`, true], ['payload', 'jsonb', true]],
        indexes: [['payloads_pkey', 'unique (id)']],
    },
    schedules: {
        migration: '0004_schedules',
        columns: [
            ['id', `${VARCHAR}(255)${C}`, true],
            ['lane', `${VARCHAR}(128)${C}`, true, LANES],
            ['spec', `${VARCHAR}(512)${C}`, true],
            ['last_slot_at', TIME, true],
            ['last_job_id', `${VARCHAR}(255)${C}`, false],
            ['created_at', TIME, true],
            ['updated_at', TIME, true],
            ['paused_at', TIME, false, PAUSE],
        ],
        indexes: [['schedules_pkey', 'unique (id)']],
    },
    concurrency_slots: {
        migration: '0006_concurrency_slots',
        columns: [
            ['limit_key', `${VARCHAR}(255)${C}`, true],
            ['slot', 'integer', true],
            ['job_id', `${VARCHAR}(255)${C}`, true],
            ['lock_token', `${VARCHAR}(26)${C}`, true],
            ['held_until', TIME, false],
            ['created_at', TIME, true],
        ],
        indexes: [['concurrency_slots_pkey', 'unique (limit_key, slot)'], ['concurrency_slots_job_id', '(job_id)']],
    },
    rate_limits: {
        migration: '0007_rate_limits',
        columns: [['limit_key', `${VARCHAR}(255)${C}`, true], ['tat', 'timestamp(6) with time zone', true]],
        indexes: [['rate_limits_pkey', 'unique (limit_key)'], ['rate_limits_tat', '(tat)']],
    },
    paused_lanes: {
        migration: PAUSE,
        columns: [['lane', `${VARCHAR}(128)${C}`, true], ['paused_at', TIME, true]],
        indexes: [['paused_lanes_pkey', 'unique (lane)']],
    },
};

/** @type {Record<import('../types.js').Dialect, Record<string, ExpectedTable>>} By table name without the prefix */
export const EXPECTED_SCHEMA = { mysql: MYSQL, mariadb: MARIADB, postgres: POSTGRES };
