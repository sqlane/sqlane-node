// The packaging split: `@sqlane/core` (the sqlane, the definitions) never loads the runner side, which
// `@sqlane/core/runner` holds. A producer pays for no worker code.
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { expect, test } from 'vitest';

const SRC = import.meta.dirname;

/**
 * @param {string} entry A module of src/.
 * @returns {string[]} The modules of src/ that it reaches by static imports and re-exports, sorted.
 */
function staticallyReached(entry) {
    /** @type {Set<string>} */
    const seen = new Set();

    /** @param {string} file */
    function walk(file) {
        if (seen.has(file)) {
            return;
        }

        seen.add(file);

        for (const match of readFileSync(file, 'utf8').matchAll(/^(?:import|export)\s[^;]*?from\s+'(\.[^']+)';/gmsu)) {
            walk(join(dirname(file), match[1]));
        }
    }

    walk(join(SRC, entry));

    return [...seen].map(file => relative(SRC, file)).toSorted();
}

/** The runner side: only `@sqlane/core/runner` loads it */
const RUNNER_SIDE = [
    'create_runner.js', 'dispatcher.js', 'failure_lanes.js', 'job_runs.js', 'key_unblocks.js', 'leases.js',
    'local_limits.js', 'maintenance.js', 'mounts.js', 'registry.js', 'reprobes.js', 'runner.js', 'scheduler.js',
];

test('src/index.js reaches only the modules of the allowlist: none of the runner side', () => {
    const reached = staticallyReached('index.js');

    expect(reached.filter(file => RUNNER_SIDE.includes(file))).toStrictEqual([]);
    expect(reached).toStrictEqual([
        'concurrency_keys.js', 'create_sqlane.js', 'cron.js', 'defaults.js', 'define_concurrency_limit.js',
        'define_handler.js', 'define_lane.js', 'define_rate_limit.js', 'define_schedule.js', 'duration.js', 'enqueue.js',
        'error_json.js', 'errors.js', 'gcra.js', 'hint_channel.js', 'index.js', 'jobs_api.js', 'jobs_bulk.js',
        'local_settings.js', 'migrations.js', 'new_job.js', 'payload.js', 'rate_keys.js', 'rate_limit_shape.js',
        'run_slot.js', 'schedule.js', 'schedule_list.js', 'schema/expected.js', 'schema/mariadb.js', 'schema/mysql.js',
        'schema/postgres.js', 'schema_status.js', 'server_check.js', 'sqlane_internals.js', 'store/fire_slots.js',
        'store/job_reads.js', 'store/job_writes.js', 'store/key_stats.js', 'store/mariadb_enqueue.js',
        'store/mariadb_final.js', 'store/mariadb_schedules.js', 'store/mariadb_worker.js', 'store/mysql_enqueue.js',
        'store/mysql_final.js', 'store/mysql_schedules.js', 'store/mysql_worker.js', 'store/postgres_enqueue.js',
        'store/postgres_final.js', 'store/postgres_schedules.js', 'store/postgres_worker.js', 'store/schema_reads.js',
        'store/store.js', 'time_zone.js', 'transient_error.js', 'ulid.js', 'validate.js', 'version.js',
    ]);
});

test('src/create_runner.js reaches the runner side', () => {
    expect(staticallyReached('create_runner.js')).toStrictEqual(expect.arrayContaining(RUNNER_SIDE));
});
