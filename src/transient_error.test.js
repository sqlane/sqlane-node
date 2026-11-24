import { expect, test } from 'vitest';
import {
    isConnectionError,
    isLockTimeoutError,
    isMissingColumnError,
    isMissingTableError,
    isQuickRetryError,
    isTransientDbError,
} from './transient_error.js';

test.each([
    ['a MySQL deadlock', { code: 'ER_LOCK_DEADLOCK', errno: 1213 }],
    ['a MySQL lock wait timeout', { errno: 1205 }],
    ['a MariaDB record changed since the read view', { code: 'ER_CHECKREAD', errno: 1020 }],
    ['a MariaDB record changed since the read view, by its errno', { errno: 1020 }],
    ['a MariaDB record changed since the read view, through Prisma', {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '1020' } } },
    }],
    ['a PostgreSQL serialization failure', { code: '40001' }],
    ['a PostgreSQL deadlock', { code: '40P01' }],
    ['a deadlock as the cause', new Error('claim failed', { cause: { code: '40P01' } })],
    // As Prisma 7 reported a MySQL deadlock in CI
    ['a MySQL deadlock through Prisma', {
        code: 'P2010',
        meta: {
            driverAdapterError: Object.assign(new Error('TransactionWriteConflict'), {
                cause: { originalCode: '1213', kind: 'TransactionWriteConflict' },
            }),
        },
    }],
    ['a PostgreSQL serialization failure through Prisma', {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '40001' } } },
    }],
    ['a write conflict of Prisma', { code: 'P2034' }],
    ['a MySQL deadlock wrapped by Sequelize', { name: 'SequelizeDatabaseError', original: { errno: 1213 } }],
    ['a PostgreSQL deadlock wrapped by Sequelize', { name: 'SequelizeDatabaseError', parent: { code: '40P01' } }],
    ['a deadlock wrapped by TypeORM', { name: 'QueryFailedError', driverError: { code: 'ER_LOCK_DEADLOCK' } }],
    ['a deadlock of a Prisma raw query', { code: 'P2010', meta: { code: '40P01' } }],
])('%s is transient', (_, error) => {
    expect(isTransientDbError(error)).toBe(true);
});

test.each([
    ['a duplicate key', { code: 'ER_DUP_ENTRY', errno: 1062 }],
    ['a syntax error', { code: '42601' }],
    ['another error through Prisma', { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '1062' } } } }],
    ['a plain error', new Error('boom')],
    ['undefined', undefined],
])('%s is not transient', (_, error) => {
    expect(isTransientDbError(error)).toBe(false);
});

test.each([
    ['pg', { code: '42P01' }],
    ['mysql2', { code: 'ER_NO_SUCH_TABLE', errno: 1146 }],
    ['mariadb', { code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlState: '42S02' }],
    ['Prisma', { code: 'P2021' }],
    ['Prisma, a raw query', { code: 'P2010', meta: { code: '42P01' } }],
    ['Prisma, a raw query on MySQL', { code: 'P2010', meta: { code: '1146' } }],
    ['Prisma, its driver adapter', { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '42P01' } } } }],
    ['Sequelize', { name: 'SequelizeDatabaseError', original: { code: '42P01' }, parent: { code: '42P01' } }],
    ['TypeORM', { name: 'QueryFailedError', driverError: { errno: 1146 } }],
    ['knex: the driver error itself', Object.assign(new Error('relation does not exist'), { code: '42P01' })],
    ['a cause', new Error('start failed', { cause: { code: '42P01' } })],
])('a missing table through %s', (_, error) => {
    expect(isMissingTableError(error)).toBe(true);
    expect(isConnectionError(error)).toBe(false);
});

test.each([
    ['pg', { code: '42703' }],
    ['mysql2', { code: 'ER_BAD_FIELD_ERROR', errno: 1054 }],
    ['mariadb', { code: 'ER_BAD_FIELD_ERROR', errno: 1054, sqlState: '42S22' }],
    ['Prisma', { code: 'P2022' }],
    ['Prisma, a raw query on MySQL', { code: 'P2010', meta: { code: '1054' } }],
    ['Prisma, its driver adapter', { code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'ColumnNotFound' } } } }],
    ['Sequelize', { name: 'SequelizeDatabaseError', original: { code: '42703' }, parent: { code: '42703' } }],
    ['TypeORM', { name: 'QueryFailedError', driverError: { errno: 1054 } }],
    ['a cause', new Error('list failed', { cause: { code: '42703' } })],
])('a missing column through %s', (_, error) => {
    expect(isMissingColumnError(error)).toBe(true);
    expect(isMissingTableError(error)).toBe(false);
    expect(isConnectionError(error)).toBe(false);
});

