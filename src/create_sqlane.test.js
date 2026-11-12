import { describe, expect, test } from 'vitest';
import { ClosedError, ConfigError } from './errors.js';
import { createSqlane } from './create_sqlane.js';
import { defineJob } from './define_job.js';

test('createSqlane needs an adapter', () => {
    expect(() => createSqlane(/** @type {any} */ ({}))).toThrow(ConfigError);
});

/**
 * A PostgreSQL adapter over no database: every statement gives no row, the statements on the schedules are recorded.
 * @param {{ missingTable?: boolean }} [options]
 * @returns {{ adapter: import('./types.js').Adapter<any>, statements: string[] }}
 */
function fakeAdapter({ missingTable = false } = {}) {
    /** @type {string[]} */
    const statements = [];
    /** @type {import('./types.js').Executor} */
    const executor = {
        query: async (sql) => {
            if (!sql.includes('schedules')) {
                return [];
            }

            statements.push(sql);

            if (missingTable) {
                throw Object.assign(new Error('relation "sqlane_schedules" does not exist'), { code: '42P01' });
            }

            return sql.includes('LEFT JOIN') ? [{ id: null, db_now_ms: Date.now() }] : [];
        },
        run: async () => 0,
    };

    return {
        statements,
        adapter: /** @type {import('./types.js').Adapter<any>} */ (/** @type {unknown} */ ({
            dialect: 'postgres',
            queue: executor,
            queueTransaction: (/** @type {(executor: unknown) => Promise<unknown>} */ func) => func(executor),
            withConnection: (/** @type {(executor: unknown) => Promise<unknown>} */ func) => func(executor),
        })),
    };
}

describe('schedule() and start()', () => {
    test('schedule() after start() throws a ConfigError, after close() a ClosedError', async () => {
        const { adapter } = fakeAdapter();
        const sqlane = createSqlane({ adapter });

        await sqlane.start();
        expect(() => sqlane.schedule('tick', { every: '1m' })).toThrow(ConfigError);
        await sqlane.close({ deadline: 0 });
        expect(() => sqlane.schedule('tick', { every: '1m' })).toThrow(ClosedError);
    });

    test('a second schedule with the same id throws a ConfigError', () => {
        const sqlane = createSqlane({ adapter: fakeAdapter().adapter });

        sqlane.schedule('tick', { every: '1m' });
        expect(() => sqlane.schedule('tick', { cron: '* * * * *' })).toThrow(ConfigError);
    });

    test.each([
        ['a payload that is not JSON', { jobs: [] }, () => ({ every: '1m', payload: { at: 1n } })],
        ['a payload above maxPayloadBytes', { maxPayloadBytes: 10 }, () => ({ every: '1m', payload: { text: 'x'.repeat(20) } })],
        ['an unknown name with unknownJobs reject', { unknownJobs: /** @type {const} */ ('reject') }, () => ({ every: '1m' })],
    ])('start() throws a ConfigError for %s, before any statement', async (_, options, scheduleOptions) => {
        const { adapter, statements } = fakeAdapter();
        const sqlane = createSqlane({ adapter, ...options });

        sqlane.schedule('tick', /** @type {any} */ (scheduleOptions()));

        await expect(sqlane.start()).rejects.toThrow(ConfigError);
        expect(statements).toStrictEqual([]);
        await sqlane.close({ deadline: 0 });
    });

    test('start() checks the mutex keys of the definition', async () => {
        const job = defineJob({ name: 'keyed', timeout: '1m', mutexKeys: () => [' bad'] });
        const sqlane = createSqlane({ adapter: fakeAdapter().adapter });

        sqlane.schedule(job, { every: '1m' });

        await expect(sqlane.start()).rejects.toThrow(/schedule\("keyed"\)/);
    });

    test('a missing table: start() throws a ConfigError that says to run migrate(), and can be called again', async () => {
        const { adapter, statements } = fakeAdapter({ missingTable: true });
        const sqlane = createSqlane({ adapter });

        sqlane.schedule('tick', { every: '1m' });

        await expect(sqlane.start()).rejects.toThrow('start(): the table sqlane_schedules is missing: run migrate()');
        await expect(sqlane.start()).rejects.toThrow(ConfigError);
        expect(statements).toHaveLength(2);
        await sqlane.close({ deadline: 0 });
    });

    test('start() on a closed instance throws a ClosedError first', async () => {
        const sqlane = createSqlane({ adapter: fakeAdapter().adapter, unknownJobs: 'reject' });

        sqlane.schedule('tick', { every: '1m' });
        await sqlane.close({ deadline: 0 });

        await expect(sqlane.start()).rejects.toThrow(ClosedError);
    });

    test('concurrent start() calls register once; a second start() does nothing', async () => {
        const { adapter, statements } = fakeAdapter();
        const sqlane = createSqlane({ adapter });

        sqlane.schedule('tick', { every: '1m' });
        await Promise.all([sqlane.start(), sqlane.start()]);
        await sqlane.start();

        // The insert and the read of the registration
        expect(statements).toHaveLength(2);
        await sqlane.close({ deadline: 0 });
    });

    test('without schedules: no statement on the schedules', async () => {
        const { adapter, statements } = fakeAdapter();
        const sqlane = createSqlane({ adapter });

        await sqlane.start();
        await sqlane.close({ deadline: 0 });

        expect(statements).toStrictEqual([]);
    });

    test('close() during start(): no schedule runs', async () => {
        const { adapter, statements } = fakeAdapter();
        const sqlane = createSqlane({ adapter });

        sqlane.schedule('tick', { every: '1s' });

        const starting = sqlane.start();

        await sqlane.close({ deadline: 0 });
        await starting;
        await new Promise((resolve) => {
            setTimeout(resolve, 1500);
        });

        expect(statements.filter(sql => sql.includes('FOR UPDATE'))).toStrictEqual([]);
    });

    test('getSchedules() before start(): the registered schedules, a missing table is an empty one', async () => {
        const sqlane = createSqlane({ adapter: fakeAdapter({ missingTable: true }).adapter });

        await expect(sqlane.getSchedules()).resolves.toStrictEqual([]);
        sqlane.schedule('tick', { every: '1m', key: 'a' });
        await expect(sqlane.getSchedules()).resolves.toMatchObject([
            { id: 'tick:a', name: 'tick', spec: 'every 60000', registered: true, lastSlotAt: null, lastJobId: null },
        ]);
    });
});

