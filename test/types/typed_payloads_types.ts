// Type tests of declared payloads, as a TypeScript app writes them: checked by tsc (pnpm typecheck), never run.
import mysql from 'mysql2/promise';
import { expectTypeOf } from 'vitest';
import { createSqlane, defineConcurrencyLimit, defineLane, defineRateLimit } from '@sqlane/core';
import type { Handler, HandlerPayload } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';

type Report = { reportId: string; pages?: number };

// A handler written apart
const handler: Handler<Report> = ({ payload }) => payload.reportId;

/** The type tests: never called. */
export async function typedPayloadsTypes() {
    const pool = mysql.createPool({});
    const sqlane = createSqlane({ adapter: mysql2Adapter(pool, { dialect: 'mysql' }) });
    const reportLimit = defineConcurrencyLimit({ name: 'report', max: 1 });
    const buildReport = defineLane<Report>({
        name: 'build_report',
        globalConcurrencyLimits: ({ payload: report }) => [reportLimit.key(report.reportId)],
        timeout: '1m',
    });

    await sqlane.enqueue(pool, buildReport, { reportId: 'r1' });
    await sqlane.enqueueMany(pool, buildReport, [{ payload: { reportId: 'r1', pages: 2 } }]);
    // @ts-expect-error reportId is required
    await sqlane.enqueue(pool, buildReport, { pages: 2 });
    // @ts-expect-error pages is a number
    await sqlane.enqueue(pool, buildReport, { reportId: 'r1', pages: '2' });

    sqlane.lanes.add(buildReport, ({ payload }) => {
        expectTypeOf(payload).toEqualTypeOf<Report>();
    });

    sqlane.lanes.add(buildReport, handler);

    // A typed definition in the lists of definitions
    createSqlane({ adapter: mysql2Adapter(pool, { dialect: 'mysql' }), lanes: [buildReport, defineLane({ name: 'other' })] });
    defineLane({ name: 'with_failure_lane', failureLane: buildReport });

    defineLane<Report>({
        name: 'a',
        // @ts-expect-error the payload of globalConcurrencyLimits is a Report
        globalConcurrencyLimits: ({ payload }: { payload: { id: number } }) => [reportLimit.key(payload.id)],
        timeout: '1m',
    });

    const reportApi = defineRateLimit({ name: 'report_api', max: 10, per: '1s' });

    defineLane<Report>({
        name: 'b',
        globalRateLimits: ({ payload: report }) => [reportApi.key(report.reportId, { cost: 1 })],
    });
    defineLane<Report>({
        name: 'c',
        // @ts-expect-error the payload of globalRateLimits is a Report
        globalRateLimits: ({ payload }: { payload: { id: number } }) => [reportApi.key(payload.id)],
    });

    // Without a type argument: as before, any JSON
    const untyped = defineLane({ name: 'untyped' });

    await sqlane.enqueue(pool, untyped, { anything: [1, 'a'] });
    sqlane.lanes.add(untyped, ({ payload }) => {
        expectTypeOf(payload).toBeAny();
    });

    // sqlane.jobs: a definition types the payload of a list; a name gives any; get takes the type unchecked
    const typedPage = await sqlane.jobs.list({ lane: buildReport }, { includePayload: true });

    expectTypeOf(typedPage.jobs[0].payload).toEqualTypeOf<Report | undefined>();

    const namedPage = await sqlane.jobs.list({ lane: 'build_report' });

    expectTypeOf(namedPage.jobs[0].payload).toBeAny();

    const read = await sqlane.jobs.get<Report>('build_report:r1');

    expectTypeOf(read?.payload).toEqualTypeOf<Report | undefined>();

    type Page = HandlerPayload<typeof buildReport>;

    expectTypeOf<Page>().toEqualTypeOf<Report>();
}