test.each([
    ['a missing table', { code: '42P01' }],
    ['a duplicate key', { code: 'ER_DUP_ENTRY', errno: 1062 }],
    ['a plain error', new Error('boom')],
])('%s is not a missing column', (_, error) => {
    expect(isMissingColumnError(error)).toBe(false);
});

test.each([
    ['a refused connection', { code: 'ECONNREFUSED' }],
    ['a reset connection', { code: 'ECONNRESET' }],
    ['a lost MySQL connection', { code: 'PROTOCOL_CONNECTION_LOST' }],
    ['too many MySQL connections', { code: 'ER_CON_COUNT_ERROR', errno: 1040 }],
    ['a PostgreSQL connection failure', { code: '08006' }],
    ['a PostgreSQL shutdown', { code: '57P01' }],
    ['a knex pool timeout', { name: 'KnexTimeoutError' }],
    ['a generic-pool timeout', { name: 'TimeoutError' }],
    ['a Sequelize pool timeout', { name: 'ConnectionAcquireTimeoutError', original: {} }],
    ['Prisma: the database is not reachable', { code: 'P1001' }],
    ['Prisma: the pool timed out', { code: 'P2024' }],
    ['TypeORM', { driverError: { code: 'ECONNREFUSED' } }],
    ['a cause', new Error('fire failed', { cause: { code: 'ECONNRESET' } })],
])('%s is a connection error', (_, error) => {
    expect(isConnectionError(error)).toBe(true);
    expect(isMissingTableError(error)).toBe(false);
});

test.each([
    ['a duplicate key', { code: 'ER_DUP_ENTRY', errno: 1062 }],
    ['a plain error', new Error('boom')],
    ['a cycle of causes', (() => {
        /** @type {{ cause?: unknown }} */
        const error = {};

        error.cause = error;

        return error;
    })()],
])('%s is neither a missing table nor a connection error', (_, error) => {
    expect(isMissingTableError(error)).toBe(false);
    expect(isConnectionError(error)).toBe(false);
});

test.each([
    ['a MySQL deadlock', { code: 'ER_LOCK_DEADLOCK', errno: 1213 }, true],
    ['a MariaDB record changed since the read view', { code: 'ER_CHECKREAD', errno: 1020 }, true],
    ['a PostgreSQL serialization failure', { code: '40001' }, true],
    ['a PostgreSQL deadlock', { code: '40P01' }, true],
    ['a MySQL lock wait timeout', { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 }, false],
    ['a lock wait timeout by its errno, wrapped by Sequelize', { original: { errno: 1205 } }, false],
    ['a lock wait timeout through Prisma', { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '1205' } } } }, false],
    ['a duplicate key', { code: 'ER_DUP_ENTRY', errno: 1062 }, false],
])('%s: a quick retry: %s', (_, error, expected) => {
    expect(isQuickRetryError(error)).toBe(expected);
});

test.each([
    ['a PostgreSQL lock_timeout', { code: '55P03' }, true],
    ['a MySQL lock wait timeout', { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 }, true],
    ['a MariaDB lock wait timeout of the mariadb driver', { errno: 1205, sqlState: 'HY000' }, true],
    ['a PostgreSQL lock_timeout through Prisma', { code: 'P2010', meta: { code: '55P03' } }, true],
    ['a MySQL lock wait timeout through Prisma', {
        code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '1205' } } },
    }, true],
    ['a lock wait timeout wrapped by TypeORM', { driverError: { code: '55P03' } }, true],
    ['a PostgreSQL deadlock', { code: '40P01' }, false],
    ['a MySQL deadlock', { code: 'ER_LOCK_DEADLOCK', errno: 1213 }, false],
    ['a plain error', new Error('boom'), false],
])('%s: a lock timeout: %s', (_, error, expected) => {
    expect(isLockTimeoutError(error)).toBe(expected);
});
