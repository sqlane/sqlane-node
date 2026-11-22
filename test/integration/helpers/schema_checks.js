/**
 * The schema through an adapter: `rollback()` to 6.0.0, then `migrate()` again, on an instance of a prefix of its own.
 * @param {import('../../../src/types.js').Sqlane<any>} sqlane Migrated, not started.
 * @returns {Promise<{ reverted: string[], applied: string[] }>} What each reverted and applied.
 */
export async function checkSchemaChanges(sqlane) {
    const { reverted } = await sqlane.schema.rollback({ targetVersion: '6.0.0' });
    const { applied } = await sqlane.schema.migrate();

    return { reverted, applied };
}
