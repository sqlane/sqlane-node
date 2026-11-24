// The boundary inside the package: the core (the sqlane: the database side, src/create_sqlane.js) never imports the
// runner side; only create_runner.js does. `@sqlane/core` exports both.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { expect, test } from 'vitest';
import * as core from './index.js';

const SRC = import.meta.dirname;

/**
 * @param {string} file A module of src/.
 * @returns {string[]} The modules of src/ that it imports or re-exports itself.
 */
function directImports(file) {
    return [...readFileSync(join(SRC, file), 'utf8').matchAll(/^(?:import|export)\s[^;]*?from\s+'(\.[^']+)';/gmsu)]
        .map(match => relative(SRC, join(SRC, dirname(file), match[1])));
}

/** @returns {string[]} The modules of src/, but the tests. */
function sourceModules() {
    return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
        .filter(file => file.endsWith('.js') && !file.endsWith('.test.js'));
}

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

        for (const imported of directImports(file)) {
            walk(imported);
        }
    }

    walk(entry);

    return [...seen].toSorted();
}

/** The runner side: outside it, only index.js imports it, and only create_runner.js of it */
const RUNNER_SIDE = [
    'create_runner.js', 'dispatcher.js', 'failure_lanes.js', 'job_runs.js', 'key_unblocks.js', 'leases.js',
    'local_limits.js', 'maintenance.js', 'mounts.js', 'registry.js', 'reprobes.js', 'runner.js', 'scheduler.js',
];

test('the core, src/create_sqlane.js, reaches only the modules of the allowlist: none of the runner side', () => {
    const reached = staticallyReached('create_sqlane.js');

    expect(reached.filter(file => RUNNER_SIDE.includes(file))).toStrictEqual([]);
    expect(reached).toStrictEqual([
        'concurrency_keys.js', 'create_sqlane.js', 'cron.js', 'defaults.js', 'define_concurrency_limit.js',
        'define_rate_limit.js', 'define_schedule.js', 'duration.js', 'enqueue.js', 'error_json.js', 'errors.js',
        'gcra.js', 'hint_channel.js', 'jobs_api.js', 'jobs_bulk.js', 'local_settings.js', 'migrations.js', 'new_job.js',
        'payload.js', 'rate_keys.js', 'rate_limit_shape.js', 'run_slot.js', 'schedule.js', 'schedule_list.js',
        'schema/expected.js', 'schema/mariadb.js', 'schema/mysql.js', 'schema/postgres.js', 'schema_status.js',
        'server_check.js', 'sqlane_internals.js', 'store/fire_slots.js', 'store/job_reads.js', 'store/job_writes.js',
        'store/key_stats.js', 'store/mariadb_enqueue.js', 'store/mariadb_final.js', 'store/mariadb_schedules.js',
        'store/mariadb_worker.js', 'store/mysql_enqueue.js', 'store/mysql_final.js', 'store/mysql_schedules.js',
        'store/mysql_worker.js', 'store/pauses.js', 'store/postgres_enqueue.js', 'store/postgres_final.js',
        'store/postgres_schedules.js', 'store/postgres_worker.js', 'store/schema_reads.js', 'store/store.js',
        'time_zone.js', 'transient_error.js', 'ulid.js', 'validate.js', 'version.js',
    ]);
});

test('outside the runner side, only src/index.js imports it: create_runner.js, for createRunner', () => {
    const outside = sourceModules().filter(file => !RUNNER_SIDE.includes(file));
    const imports = outside.flatMap(file => directImports(file)
        .filter(imported => RUNNER_SIDE.includes(imported))
        .map(imported => `${file} -> ${imported}`));

    expect(imports).toStrictEqual(['index.js -> create_runner.js']);
});

test('src/create_runner.js reaches the runner side', () => {
    expect(staticallyReached('create_runner.js')).toStrictEqual(expect.arrayContaining(RUNNER_SIDE));
});

test('@sqlane/core exports createRunner, with createSqlane', () => {
    expect(typeof core.createRunner).toBe('function');
    expect(typeof core.createSqlane).toBe('function');
});