/**
 * Holds the insert of the registration until `release()`.
 * @param {import('./types.js').Adapter<any>} adapter
 * @returns {{ release: () => void }}
 */
function holdRegistration(adapter) {
    const held = Promise.withResolvers();
    const { query } = adapter.queue;

    adapter.queue.query = async (sql, params) => {
        await (sql.includes('INSERT INTO sqlane_schedules') ? held.promise : null);

        return query(sql, params);
    };

    return { release: () => held.resolve(undefined) };
}

describe('close()', () => {
    test('closes at once: handle(), schedule() and start() throw a ClosedError right after it', async () => {
        const sqlane = createSqlane({ adapter: fakeAdapter().adapter });
        const closing = sqlane.close({ deadline: 0 });

        expect(() => sqlane.handle('tick', () => {})).toThrow(ClosedError);
        expect(() => sqlane.schedule('tick', { every: '1m' })).toThrow(ClosedError);
        await expect(sqlane.start()).rejects.toThrow(ClosedError);
        await closing;
    });

    test('a second call returns the same promise', async () => {
        const sqlane = createSqlane({ adapter: fakeAdapter().adapter });

        expect(sqlane.close()).toBe(sqlane.close());
        await sqlane.close();
    });

    test('waits for the registration of a pending start(), and runs nothing after it', async () => {
        const { adapter, statements } = fakeAdapter();
        const { release } = holdRegistration(adapter);

        const sqlane = createSqlane({ adapter });

        sqlane.schedule('tick', { every: '1s' });

        const starting = sqlane.start();
        let closed = false;
        const closing = (async () => {
            await sqlane.close({ deadline: 0 });
            closed = true;
        })();

        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        expect(closed).toBe(false);
        release();
        await Promise.all([starting, closing]);
        await new Promise((resolve) => {
            setTimeout(resolve, 1500);
        });

        expect(statements.filter(sql => sql.includes('FOR UPDATE'))).toStrictEqual([]);
    });
});
