/**
 * The schema through an adapter, on an instance of a prefix of its own: `rollback()` to 6.0.0, `migrate()` again, then
 * `drop()`.
 * @param {import('../../../src/types.js').Sqlane<any>} sqlane Migrated, not started.
 * @param {string} p Its table prefix.
 * @returns {Promise<{ reverted: string[], applied: string[], dropped: string[] }>} What each did; the tables without
 *     the prefix.
 */
export async function checkSchemaChanges(sqlane, p) {
    const { reverted } = await sqlane.schema.rollback({ targetVersion: '6.0.0' });
    const { applied } = await sqlane.schema.migrate();
    const { dropped } = await sqlane.schema.drop();

    return { reverted, applied, dropped: dropped.map(table => table.slice(p.length)) };
}

/** What `checkSchemaChanges` gives on a migrated prefix */
export const SCHEMA_CHANGES = {
    reverted: ['0008_job_list'],
    applied: ['0008_job_list'],
    dropped: ['jobs', 'payloads', 'schedules', 'concurrency_slots', 'rate_limits', 'migrations'],
};
