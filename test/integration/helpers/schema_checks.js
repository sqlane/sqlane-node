/**
 * The schema through an adapter, on an instance of a prefix of its own: `rollback()` to 6.0.0, `migrate()` again, both
 * reads, then `drop()`.
 * @param {import('../../../src/types.js').Sqlane<any>} sqlane Migrated, not started.
 * @param {string} p Its table prefix.
 * @returns {Promise<{ reverted: string[], applied: string[], status: object, problems: object, dropped: string[] }>}
 *     What each did; the tables without the prefix.
 */
export async function checkSchemaChanges(sqlane, p) {
    const { reverted } = await sqlane.schema.rollback({ targetVersion: '6.0.0' });
    const { applied } = await sqlane.schema.migrate();
    const status = await sqlane.schema.getMigrationStatus();
    const problems = await sqlane.schema.findSchemaProblems();
    const { dropped } = await sqlane.schema.drop();

    return { reverted, applied, status, problems, dropped: dropped.map(table => table.slice(p.length)) };
}

/** What `checkSchemaChanges` gives on a migrated prefix */
export const SCHEMA_CHANGES = {
    reverted: ['0011_fair_groups', '0010_pause', '0009_lanes', '0008_job_list'],
    applied: ['0008_job_list', '0009_lanes', '0010_pause', '0011_fair_groups'],
    status: { ok: true, missingRequired: [], missingOptional: [], unknownApplied: [] },
    problems: { ok: true, problems: [] },
    dropped: ['jobs', 'payloads', 'schedules', 'concurrency_slots', 'rate_limits', 'paused_lanes', 'migrations'],
};
