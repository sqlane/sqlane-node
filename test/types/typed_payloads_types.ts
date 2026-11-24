// Type tests of declared payloads, as a TypeScript app writes them: checked by tsc (pnpm typecheck), never run.
import mysql from 'mysql2/promise';
import { expectTypeOf } from 'vitest';
import {
    createSqlane,
    defineConcurrencyLimit,
    defineHandler,
    defineLane,
    defineRateLimit,
    defineSchedule,
} from '@sqlane/core';
import type { Handler, HandlerPayload, LaneHandler, ScheduleDefinition, ScheduleOptions } from '@sqlane/core';
import { mysql2Adapter } from '@sqlane/core/adapter-mysql2';
import { createRunner } from '@sqlane/core/runner';
import type { LaneRunStatus, Mount, Runner, RunnerOptions, ScheduleRunStatus } from '@sqlane/core/runner';

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

    // defineHandler: the payload typed by the lane; a lane name is not a lane
    const reportHandler = defineHandler(buildReport, ({ payload }) => {
        expectTypeOf(payload).toEqualTypeOf<Report>();
    }, { fairShareWeight: 2, localConcurrencyLimits: [reportLimit] });

    expectTypeOf(reportHandler).toEqualTypeOf<LaneHandler<Report>>();
    defineHandler(buildReport, handler);
    defineHandler(untyped, ({ payload }) => {
        expectTypeOf(payload).toBeAny();
    });
    // @ts-expect-error a lane name is not a lane definition
    defineHandler('build_report', () => {});
    // @ts-expect-error the handler of a Report lane gets a Report
    defineHandler(buildReport, ({ payload }: { payload: { id: number } }) => payload.id);
    // @ts-expect-error not an option of a handler
    defineHandler(buildReport, handler, { maxAttempts: 3 });

    // defineSchedule: the key is required; the payload typed by the lane, and required with a type
    const daily = defineSchedule(buildReport, { key: 'daily', cron: '0 6 * * *', payload: { reportId: 'r1' } });

    expectTypeOf(daily).toEqualTypeOf<ScheduleDefinition<Report>>();
    expectTypeOf(daily.id).toEqualTypeOf<string>();
    defineSchedule(untyped, { key: 'tick', every: '1m' });
    defineSchedule(untyped, { key: 'tick', every: '1m', payload: { any: [1] } });
    // @ts-expect-error the key is required
    defineSchedule(untyped, { every: '1m' });
    // @ts-expect-error the payload of a Report lane is required
    defineSchedule(buildReport, { key: 'a', every: '1m' });
    // @ts-expect-error the payload is a Report
    defineSchedule(buildReport, { key: 'a', every: '1m', payload: { pages: 2 } });
    // @ts-expect-error a lane name is not a lane definition
    defineSchedule('build_report', { key: 'a', every: '1m' });
    // @ts-expect-error cron or every, not both
    defineSchedule(untyped, { key: 'a', every: '1m', cron: '* * * * *' });
    // @ts-expect-error a payload that is not JSON
    defineSchedule(untyped, { key: 'a', every: '1m', payload: { at: new Date() } });

    // Options built apart, in a variable of the exported type
    const weekly: ScheduleOptions<Report> = { key: 'weekly', cron: '0 6 * * 1', payload: { reportId: 'w' } };

    defineSchedule(buildReport, weekly);

    // The runner of this process: @sqlane/core/runner
    const runnerOptions: RunnerOptions = { localMaxConcurrency: 5 };
    const runner: Runner = createRunner(sqlane, runnerOptions);
    const mount = runner.mount([reportHandler, daily, defineHandler(untyped, () => {})]);

    expectTypeOf(mount).toEqualTypeOf<Mount>();
    expectTypeOf(mount.unmount()).toBeVoid();
    expectTypeOf(runner.getStatus(buildReport)).toEqualTypeOf<LaneRunStatus>();
    expectTypeOf(runner.getStatus('build_report')).toEqualTypeOf<LaneRunStatus>();
    expectTypeOf(runner.getStatus(daily)).toEqualTypeOf<ScheduleRunStatus>();
    expectTypeOf(runner.getStatus('build_report:daily')).toEqualTypeOf<ScheduleRunStatus>();
    runner.pauseLocally(buildReport);
    runner.resumeLocally('build_report');
    await runner.start();
    expectTypeOf(await runner.drain({ timeout: '1s' })).toEqualTypeOf<{ completed: number; retried: number; failed: number }>();
    await runner.close({ deadline: '5s' });
    // @ts-expect-error a lane definition is not a part: mount its handler
    runner.mount([buildReport]);
    // @ts-expect-error pollInterval is an option of the sqlane
    createRunner(sqlane, { pollInterval: '1s' });

    // A slot by hand: a schedule definition (it holds the payload), the connections of the adapter
    expectTypeOf(await sqlane.schedules.runSlot(daily, { at: new Date(), connection: pool }))
        .toEqualTypeOf<{ id: string; created: boolean }>();
    await sqlane.schedules.runSlot(daily);
    // @ts-expect-error an id is not a definition: runSlot needs the payload
    await sqlane.schedules.runSlot('build_report:daily');
    // @ts-expect-error a slot is a Date
    await sqlane.schedules.runSlot(daily, { at: '2026-01-01T00:00:00Z' });

    expectTypeOf<Page>().toEqualTypeOf<Report>();
}
