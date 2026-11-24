// Type tests under `exactOptionalPropertyTypes`, as an app with that option writes them: checked by tsc
// (test/types/tsconfig.exact_optional.json, in `pnpm typecheck` and the hooks), never run. Without the option, an
// optional field accepts `undefined` whatever its type says, so only this config can catch a missing `| undefined`.
import mysql from 'mysql2/promise';
import { createSqlane, defineLane, defineSchedule } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';

/** The type tests: never called. */
export async function exactOptionalTypes() {
    const cursor = undefined as string | undefined;
    const nextCursor = null as string | null;
    const pool = mysql.createPool({});
    const sqlane = createSqlane({ adapter: mysql2Adapter(pool, { dialect: 'mysql' }) });

    // A field set to undefined counts as absent
    await sqlane.jobs.list(
        { lane: 'build_report', status: undefined },
        { limit: undefined, cursor: undefined, includePayload: undefined },
    );
    await sqlane.jobs.list({ lane: 'build_report' }, { cursor });
    // The nextCursor of a page, as it comes: null on the last page
    await sqlane.jobs.list({ lane: 'build_report' }, { cursor: nextCursor });
    await sqlane.jobs.list({ lane: 'build_report' }, { cursor: null });

    // The bulk methods: a field set to undefined counts as absent
    await sqlane.jobs.retry({ jobIds: ['a'], lane: undefined, status: undefined }, {
        budget: undefined,
        connection: undefined,
        mode: undefined,
        strict: undefined,
        includeAffectedJobIds: undefined,
    });
    await sqlane.jobs.cancel({ lane: 'build_report', status: undefined, jobIds: undefined }, { strict: undefined });
    await sqlane.jobs.remove({ lane: 'build_report' }, { connection: undefined, mode: undefined });

    // keyStats: an option set to undefined counts as absent
    await sqlane.jobs.keyStats({ limit: undefined, type: undefined, orderBy: undefined });

    // runSlot: an option set to undefined counts as absent
    const tick = defineSchedule(defineLane({ name: 'tick' }), { key: 'a', every: '1m' });

    await sqlane.schedules.runSlot(tick, { at: undefined, connection: undefined });

    // The global pauses: a connection set to undefined counts as absent
    await sqlane.lanes.pauseGlobally('tick', { connection: undefined });
    await sqlane.schedules.remove(tick, { connection: undefined });
}
