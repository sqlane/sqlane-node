import { expect, test } from 'vitest';
import { isTransientDbError } from './transient_error.js';

test.each([
    ['a MySQL deadlock', { code: 'ER_LOCK_DEADLOCK', errno: 1213 }],
    ['a MySQL lock wait timeout', { errno: 1205 }],
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
