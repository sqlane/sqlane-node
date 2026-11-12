import { setTimeout as sleep } from 'node:timers/promises';
import { expect } from 'vitest';
import { ConfigError } from '../../../src/index.js';

/**
 * The schedules through an adapter: start() without the table of the schedules asks for migrate() (the error of the
 * driver, wrapped by the ORM), then a slot adds its job.
 * @param {import('../../../src/types.js').Sqlane<any, any>} sqlane Migrated, not started.
 * @param {string} p Its table prefix.
 * @param {import('../../support/test_database.js').TestDatabaseConnection} database
 * @returns {Promise<string | null>} The id of the first job of the schedule.
 */
export async function checkSchedules(sqlane, p, database) {
    // As a database of 3.x
    await database.query(`DROP TABLE ${p}schedules`);
    await database.query(`DELETE FROM ${p}migrations WHERE id = '0004_schedules'`);
    sqlane.schedule('tick', { every: '1s' });

    await expect(sqlane.start()).rejects.toThrow(ConfigError);
    await expect(sqlane.start()).rejects.toThrow(`start(): the table ${p}schedules is missing: run migrate()`);
    await expect(sqlane.migrate()).resolves.toStrictEqual({ applied: ['0004_schedules'] });
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
