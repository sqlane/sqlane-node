import { setTimeout as sleep } from 'node:timers/promises';
import { expect } from 'vitest';
import { ConfigError } from '../../../src/index.js';
import { migrationsOf } from '../../../src/migrations.js';

/**
 * The schedules through an adapter: start() without the table of the schedules asks for schema.migrate() (the error of
 * the driver, wrapped by the ORM), then a slot adds its job.
 * @param {import('../../../src/types.js').Sqlane<any>} sqlane Migrated, not started.
 * @param {string} p Its table prefix.
 * @param {import('../../support/test_database.js').TestDatabaseConnection} database
 * @returns {Promise<string | null>} The id of the first job of the schedule.
 */
export async function checkSchedules(sqlane, p, database) {
    const lanes = /** @type {import('../../../src/migrations.js').Migration} */ (
        migrationsOf(database.dialect, p).find(({ id }) => id === '0009_lanes'));
    // The renames of the jobs back: MySQL and MariaDB one guarded step, PostgreSQL two statements
    const jobsDown = (lanes.down ?? [])
        .map(step => (typeof step === 'string' ? step : step.sql))
        .filter(sql => sql.startsWith(`ALTER TABLE ${p}jobs `));

    // As a database of 3.x: no table of the schedules, the columns of the jobs before 0009_lanes
    await database.query(`DROP TABLE ${p}schedules`);

    for (const sql of jobsDown) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await database.query(sql);
    }

    await database.query(`DELETE FROM ${p}migrations WHERE id IN ('0004_schedules', '0009_lanes')`);
    sqlane.schedule('tick', { every: '1s' });

    await expect(sqlane.start()).rejects.toThrow(ConfigError);
    await expect(sqlane.start()).rejects.toThrow(`start(): the table ${p}schedules is missing: run schema.migrate()`);
    await expect(sqlane.schema.migrate()).resolves.toStrictEqual({ applied: ['0004_schedules', '0009_lanes'] });
    await sqlane.start();

    const deadline = Date.now() + 5000;
    /** @type {Record<string, unknown>[]} */
    let rows = [];

    while (!rows.length && Date.now() < deadline) {
        // oxlint-disable-next-line no-await-in-loop -- polls
        await sleep(50);
        // oxlint-disable-next-line no-await-in-loop -- polls
        rows = await database.query(`SELECT id FROM ${p}jobs`);
    }

    return rows.length ? String(rows[0].id) : null;
}
