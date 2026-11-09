// Type tests of declared payloads, as a TypeScript app writes them: checked by tsc (pnpm typecheck), never run.
import mysql from 'mysql2/promise';
import { expectTypeOf } from 'vitest';
import { createSqlane, defineJob } from '@sqlane/core';
import type { Handler } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';

type Report = { reportId: string; pages?: number };

// A handler written apart
const handler: Handler<Report> = ({ payload }) => payload.reportId;

/** The type tests: never called. */
export async function typedPayloadsTypes() {
    const pool = mysql.createPool({});
    const sqlane = createSqlane({ adapter: mysql2Adapter(pool) });
    const buildReport = defineJob<Report>({
        name: 'build_report',
        mutexKeys: report => [`report:${report.reportId}`],
        timeout: '1m',
    });

    await sqlane.enqueue(pool, buildReport, { reportId: 'r1' });
    await sqlane.enqueueMany(pool, buildReport, [{ payload: { reportId: 'r1', pages: 2 } }]);
    // @ts-expect-error reportId is required
    await sqlane.enqueue(pool, buildReport, { pages: 2 });
    // @ts-expect-error pages is a number
    await sqlane.enqueue(pool, buildReport, { reportId: 'r1', pages: '2' });

    sqlane.handle(buildReport, ({ payload }) => {
        expectTypeOf(payload).toEqualTypeOf<Report>();
    });

    sqlane.handle(buildReport, handler);

    // A typed definition in the lists of definitions
    createSqlane({ adapter: mysql2Adapter(pool), jobs: [buildReport, defineJob({ name: 'other' })] });
    defineJob({ name: 'with_failure_job', failureJob: buildReport });

    // @ts-expect-error the payload of mutexKeys is a Report
    defineJob<Report>({ name: 'a', mutexKeys: (report: { id: number }) => [String(report.id)], timeout: '1m' });

    // Without a type argument: as before, any JSON
    const untyped = defineJob({ name: 'untyped' });

    await sqlane.enqueue(pool, untyped, { anything: [1, 'a'] });
    sqlane.handle(untyped, ({ payload }) => {
        expectTypeOf(payload).toBeAny();
    });
}
